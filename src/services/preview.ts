import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { readAppConfig } from '../utils/appConfig.js';
import { INPUT_TIMEOUT_US } from '../utils/ffmpeg.js';
import type { Db } from '../types.js';
import type { InputState } from './inputState.js';
import { MAX_AUDIO_TRACKS } from '../utils/inputLimits.js';

const FFMPEG_CMD = readAppConfig().ffmpegPath;
const STDERR_TAIL_BYTES = 2000;
const STOP_WAIT_MS = 200;
// A preview transcodes continuously (~half a core), and stopping it relies on
// the browser calling /preview/stop — which does not always happen when the
// operator closes the tab (the dashboard also sends a beacon on pagehide, but
// a crash or lost network skips it). A preview counts as watched while either
// the dashboard's keepalive arrives or anyone fetches its HLS playlist/segments
// (touched from the /hls route; a live player refreshes the playlist every
// ~2s). Previews with no such signal within the TTL are reaped. 20s tolerates
// a network hiccup; the cost of a wrongly reaped preview is a ~10s restart.
// A tab hidden for minutes gets its timers throttled, so it is reaped too —
// nobody is watching, and the dashboard tears the player down on active=false.
const KEEPALIVE_TTL_MS = 20_000;
const REAP_INTERVAL_MS = 5_000;

function resolveBaseDir(): string {
    return path.join(path.dirname(readAppConfig().databasePath), 'hls');
}

async function waitForPlaylist(m3u8Path: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const content = fs.readFileSync(m3u8Path, 'utf8');
            if (content.includes('.ts')) return;
        } catch {
            /* not yet */
        }
        await new Promise((r) => setTimeout(r, STOP_WAIT_MS));
    }
    throw new Error('Preview timed out — no active input stream on this pipeline');
}

export interface PreviewService {
    start(pipelineId: number, audioTrackCount?: number): Promise<{ hlsUrl: string }>;
    keepalive(pipelineId: number): boolean;
    stop(pipelineId: number): void;
    shutdown(): void;
    baseDir: string;
}

export interface PreviewServiceOptions {
    ttlMs?: number;
    reapIntervalMs?: number;
}

interface PreviewEntry {
    proc: ChildProcess;
    // The URL the browser was given for this preview. Returned as-is for a
    // second start on the same pipeline — recomputing it from the new request's
    // track count could name a playlist the running ffmpeg never writes.
    hlsUrl: string;
    lastKeepaliveMs: number;
}

