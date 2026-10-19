import fs from 'fs';
import path from 'path';

export interface AppConfig {
    port: number;
    // Loopback-only port serving SRS's on_publish/on_play hooks (never public).
    hookPort: number;
    // Number of reverse-proxy hops (e.g. 1 behind cloudflared/nginx) whose
    // X-Forwarded-For is trusted for client IPs. 0 = none, the safe default when
    // the port is reachable directly.
    trustProxy: number;
    databasePath: string;
    srsConfigPath: string;
    ffmpegPath: string;
    ffprobePath: string;
    // Seeds the dashboard password hash on first boot only (when the database
    // has none yet); changing it later has no effect on an existing database.
    dashboardPassword: string;
    outputWatchdog: OutputWatchdogConfig;
}

export interface OutputWatchdogConfig {
    warmupMs: number;
    stallMs: number;
    intervalMs: number;
    socketWarmupMs: number;
    socketGraceMs: number;
    memoryLimitMb: number;
    memoryLimitMbByEncoding: Record<string, number>;
    // How long a translation-mixer output's translator audio meter can go
    // quiet (including never having produced a single sample) before the
    // mixer is restarted. See src/services/translationMixer.ts.
    translatorMeterStaleMs: number;
}

interface RawAppConfig {
    port?: unknown;
    hook_port?: unknown;
    trust_proxy?: unknown;
    database_path?: unknown;
    srs_config_path?: unknown;
    ffmpeg_path?: unknown;
    ffprobe_path?: unknown;
    dashboard_password?: unknown;
    output_watchdog?: unknown;
}

const CONFIG_PATH = path.join(process.cwd(), 'bunryu.json');
const DEFAULT_WATCHDOG_CONFIG: OutputWatchdogConfig = {
    warmupMs: 90_000,
    stallMs: 45_000,
    intervalMs: 5_000,
    socketWarmupMs: 15_000,
    socketGraceMs: 30_000,
    // ~2-3x the ~65-90MB a healthy 'copy' (stream-copy, no transcode) output
    // runs at. Sized off the 2026-07-10 incident: a corrupt-input-triggered leak
    // took ~40min to cross the old 500MB limit from baseline, well before the
    // ~1.5-1.6GB anon-rss the kernel OOM killer struck at — see
    // fail-reports/2026-07-10-pipeline1-output-oom-cascade.md. Applies to 'copy'
    // and any videoEncoding not listed in memoryLimitMbByEncoding below.
    memoryLimitMb: 200,
    // libx264 transcode profiles run at a much higher legitimate baseline than
    // 'copy' (scale filter + encoder buffers), so they need their own limits —
    // measured baselines on 2026-07-10: vertical_rotate ~254MB, 720p ~373MB,
    // 1080p ~590MB. Each limit here is ~1.7-1.8x its measured baseline.
    memoryLimitMbByEncoding: {
        vertical_rotate: 450,
        '720p': 650,
        '1080p': 950,
    },
    translatorMeterStaleMs: 10_000,
};
const DEFAULT_RAW_CONFIG = {
    port: 8080,
    hook_port: 8082,
    database_path: './db.sqlite',
    srs_config_path: './srs.conf',
    ffmpeg_path: 'ffmpeg',
    ffprobe_path: 'ffprobe',
    dashboard_password: 'admin',
} as const;

let cachedConfig: AppConfig | null = null;

function asPort(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
        ? value
        : fallback;
}

function asString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asPositiveNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function asMemoryLimitMbByEncoding(value: unknown): Record<string, number> {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const result: Record<string, number> = { ...DEFAULT_WATCHDOG_CONFIG.memoryLimitMbByEncoding };
    for (const [encoding, limit] of Object.entries(raw)) {
        const fallback = result[encoding] ?? DEFAULT_WATCHDOG_CONFIG.memoryLimitMb;
        result[encoding] = asPositiveNumber(limit, fallback);
    }
    return result;
}

function readWatchdogConfig(value: unknown): OutputWatchdogConfig {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return {
        warmupMs: asPositiveNumber(raw.warmup_ms, DEFAULT_WATCHDOG_CONFIG.warmupMs),
        stallMs: asPositiveNumber(raw.stall_ms, DEFAULT_WATCHDOG_CONFIG.stallMs),
        intervalMs: asPositiveNumber(raw.interval_ms, DEFAULT_WATCHDOG_CONFIG.intervalMs),
        socketWarmupMs: asPositiveNumber(
            raw.socket_warmup_ms,
            DEFAULT_WATCHDOG_CONFIG.socketWarmupMs,
        ),
        socketGraceMs: asPositiveNumber(raw.socket_grace_ms, DEFAULT_WATCHDOG_CONFIG.socketGraceMs),
        memoryLimitMb: asPositiveNumber(raw.memory_limit_mb, DEFAULT_WATCHDOG_CONFIG.memoryLimitMb),
        memoryLimitMbByEncoding: asMemoryLimitMbByEncoding(raw.memory_limit_mb_by_encoding),
        translatorMeterStaleMs: asPositiveNumber(
            raw.translator_meter_stale_ms,
            DEFAULT_WATCHDOG_CONFIG.translatorMeterStaleMs,
        ),
    };
}

