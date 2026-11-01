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
    // Stream keys generated for the pipelines to publish with; one pipeline
    // uses one key, so this is also the most inputs the server can have.
    streamKeyCount: number;
    outputWatchdog: OutputWatchdogConfig;
    // Where bunryu reports every output's status once a minute; null (no
    // `key_vault` block) disables the reporter. See src/services/keyVaultReporter.ts.
    keyVault: KeyVaultConfig | null;
}

export interface KeyVaultConfig {
    // The ingest endpoint: https, or http only on loopback (a local test receiver).
    url: string;
    // Sent as `Authorization: Bearer <token>`.
    token: string;
    // Secret shared with Key Vault for the HMAC of each output's destination URL.
    hashSecret: string;
    // Names this bunryu to Key Vault (e.g. "prod").
    instance: string;
}

// A setting that is present but wrong. Unlike the numeric keys, which fall back to
// their default, a bad `key_vault` block would silently send nothing, so it stops the
// start; isPermanentConfigError makes that exit 78 (no restart loop).
export class ConfigInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigInvalidError';
    }
}

export interface OutputWatchdogConfig {
    warmupMs: number;
    stallMs: number;
    intervalMs: number;
    socketWarmupMs: number;
    socketGraceMs: number;
    memoryLimitMb: number;
    memoryLimitMbByEncoding: Record<string, number>;
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
    stream_key_count?: unknown;
    output_watchdog?: unknown;
    key_vault?: unknown;
}

// BUNRYU_CONFIG moves the file out of the app root: the installer keeps it in
// /etc/bunryu, outside the git checkout that every update resets. Unset by
// default, so a dev checkout reads ./bunryu.json.
const CONFIG_PATH = process.env.BUNRYU_CONFIG
    ? path.resolve(process.env.BUNRYU_CONFIG)
    : path.join(process.cwd(), 'bunryu.json');
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
};
const DEFAULT_RAW_CONFIG = {
    port: 8080,
    hook_port: 8082,
    database_path: './db.sqlite',
    srs_config_path: './srs.conf',
    ffmpeg_path: 'ffmpeg',
    ffprobe_path: 'ffprobe',
} as const;
export const DEFAULT_STREAM_KEY_COUNT = 100;
// A typo such as 1000000 would otherwise generate a million keys at startup.
const MAX_STREAM_KEY_COUNT = 10_000;

let cachedConfig: AppConfig | null = null;

function asPort(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
        ? value
        : fallback;
}

function asPassword(fromEnv: string | undefined, fromFile: unknown): string {
    if (fromEnv) return fromEnv;
    return typeof fromFile === 'string' ? fromFile : '';
}

function asStreamKeyCount(value: unknown): number {
    return typeof value === 'number' &&
        Number.isInteger(value) &&
        value > 0 &&
        value <= MAX_STREAM_KEY_COUNT
        ? value
        : DEFAULT_STREAM_KEY_COUNT;
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
    };
}

const KEY_VAULT_KEYS = ['url', 'token', 'hash_secret', 'instance'];
const MIN_HASH_SECRET_LENGTH = 16;

function keyVaultString(raw: Record<string, unknown>, key: string): string {
    const value = raw[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw new ConfigInvalidError(`key_vault.${key} must be a non-empty string`);
    }
    return value;
}

// `key_vault` absent or null disables the reporter. A block that is there must be
// complete and usable, so a typo shows at start-up instead of as silence in Key Vault.
function readKeyVaultConfig(value: unknown): KeyVaultConfig | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ConfigInvalidError('key_vault must be an object, or null to disable it');
    }
    const raw = value as Record<string, unknown>;
    const extra = Object.keys(raw).filter((key) => !KEY_VAULT_KEYS.includes(key));
    if (extra.length > 0) {
        throw new ConfigInvalidError(`key_vault has unknown key(s): ${extra.join(', ')}`);
    }

    const urlText = keyVaultString(raw, 'url').trim();
    let url: URL;
    try {
        url = new URL(urlText);
    } catch {
        throw new ConfigInvalidError('key_vault.url is not a valid URL');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new ConfigInvalidError(
            'key_vault.url must be https (http is allowed only for localhost)',
        );
    }
    if (url.username || url.password) {
        throw new ConfigInvalidError('key_vault.url must not contain credentials; use token');
    }

    // Not trimmed, like the dashboard password; but both go into a header or a MAC key.
    const token = keyVaultString(raw, 'token');
    if (!/^[!-~]+$/.test(token)) {
        throw new ConfigInvalidError(
            'key_vault.token must be printable ASCII without spaces (it is sent in a header)',
        );
    }
    const hashSecret = keyVaultString(raw, 'hash_secret');
    if (hashSecret.length < MIN_HASH_SECRET_LENGTH) {
        throw new ConfigInvalidError(
            `key_vault.hash_secret must be at least ${MIN_HASH_SECRET_LENGTH} characters`,
        );
    }
    const instance = keyVaultString(raw, 'instance').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(instance)) {
        throw new ConfigInvalidError(
            'key_vault.instance must be 1-64 characters of letters, digits, ".", "_" or "-"',
        );
    }
    return { url: url.toString(), token, hashSecret, instance };
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

    // Relative paths in the file resolve against the file's own directory.
    const configDir = path.dirname(CONFIG_PATH);
    let raw: RawAppConfig;
    try {
        raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        throw new Error(`Failed to read app config ${CONFIG_PATH}: ${String(err)}`, {
            cause: err,
        });
    }

    // Names the file, which the setting's own message does not.
    let keyVault: KeyVaultConfig | null;
    try {
        keyVault = readKeyVaultConfig(raw.key_vault);
    } catch (err) {
        if (!(err instanceof ConfigInvalidError)) throw err;
        throw new ConfigInvalidError(`Invalid app config ${CONFIG_PATH}: ${err.message}`);
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
        // Not run through asString(): a password must not be trimmed. Empty means
        // none; there is no default, initializePassword() refuses to start without
        // one when the database needs it. BUNRYU_DASHBOARD_PASSWORD wins over the
        // file, like PORT and DATABASE_PATH above.
        dashboardPassword: asPassword(
            process.env.BUNRYU_DASHBOARD_PASSWORD,
            raw.dashboard_password,
        ),
        streamKeyCount: asStreamKeyCount(raw.stream_key_count),
        outputWatchdog: readWatchdogConfig(raw.output_watchdog),
        keyVault,
    };
    return cachedConfig;
}
