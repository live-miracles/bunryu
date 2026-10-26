import { execFile } from 'child_process';
import type { ChildProcess, ExecFileException } from 'child_process';
import { type SrsStreamVideo, type SrsStreamAudio, type AudioTrackInfo } from '../utils/srs.js';
import { readAppConfig } from '../utils/appConfig.js';
import { ffmpegEnv } from '../utils/ffmpeg.js';

const FFPROBE_CMD = readAppConfig().ffprobePath;
const FFPROBE_TIMEOUT_MS = 15000;

// Keyframe interval check: ffprobe reads this much of the input's video packets
// (a live input is read in real time, so the check takes about this long).
export const KEYFRAME_WINDOW_SEC = 12;
const KEYFRAME_TIMEOUT_MS = 25000;
// YouTube accepts a keyframe at least every 4 s (and recommends 2 s); the margin
// is for frame-rate rounding. A window shorter than this (the stream ended while
// reading) proves nothing.
export const KEYFRAME_MAX_GAP_SEC = 4.25;
const KEYFRAME_MIN_SPAN_SEC = 10;

export interface ProbeResult {
    video: SrsStreamVideo | null;
    audio: SrsStreamAudio | null;
    audioTracks: AudioTrackInfo[];
}

// Why a probe produced no result, for diagnostics.
export interface ProbeFailure {
    reason: 'timeout' | 'exit' | 'parse';
    elapsedMs: number;
    exitCode: number | string | null;
    signal: string | null;
    stderrTail: string;
}

const STDERR_TAIL_CHARS = 1000;

export function isProbeUsable(result: ProbeResult | null): boolean {
    const video = result?.video;
    return !!video?.codec && video.width > 0 && video.height > 0;
}

function parseMpegtsPid(id: unknown): number | null {
    if (typeof id !== 'string') return null;
    const pid = Number.parseInt(id, 16);
    return Number.isFinite(pid) ? pid : null;
}

function parseFrameRate(str: unknown): number | null {
    if (!str) return null;
    const parts = String(str).split('/');
    if (parts.length !== 2) return null;
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (!den || !Number.isFinite(num) || !Number.isFinite(den)) return null;
    const fps = num / den;
    return Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : null;
}

export function probeError(result: ProbeResult | null, checkedAt: number): string {
    const d = new Date(checkedAt);
    const prefix = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    if (!result) return `${prefix} ffprobe did not detect a readable media stream`;
    const video = result.video;
    if (!video) return `${prefix} ffprobe did not detect a video stream`;
    if (!video.codec) return `${prefix} ffprobe detected video without codec metadata`;
    if (video.width <= 0 || video.height <= 0)
        return `${prefix} ffprobe detected video without dimensions`;
    return `${prefix} ffprobe media validation failed`;
}

export function runFfprobe(
    url: string,
    onChild?: (child: ChildProcess) => void,
    onFailure?: (failure: ProbeFailure) => void,
): Promise<ProbeResult | null> {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const fail = (
            reason: ProbeFailure['reason'],
            err: ExecFileException | null,
            stderr: string,
        ): void => {
            onFailure?.({
                reason,
                elapsedMs: Date.now() - startedAt,
                exitCode: err?.code ?? null,
                signal: err?.signal ?? null,
                stderrTail: stderr.trim().slice(-STDERR_TAIL_CHARS),
            });
            resolve(null);
        };
        const child = execFile(
            FFPROBE_CMD,
            ['-v', 'error', '-print_format', 'json', '-show_streams', url],
            { timeout: FFPROBE_TIMEOUT_MS, killSignal: 'SIGKILL', env: ffmpegEnv() },
            (err, stdout, stderr) => {
                if (err) {
                    fail(err.killed ? 'timeout' : 'exit', err, String(stderr ?? ''));
                    return;
                }
                try {
                    const data = JSON.parse(stdout) as { streams?: Record<string, unknown>[] };
                    const streams = data.streams || [];
                    const vs = streams.find((s) => s.codec_type === 'video') ?? null;
                    const audioStreams = streams.filter((s) => s.codec_type === 'audio');
                    const as_ = audioStreams[0] ?? null;
                    const audioTracks: AudioTrackInfo[] = audioStreams.map((s, idx) => {
                        const tags = (s.tags ?? {}) as Record<string, string>;
                        return {
                            index: idx,
                            codec: (s.codec_name as string) || '',
                            sampleRate: s.sample_rate ? Number(s.sample_rate) : 0,
                            channels: (s.channels as number) || 0,
                            profile: (s.profile as string) || '',
                            language: tags.language ?? null,
                            title: tags.title ?? null,
                            pid: parseMpegtsPid(s.id),
                        };
                    });
                    resolve({
                        video: vs
                            ? {
                                  codec: (vs.codec_name as string) || '',
                                  width: (vs.width as number) || 0,
                                  height: (vs.height as number) || 0,
                                  fps: parseFrameRate(vs.r_frame_rate),
                                  profile: (vs.profile as string) || '',
                                  level: vs.level != null ? String(Number(vs.level) / 10) : '',
                                  fieldOrder: (vs.field_order as string) || null,
                              }
                            : null,
                        audio: as_
                            ? {
                                  codec: (as_.codec_name as string) || '',
                                  sample_rate: as_.sample_rate ? Number(as_.sample_rate) : 0,
                                  channel: (as_.channels as number) || 0,
                                  profile: (as_.profile as string) || '',
                              }
                            : null,
                        audioTracks,
                    });
                } catch {
                    fail('parse', null, String(stderr ?? ''));
                }
            },
        );
        onChild?.(child);
    });
}

