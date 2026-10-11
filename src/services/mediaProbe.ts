import { execFile } from 'child_process';
import type { ChildProcess, ExecFileException } from 'child_process';
import { type SrsStreamVideo, type SrsStreamAudio, type AudioTrackInfo } from '../utils/srs.js';
import { readAppConfig } from '../utils/appConfig.js';

const FFPROBE_CMD = readAppConfig().ffprobePath;
const FFPROBE_TIMEOUT_MS = 15000;

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
            { timeout: FFPROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
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