function resolveFilePath(value: string, configDir: string): string {
    return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

function resolveCommand(value: string, configDir: string): string {
    if (path.isAbsolute(value) || value.startsWith('./') || value.startsWith('../')) {
        return resolveFilePath(value, configDir);
    }
    return value;
}

// 'copy' (stream-copy) outputs run far leaner than libx264 transcode profiles
// (720p/1080p/vertical_rotate), which legitimately sit well above the base
// limit due to scale-filter + encoder buffers — see memoryLimitMbByEncoding
// in DEFAULT_WATCHDOG_CONFIG above for measured baselines.
//
// A 4K input decodes/copies much larger frames than the baselines above were
// measured against, so a 4K pipeline's outputs legitimately run higher RSS.
// HIGH_RES_MEMORY_MULTIPLIER of 2 was checked against measured 4K baselines on
// 2026-10-19 (see docs/1-getting-started/4-sizing.md): copy with AAC audio 56 MB
// (129 MB at start) and 1080p 940 MB (both on production), vertical_rotate 472 MB
// and 720p 608 MB (development machine). The doubled limits sit about 3x above copy
// and 1.9-2.1x above the encodes, about the margin of the HD limits above.
const HIGH_RES_MEMORY_MULTIPLIER = 2;

// Shared by the output service and the translation mixer so both apply the same
// per-encoding limit.
export function outputMemoryLimitBytes(
    watchdog: OutputWatchdogConfig,
    videoEncoding: string,
    highRes: boolean,
): number {
    const mb = watchdog.memoryLimitMbByEncoding[videoEncoding] ?? watchdog.memoryLimitMb;
    const scaledMb = highRes ? mb * HIGH_RES_MEMORY_MULTIPLIER : mb;
    return scaledMb * 1024 * 1024;
}

export function readAppConfig(): AppConfig {
    if (cachedConfig) return cachedConfig;

    const configDir = process.cwd();
    let raw: RawAppConfig;
    try {
        raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        throw new Error(`Failed to read app config ${CONFIG_PATH}: ${String(err)}`, {
            cause: err,
        });
    }

    // PORT/DATABASE_PATH env vars override bunryu.json when set — lets an
    // isolated instance (e.g. automated UI testing) run alongside a
    // developer's own `npm run dev` without colliding on the port or
    // clobbering their database. Unset by default, so normal dev/production
    // runs are unaffected.
    cachedConfig = {
        port: asPort(
            process.env.PORT ? Number(process.env.PORT) : undefined,
            asPort(raw.port, DEFAULT_RAW_CONFIG.port as number),
        ),
        trustProxy:
            typeof raw.trust_proxy === 'number' &&
            Number.isInteger(raw.trust_proxy) &&
            raw.trust_proxy >= 0 &&
            raw.trust_proxy <= 10
                ? raw.trust_proxy
                : 0,
        hookPort: asPort(raw.hook_port, DEFAULT_RAW_CONFIG.hook_port as number),
        databasePath: resolveFilePath(
            asString(
                process.env.DATABASE_PATH,
                asString(raw.database_path, DEFAULT_RAW_CONFIG.database_path as string),
            ),
            configDir,
        ),
        srsConfigPath: resolveFilePath(
            asString(raw.srs_config_path, DEFAULT_RAW_CONFIG.srs_config_path as string),
            configDir,
        ),
        ffmpegPath: resolveCommand(
            asString(raw.ffmpeg_path, DEFAULT_RAW_CONFIG.ffmpeg_path as string),
            configDir,
        ),
        ffprobePath: resolveCommand(
            asString(raw.ffprobe_path, DEFAULT_RAW_CONFIG.ffprobe_path as string),
            configDir,
        ),
        // Not run through asString(): a password must not be trimmed.
        dashboardPassword:
            typeof raw.dashboard_password === 'string' && raw.dashboard_password !== ''
                ? raw.dashboard_password
                : DEFAULT_RAW_CONFIG.dashboard_password,
        outputWatchdog: readWatchdogConfig(raw.output_watchdog),
    };
    return cachedConfig;
}
