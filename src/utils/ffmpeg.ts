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

// Build a single ffmpeg command that pulls the input once and pushes it to one
// destination. The destination's audio track(s) are selected via -map; SRT
// destinations use mpegts, everything else uses flv.
export function buildFfmpegArgs(
    inputUrl: string,
    url: string,
    audioEncoding: string,
    videoEncoding = 'copy',
): string[] {
    const isSrtDestination = url.startsWith('srt://');
    const isRtmpDestination = url.startsWith('rtmp://') || url.startsWith('rtmps://');
    const isSrtOrigin = inputUrl.startsWith('srt://');
    const encArgs = (ENCODINGS[videoEncoding] ?? ENCODINGS.copy).args;
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

export interface TranslationMixerConfig {
    videoEncoding: string;
    // Which audio track of each input to use in the mix. Both default to 0
    // (the input's first track) when omitted.
    sourceTrackIndex?: number;
    translatorTrackIndex?: number;
    translationDelayMs: number;
    voiceThresholdDb: number;
    controlPort: number;
    duckVolumeDb: number;
    duckDurationMs: number;
    restoreSilenceMs: number;
    restoreVolumeDb: number;
    restoreDurationMs: number;
}

// Source-volume settings are in dB relative to the source (0 dB = unchanged,
// never a boost). At or below MIN_VOLUME_DB the source is muted outright
// instead of left at a barely audible 0.001. A missing or NaN value leaves the
// source untouched: a silent program is worse than one that is not ducked.
export const MIN_VOLUME_DB = -60;

export function dbToAmplitude(volumeDb: number): number {
    if (typeof volumeDb !== 'number' || Number.isNaN(volumeDb)) return 1;
    if (volumeDb <= MIN_VOLUME_DB) return 0;
    return 10 ** (Math.min(0, volumeDb) / 20);
}

// Build one upstream program stream for a translation mix. The source input
// owns the video; the translator input contributes audio only (see below for
// why the translator is input 0 and the source input 1). The translator
// is split so its immediate copy drives the sidechain while its audible copy
// is delayed to compensate for the translator's lead/arrival timing.
export function buildTranslationMixerArgs(
    sourceInputUrl: string,
    translatorInputUrl: string | null,
    outputUrl: string,
    config: TranslationMixerConfig,
): string[] {
    const common = [
        '-nostats',
        '-loglevel',
        'warning',
        '-stats_period',
        '3',
        '-fflags',
        '+discardcorrupt',
        '-err_detect',
        'crccheck+bitstream',
        '-rw_timeout',
        String(INPUT_TIMEOUT_US),
    ];
    const args = [...common];
    const videoArgs = (ENCODINGS[config.videoEncoding] ?? ENCODINGS.copy).args;
    const formatArgs = outputUrl.startsWith('srt://') ? ['-f', 'mpegts'] : ['-f', 'flv'];
    const sourceTrackIndex = config.sourceTrackIndex ?? 0;
    const translatorTrackIndex = config.translatorTrackIndex ?? 0;

    if (!translatorInputUrl) {
        if (sourceInputUrl.startsWith('srt://')) args.push('-readrate', '1');
        args.push('-i', sourceInputUrl);
        args.push(
            '-map',
            '0:v:0?',
            '-map',
            `0:a:${sourceTrackIndex}?`,
            ...videoArgs,
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-progress',
            'pipe:1',
            ...formatArgs,
            ...outputTimeoutArgs(outputUrl),
            outputUrl,
        );
        return args;
    }

    // Input order is load-bearing for A/V sync. FFmpeg opens inputs one after
    // another and starts each input's timeline at its own first packet, so
    // whatever time the first-opened input spends probing (analyzeduration
    // defaults to 5 s) becomes a fixed offset between the two legs. With the
    // source first, the source ended up ~2 s (RTMP) to ~6 s (SRT) behind the
    // translation. The translator is therefore opened first (input 0) with a
    // short probe — it is our own audio-only pull, so 0.5 s is plenty — and
    // the source (input 1) keeps FFmpeg's default probe so its video codec
    // parameters are still found reliably. Measured residual over SRT: ~0 s
    // (up to ~0.7 s translator-behind if the translator also carries video).
    // Over RTMP, SRS's GOP cache starts the source up to one GOP in the past,
    // so an RTMP source can still trail the translation by up to its keyframe
    // interval; this ordering cannot remove that.
    if (translatorInputUrl.startsWith('srt://')) args.push('-readrate', '1');
    args.push('-analyzeduration', '500000', '-probesize', '500000', '-i', translatorInputUrl);
    if (sourceInputUrl.startsWith('srt://')) args.push('-readrate', '1');
    args.push('-i', sourceInputUrl);
    const delay = Math.max(0, Math.round(config.translationDelayMs));
    args.push(
        '-filter_complex',
        `[1:a:${sourceTrackIndex}]aresample=48000:async=1:first_pts=0[source];` +
            `[source]volume@source_gain=1,azmq=bind_address=tcp\\\\://127.0.0.1\\\\:${config.controlPort}[source_controlled];` +
            `[0:a:${translatorTrackIndex}]aresample=48000:async=1:first_pts=0,asplit=2[translator_audio][translator_meter];` +
            `[translator_audio]adelay=${delay}:all=1[translator_delayed];` +
            // astats' `reset` is a frame count, not seconds — 0 (or a value
            // that rounds/truncates to it) disables periodic reset entirely,
            // making Overall.Peak_level a cumulative high-water mark for the
            // whole stream instead of a live reading. That silently wedges
            // voice detection: once the translator has ever spoken, the
            // reported peak never comes back down on its own, so the source
            // stays ducked/low even through real silence until the mixer is
            // restarted. reset=1 recomputes every frame (~20ms at 48kHz),
            // giving a genuinely live reading.
            `[translator_meter]astats=metadata=1:reset=1,ametadata=mode=print:file=pipe\\\\:3,anullsink;` +
            `[source_controlled][translator_delayed]amix=inputs=2:duration=longest:dropout_transition=0.2[mixed_audio]`,
        '-map',
        '1:v:0?',
        '-map',
        '[mixed_audio]',
        ...videoArgs,
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-progress',
        'pipe:1',
        ...formatArgs,
        ...outputTimeoutArgs(outputUrl),
        outputUrl,
    );
    return args;
}

export function validateOutputUrl(url: string): boolean {
    return (
        isCleanUrlText(url) &&
        (url.startsWith('rtmp://') || url.startsWith('rtmps://') || url.startsWith('srt://'))
    );
}

const TRANSLATION_AUDIO = 'translation';

// A translation output is published by the translation mixer (its own ffmpeg),
// never by the output service, so every output-service entry point that would
// spawn or restart a process must skip it. Check through this, not the string.
export function isTranslationAudio(audioEncoding: string): boolean {
    return audioEncoding === TRANSLATION_AUDIO;
}

export function validateAudioEncoding(value: unknown): string | null {
    // Only an absent/empty encoding defaults to 'copy' — checking truthiness
    // instead would also catch other-typed falsy JSON values (0, false) sent
    // by a raw API call and silently reinterpret them as 'copy' rather than
    // rejecting them.
    if (value === undefined || value === null || value === '' || value === 'copy') return 'copy';
    if (value === TRANSLATION_AUDIO) return TRANSLATION_AUDIO;
    if (typeof value !== 'string') return null;
    const parts = value.split(',').map((s) => s.trim());
    if (parts.length > MAX_AUDIO_TRACKS) return null;
    if (!parts.every((p) => /^\d+$/.test(p) && Number(p) < MAX_AUDIO_TRACKS)) return null;
    return parts.join(',');
}
