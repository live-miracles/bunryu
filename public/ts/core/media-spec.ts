import type { AudioInfo, AudioTrackInfo, VideoInfo } from '../types.js';
import { escapeHtml } from './utils.js';

// One-line media descriptions shared by the Overview's "Stream Specification"
// column and the pipeline panel's input stats, so both always read the same.

export function fmtHz(hz: number | null | undefined): string {
    if (!hz) return '—';
    const k = hz / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}kHz`;
}

// Compact scan+fps shorthand, e.g. "p30", "i60tff" (top-field-first), "i25bff" (bottom-field-first).
export function fmtScanFps(
    fieldOrder: string | null | undefined,
    fps: number | null | undefined,
): string {
    const fpsNum = fps != null ? Math.round(fps) : null;
    if (fieldOrder === 'progressive') return fpsNum != null ? `p${fpsNum}` : 'p';
    if (fieldOrder === 'tt' || fieldOrder === 'tb' || fieldOrder === 'bb' || fieldOrder === 'bt') {
        const field = fieldOrder === 'tt' || fieldOrder === 'tb' ? 'tff' : 'bff';
        return fpsNum != null ? `i${fpsNum}${field}` : `i${field}`;
    }
    return fpsNum != null ? `${fpsNum}fps` : '';
}

// e.g. "h264 1920x1080p50 High L4.2". Null when the size is not known yet.
export function videoSpec(
    video: Pick<
        VideoInfo,
        'codec' | 'width' | 'height' | 'fps' | 'fieldOrder' | 'profile' | 'level'
    > | null,
): string | null {
    if (!video?.width || !video.height) return null;
    const scanFps = fmtScanFps(video.fieldOrder, video.fps);
    const res = scanFps
        ? /^\d/.test(scanFps)
            ? `${video.width}x${video.height} ${scanFps}`
            : `${video.width}x${video.height}${scanFps}`
        : `${video.width}x${video.height}`;
    return [video.codec || '—', res, video.profile || null, video.level ? `L${video.level}` : null]
        .filter(Boolean)
        .join(' ');
}

// e.g. "aac LC 2ch 48kHz". `labelHtml` must already be escaped.
export function audioSpec(
    codec: string | null | undefined,
    profile: string | null | undefined,
    channels: number | null | undefined,
    sampleRate: number | null | undefined,
    labelHtml?: string,
): string {
    const codecLabel = [codec || '—', codec ? profile || null : null].filter(Boolean).join(' ');
    const sr = sampleRate ? fmtHz(sampleRate) : null;
    return `${codecLabel} ${channels ? `${channels}ch` : '—'}${sr ? ` ${sr}` : ''}${labelHtml ? ` <span class="opacity-40">${labelHtml}</span>` : ''}`;
}

// One line per audio track, "Track N: …" ("Track N (PID p): …" when the
// input is MPEG-TS, reports one and carries several tracks, since the PID is
// what tells them apart), falling back to SRS's single-audio
// metadata when ffprobe reported no tracks. Returns HTML.
export function audioSpecLines(
    audioTracks: AudioTrackInfo[] | null,
    fallbackAudio: Pick<AudioInfo, 'codec' | 'channel' | 'sample_rate' | 'profile'> | null,
): string[] {
    if (audioTracks && audioTracks.length > 0) {
        return audioTracks.map((t, i) => {
            const label = escapeHtml([t.language, t.title].filter(Boolean).join(' '));
            const pid = audioTracks.length > 1 && t.pid != null ? ` (PID ${t.pid})` : '';
            return `Track ${i + 1}${pid}: ${audioSpec(t.codec, t.profile, t.channels, t.sampleRate, label || undefined)}`;
        });
    }
    if (fallbackAudio) {
        return [
            `Track 1: ${audioSpec(fallbackAudio.codec, fallbackAudio.profile, fallbackAudio.channel, fallbackAudio.sample_rate)}`,
        ];
    }
    return [];
}