export function createPreviewService(
    db: Db,
    inputState: InputState,
    options: PreviewServiceOptions = {},
): PreviewService {
    const baseDir = resolveBaseDir();
    const previews = new Map<number, PreviewEntry>();
    const ttlMs = options.ttlMs ?? KEEPALIVE_TTL_MS;
    const reapIntervalMs = options.reapIntervalMs ?? REAP_INTERVAL_MS;

    // Reap previews whose dashboard client went away without stopping them
    // (closed tab, crashed browser) — otherwise the transcode runs forever.
    const reapTimer = setInterval(() => {
        const now = Date.now();
        for (const [pipelineId, entry] of previews) {
            if (now - entry.lastKeepaliveMs > ttlMs) {
                console.log(`[preview] ${pipelineId} reaping: no keepalive for ${ttlMs}ms`);
                doStop(pipelineId);
            }
        }
    }, reapIntervalMs);
    reapTimer.unref?.();

    function keepalive(pipelineId: number): boolean {
        const entry = previews.get(pipelineId);
        if (!entry) return false;
        entry.lastKeepaliveMs = Date.now();
        return true;
    }

    function doStop(pipelineId: number): void {
        const entry = previews.get(pipelineId);
        if (!entry) return;
        previews.delete(pipelineId);
        entry.proc.kill('SIGTERM');
        console.log(`[preview] ${pipelineId} stopping`);
    }

    async function start(pipelineId: number, audioTrackCount = 1): Promise<{ hlsUrl: string }> {
        const pipeline = db.getPipeline(pipelineId);
        if (!pipeline) throw new Error('Pipeline not found');

        // Pull the input back over its own protocol. Default to RTMP until known.
        const inputProtocol = inputState.getProtocol(pipelineId) ?? 'rtmp';
        const inputUrl = inputState.pullUrl(pipelineId, pipeline.streamKey);

        // A preview is already running: refresh its keepalive and hand back the
        // URL it was started with (its playlist layout may differ from what this
        // request's track count would produce).
        const existing = previews.get(pipelineId);
        if (existing) {
            existing.lastKeepaliveMs = Date.now();
            return { hlsUrl: existing.hlsUrl };
        }

        // Multiple audio tracks (only possible on an SRT input) become switchable
        // HLS renditions via a master playlist; otherwise a single media playlist.
        // The API already bounds this; clamp again so no caller can make this
        // allocate an argv/array proportional to an arbitrary number.
        audioTrackCount = Math.min(MAX_AUDIO_TRACKS, Math.max(1, Math.floor(audioTrackCount) || 1));
        const multiTrack = audioTrackCount > 1;
        const playlistName = multiTrack ? 'master.m3u8' : 'index.m3u8';
        const hlsUrl = `/hls/${pipelineId}/${playlistName}`;

        const outDir = path.join(baseDir, String(pipelineId));
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.mkdirSync(outDir, { recursive: true });

        // Keep dashboard preview intentionally lightweight for small cloud VMs.
        // Always transcode to a low-res HLS rendition, independent of the ingest
        // protocol; production outputs still use their own output settings.
        const videoArgs = [
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-tune',
            'zerolatency',
            '-vf',
            'scale=w=854:h=480:force_original_aspect_ratio=decrease,scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2,fps=25',
            '-pix_fmt',
            'yuv420p',
            '-crf',
            '30',
            '-g',
            '50',
            '-keyint_min',
            '50',
            '-sc_threshold',
            '0',
            '-force_key_frames',
            'expr:gte(t,n_forced*2)',
        ];

        // SRT/MPEG-TS sources deliver audio with jittery, occasionally discontinuous
        // timestamps (PCR rounding + SRT packet-loss gaps). Re-encoding those 1:1
        // yields gaps and crackle ("breaking" audio). aresample fills gaps with
        // silence and soft-compensates drift so the AAC output stays continuous.
        // async=1000 lets it correct up to 1000 samples/sec; async=1 is far too
        // weak to absorb the jitter, so audio still breaks with it. Clean RTMP
        // inputs have well-behaved timestamps, so it's a near no-op for them.
        const audioArgs = [
            '-af',
            'aresample=async=1000:first_pts=0',
            '-c:a',
            'aac',
            '-ac',
            '2',
            '-ar',
            '48000',
        ];
        const hlsCommon = [
            '-f',
            'hls',
            '-hls_time',
            '2',
            '-hls_list_size',
            // Keep a larger live window on deployed servers so brief fetch/cache
            // hiccups do not push the player out of range. Tradeoff: slightly
            // more live delay and a few more short-lived segment files on disk.
            '20',
            '-hls_flags',
            'delete_segments+independent_segments',
        ];

        // The playlist whose appearance means the stream is live, and the URL the
        // browser loads. For multi-track we emit a master playlist that exposes each
        // audio track as a switchable EXT-X-MEDIA rendition (hls.js will not surface
        // audio tracks that are merely muxed into a single media playlist), so the
        // browser switches tracks natively. Single-track stays a plain media playlist.
        let outputArgs: string[];
        let readyPlaylist: string;
        if (multiTrack) {
            const audioMaps = Array.from({ length: audioTrackCount }, (_, i) => [
                '-map',
                `0:a:${i}`,
            ]).flat();
            const varStreamMap = [
                'v:0,agroup:aud',
                ...Array.from(
                    { length: audioTrackCount },
                    (_, i) =>
                        `a:${i},agroup:aud,name:track${i + 1}${i === 0 ? ',default:yes' : ''}`,
                ),
            ].join(' ');
            outputArgs = [
                '-map',
                '0:v:0?',
                ...audioMaps,
                ...videoArgs,
                ...audioArgs,
                ...hlsCommon,
                '-hls_segment_filename',
                path.join(outDir, 'v%v_%d.ts'),
                '-master_pl_name',
                'master.m3u8',
                '-var_stream_map',
                varStreamMap,
                path.join(outDir, 'v%v.m3u8'),
            ];
            readyPlaylist = path.join(outDir, 'v0.m3u8');
        } else {
            outputArgs = [
                '-map',
                '0:v:0?',
                '-map',
                '0:a:0?',
                ...videoArgs,
                ...audioArgs,
                ...hlsCommon,
                path.join(outDir, 'index.m3u8'),
            ];
            readyPlaylist = path.join(outDir, 'index.m3u8');
        }

        // -rw_timeout mirrors the output pull: SRS holds publisher-less pulls
        // open indefinitely, so a preview whose input never returns would sit
        // blocked on read forever instead of exiting.
        const proc = spawn(
            FFMPEG_CMD,
            [
                '-fflags',
                '+genpts',
                '-rw_timeout',
                String(INPUT_TIMEOUT_US),
                '-i',
                inputUrl,
                ...outputArgs,
            ],
            {
                stdio: ['ignore', 'ignore', 'pipe'],
                env: process.env,
            },
        );

        previews.set(pipelineId, { proc, hlsUrl, lastKeepaliveMs: Date.now() });
        console.log(
            `[preview] ${pipelineId} started pid=${proc.pid} ${inputProtocol} multiTrack=${multiTrack} tracks=${audioTrackCount}`,
        );

        let stderrTail = '';
        proc.stderr?.on('data', (d: Buffer) => {
            stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_BYTES);
        });

        proc.on('exit', (code, signal) => {
            if (previews.get(pipelineId)?.proc === proc) previews.delete(pipelineId);
            // Clean up this pipeline's HLS dir unless a newer preview now owns it
            // (covers both a user stop, which clears the map entry first, and a crash).
            if (!previews.has(pipelineId)) {
                fs.rm(outDir, { recursive: true, force: true }, () => {});
            }
            if (code && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
                console.warn(
                    `[preview] ${pipelineId} ffmpeg exited code=${code}:\n${stderrTail.trim()}`,
                );
            } else {
                console.log(`[preview] ${pipelineId} exited`);
            }
        });

        try {
            await waitForPlaylist(readyPlaylist, 10_000);
        } catch (err) {
            doStop(pipelineId);
            throw err;
        }

        return { hlsUrl };
    }

    function shutdown(): void {
        clearInterval(reapTimer);
        for (const entry of previews.values()) {
            try {
                entry.proc.kill('SIGKILL');
            } catch {
                /* already gone */
            }
        }
        previews.clear();
    }

    return { start, keepalive, stop: doStop, shutdown, baseDir };
}