// What the keyframe check measured over its window.
export interface KeyframeStats {
    windowSec: number;
    // Time covered by the packets read.
    spanSec: number;
    keyframes: number;
    // Null with fewer than two keyframes.
    meanGapSec: number | null;
    // The longest gap between keyframes, counting the open gap after the last one
    // (a lower bound: with a single keyframe or none it is the time with no next
    // keyframe).
    maxGapSec: number;
}

// Parses `ffprobe -show_entries packet=pts_time,dts_time,flags -of csv=p=0`
// lines such as "0.080000,0.000000,K__". The decode time is used (it never goes
// backwards with B-frames), the presentation time when that is N/A.
export function parseKeyframePackets(csv: string): KeyframeStats {
    let first = Infinity;
    let last = -Infinity;
    const keys: number[] = [];
    for (const line of csv.split('\n')) {
        const [pts, dts, flags] = line.trim().split(',');
        if (flags === undefined) continue;
        const t = Number.isFinite(Number(dts)) && dts !== '' ? Number(dts) : Number(pts);
        if (pts === '' || !Number.isFinite(t)) continue;
        if (t < first) first = t;
        if (t > last) last = t;
        if (flags.includes('K')) keys.push(t);
    }
    const spanSec = last >= first ? last - first : 0;
    let maxGapSec = 0;
    for (let i = 1; i < keys.length; i++) maxGapSec = Math.max(maxGapSec, keys[i] - keys[i - 1]);
    const lastKey = keys.length > 0 ? keys[keys.length - 1] : first;
    if (last >= lastKey) maxGapSec = Math.max(maxGapSec, last - lastKey);
    return {
        windowSec: KEYFRAME_WINDOW_SEC,
        spanSec,
        keyframes: keys.length,
        meanGapSec: keys.length > 1 ? (keys[keys.length - 1] - keys[0]) / (keys.length - 1) : null,
        maxGapSec,
    };
}

export function keyframeIntervalTooLong(stats: KeyframeStats): boolean {
    return stats.spanSec >= KEYFRAME_MIN_SPAN_SEC && stats.maxGapSec > KEYFRAME_MAX_GAP_SEC;
}

// One sentence for the alert and the pipeline log.
export function keyframeSummary(stats: KeyframeStats): string {
    const window = `${stats.windowSec} s`;
    if (stats.keyframes < 2) {
        return `${stats.keyframes === 0 ? 'no keyframe' : 'only one keyframe'} in ${window} of video (platforms need one at least every 4 s, 2 s is recommended).`;
    }
    return `the longest gap in ${window} of video is ${stats.maxGapSec.toFixed(1)} s (platforms need at most 4 s, 2 s is recommended).`;
}

// Reads the input's video packets for KEYFRAME_WINDOW_SEC and measures the gaps
// between keyframes. Demuxing only, no decoding.
export function runKeyframeProbe(
    url: string,
    onChild?: (child: ChildProcess) => void,
    onFailure?: (failure: ProbeFailure) => void,
): Promise<KeyframeStats | null> {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const fail = (
            reason: ProbeFailure['reason'],
            err: ExecFileException | null,
            stderr: string,
        ): void => {
            onFailure?.({
                reason,
                elapsedMs: Date.now() - startedAt,
                exitCode: err?.code ?? null,
                signal: err?.signal ?? null,
                stderrTail: stderr.trim().slice(-STDERR_TAIL_CHARS),
            });
            resolve(null);
        };
        const child = execFile(
            FFPROBE_CMD,
            [
                '-v',
                'error',
                '-select_streams',
                'v:0',
                '-show_entries',
                'packet=pts_time,dts_time,flags',
                '-of',
                'csv=p=0',
                '-read_intervals',
                `%+${KEYFRAME_WINDOW_SEC}`,
                url,
            ],
            { timeout: KEYFRAME_TIMEOUT_MS, killSignal: 'SIGKILL', env: ffmpegEnv() },
            (err, stdout, stderr) => {
                if (err) {
                    fail(err.killed ? 'timeout' : 'exit', err, String(stderr ?? ''));
                    return;
                }
                const stats = parseKeyframePackets(String(stdout));
                // No packet at all: nothing to measure.
                if (stats.spanSec <= 0 && stats.keyframes === 0) {
                    fail('parse', null, String(stderr ?? ''));
                    return;
                }
                resolve(stats);
            },
        );
        onChild?.(child);
    });
}
