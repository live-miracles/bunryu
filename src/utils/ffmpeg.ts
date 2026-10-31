import { MAX_AUDIO_TRACKS, isCleanUrlText } from './inputLimits.js';

interface VideoEncodingPreset {
    args: string[];
}

export const ENCODINGS: Record<string, VideoEncodingPreset> = {
    copy: {
        args: ['-c:v', 'copy'],
    },
    '720p': {
        args: ['-vf', 'scale=1280:720', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k'],
    },
    '1080p': {
        args: ['-vf', 'scale=1920:1080', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '5000k'],
    },
    vertical_rotate: {
        args: [
            '-vf',
            'scale=720:-2:flags=fast_bilinear,transpose=1',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
        ],
    },
};

// Any non-'copy' audioEncoding (an explicit track selection) forces a real
// transcode. On an SRT origin this also fixes timestamp jitter (raw MPEG-TS
// PCR rounding / packet-loss gaps): aresample=async=1 tracks the real clock by
// adding/dropping samples to absorb that drift without inventing new PTS,
// which needs a real decode. A native RTMP origin has well-behaved timestamps
// (srt_to_rtmp is disabled — see srs.conf — so RTMP-origin pulls never pass
// through its jittery remux), so a transcode from an RTMP origin just
// normalizes the codec/format with no filter.
function encodeAudioArgs(isSrtOrigin: boolean): string[] {
    const filterArgs = isSrtOrigin ? ['-af', 'aresample=async=1:first_pts=0'] : [];
    return [...filterArgs, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'];
}

// Explicit map for FLV: ffmpeg's default picks the highest-channel stream, which
// can be an unwanted program mix. 'copy' means "default track" (0) and stays
// optional ('?') since a source with no audio at all is a legitimate,
// non-error case. An explicit numeric selection is a deliberate pick of a
// specific track, so it's mapped without '?': if the input doesn't actually
// have that track (e.g. picked before the input connected, or it just has
// fewer tracks than expected), ffmpeg fails fast instead of silently shipping
// a muted output — same as the SRT/mpegts path in buildAudioMapArgs below.
function buildSinkMapArgs(audioTrack: string, isSrt: boolean): string[] {
    if (isSrt) return buildAudioMapArgs(audioTrack);
    if (audioTrack === 'copy') {
        return ['-map', '0:v:0?', '-map', '0:a:0?'];
    }
    const idx = audioTrack.split(',')[0].trim();
    return ['-map', '0:v:0?', '-map', `0:a:${idx}`];
}

function buildAudioMapArgs(audioTrack: string): string[] {
    if (audioTrack === 'copy') return [];
    const indices = audioTrack
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const args: string[] = ['-map', '0:v:0'];
    for (const idx of indices) {
        args.push('-map', `0:a:${idx}`);
    }
    return args;
}

// The environment every FFmpeg/ffprobe child gets: only what it can use, never
// the app's own (BUNRYU_DASHBOARD_PASSWORD would otherwise sit in
// /proc/<pid>/environ of every output). SSL_CERT_* lets RTMPS find a CA bundle
// if TLS verification is ever turned on; LD_LIBRARY_PATH keeps a dynamically
// linked ffmpeg working.
const FFMPEG_ENV_KEYS = [
    'PATH',
    'LANG',
    'LC_ALL',
    'TZ',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'LD_LIBRARY_PATH',
];

export function ffmpegEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {};
    for (const key of FFMPEG_ENV_KEYS) {
        if (env[key] !== undefined) result[key] = env[key];
    }
    return result;
}

// Abort the pull if no input data is read for this long (microseconds, ffmpeg's
// -rw_timeout unit). SRS holds publisher-less pulls open indefinitely, so without
// this an output whose input never returns (or sits on a stale half-open socket)
// would hang "running" forever. On timeout ffmpeg exits, the retry loop takes
// over, and the output is restarted once the input is live again. Exported so
// the preview's ffmpeg pull uses the same bound.
export const INPUT_TIMEOUT_US = 10 * 60 * 1_000_000; // 10 minutes

// Give up on an RTMP/RTMPS destination whose writes stay blocked. A destination
// that accepts the connection but then stops reading (or never answers) leaves
// the TCP socket ESTABLISHED, which the socket watchdog treats as healthy, and
// without a bound ffmpeg waits forever; only the progress watchdog restarts it
// (about 45-50 s after progress stops, 90 s or more if the destination never
// answered at all). With this, ffmpeg exits on its own. Measured with the pinned
// ffmpeg: 10 s when the destination never answers (RTMP and RTMPS), 30 s when
// RTMP writes block mid-stream (3x the value), about 10 s for RTMPS; a connect
// that never completes already ends after ffmpeg's own 5 s, and a healthy
// destination is unaffected. Only RTMP/RTMPS: for SRT the option means something
// else. Never use -timeout here: for RTMP it switches the output to listen mode.
export const OUTPUT_IO_TIMEOUT_US = 10 * 1_000_000;

function outputTimeoutArgs(url: string): string[] {
    return url.startsWith('rtmp://') || url.startsWith('rtmps://')
        ? ['-rw_timeout', String(OUTPUT_IO_TIMEOUT_US)]
        : [];
}

// True for the command line of an FFmpeg that buildFfmpegArgs built: it always reads
// its input with the long `-rw_timeout` and reports `-progress pipe:1`, which no
// other FFmpeg of ours (a preview has no progress pipe) does together. Used to find
// the ones a previous instance left behind; a test keeps the builder and this in step.
export function isOutputFfmpegArgs(args: readonly string[]): boolean {
    const progressIdx = args.indexOf('-progress');
    const timeoutIdx = args.indexOf('-rw_timeout');
    return (
        progressIdx >= 0 &&
        args[progressIdx + 1] === 'pipe:1' &&
        timeoutIdx >= 0 &&
        args[timeoutIdx + 1] === String(INPUT_TIMEOUT_US)
    );
}

// Build a single ffmpeg command that pulls the input once and pushes it to one
// destination. The destination's audio track(s) are selected via -map; SRT
// destinations use mpegts, everything else uses flv.
// Own keys only: `constructor` and `toString` are on every plain object but are no preset.
export function isKnownEncoding(name: string): boolean {
    return Object.hasOwn(ENCODINGS, name);
}

export function buildFfmpegArgs(
    inputUrl: string,
    url: string,
    audioEncoding: string,
    videoEncoding = 'copy',
): string[] {
    const isSrtDestination = url.startsWith('srt://');
    const isRtmpDestination = url.startsWith('rtmp://') || url.startsWith('rtmps://');
    const isSrtOrigin = inputUrl.startsWith('srt://');
    const encArgs = ENCODINGS[isKnownEncoding(videoEncoding) ? videoEncoding : 'copy'].args;
    const args: string[] = [
        // Keep stderr quiet: '-nostats' drops the ~2/s "frame=…bitrate=…" line and
        // '-loglevel warning' the one-time info banner. With hundreds of outputs
        // those stderr writes are pure GC/event-loop pressure on the parent, and we
        // already read live bitrate from '-progress pipe:1'. Warnings/errors are
        // still emitted so the stderr tail explains failures.
        '-nostats',
        '-loglevel',
        'warning',
        // Emit '-progress pipe:1' every 3s instead of the default ~1s. The only
        // consumer (live bitrate) is sampled at the 5s health-poll cadence, so a
        // sub-5s update rate is invisible — at hundreds of outputs the extra
        // stdout writes are pure event-loop/GC churn on the parent. 3s keeps each
        // poll's bitrate at most ~3s stale while cutting the write rate ~3x.
        // (Progress on stdout is also the SIGPIPE keepalive that lets ffmpeg
        // self-exit when the parent dies; at 3s that detection is still prompt.)
        '-stats_period',
        '3',
        // Drop packets the demuxer/decoder already knows are broken (bad CRC,
        // desynced bitstream) before they reach the AAC decoder. Without this, a
        // glitchy input can hand the decoder a corrupt frame it misparses as a
        // bogus channel layout (seen as "Full-on remixing from 22.2" in the
        // 2026-07-10 incident), which is what triggered the swresample memory
        // blow-up — see fail-reports/2026-07-10-pipeline1-output-oom-cascade.md.
        '-fflags',
        '+discardcorrupt',
        '-err_detect',
        'crccheck+bitstream',
        '-rw_timeout',
        String(INPUT_TIMEOUT_US),
    ];

    // Bonded SRT recovery can deliver a short burst of already-buffered
    // MPEG-TS packets. Pace only live SRT-to-RTMP/RTMPS outputs so YouTube
    // does not see those packets as faster-than-real-time video. SRT outputs
    // retain their existing behavior, and RTMP-origin outputs do not need this
    // guard.
    if (isSrtOrigin && isRtmpDestination) args.push('-readrate', '1');
    args.push('-i', inputUrl, '-progress', 'pipe:1');

    const mapArgs = buildSinkMapArgs(audioEncoding, isSrtDestination);
    // 'copy' always means a literal stream copy, regardless of origin/destination
    // protocol. Anything else (an explicit track index/list) forces a real
    // transcode — see encodeAudioArgs for when that adds a filter.
    const audioArgs =
        audioEncoding === 'copy' ? (['-c:a', 'copy'] as const) : encodeAudioArgs(isSrtOrigin);
    const fmt = isSrtDestination ? ['-f', 'mpegts'] : ['-f', 'flv'];
    args.push(...mapArgs, ...encArgs, ...audioArgs, ...fmt, ...outputTimeoutArgs(url), url);
    return args;
}

export function validateOutputUrl(url: string): boolean {
    return (
        isCleanUrlText(url) &&
        (url.startsWith('rtmp://') || url.startsWith('rtmps://') || url.startsWith('srt://'))
    );
}

export function validateAudioEncoding(value: unknown): string | null {
    // Only an absent/empty encoding defaults to 'copy' — checking truthiness
    // instead would also catch other-typed falsy JSON values (0, false) sent
    // by a raw API call and silently reinterpret them as 'copy' rather than
    // rejecting them.
    if (value === undefined || value === null || value === '' || value === 'copy') return 'copy';
    if (typeof value !== 'string') return null;
    const parts = value.split(',').map((s) => s.trim());
    if (parts.length > MAX_AUDIO_TRACKS) return null;
    if (!parts.every((p) => /^\d+$/.test(p) && Number(p) < MAX_AUDIO_TRACKS)) return null;
    return parts.join(',');
}
