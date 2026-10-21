'use strict';

const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-appconfig-'));
const originalCwd = process.cwd();
const configPath = path.join(tempDir, 'bunryu.json');

process.chdir(tempDir);

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// appConfig.ts caches its result in module scope on first read, so every test
// that depends on file contents must delete the module from require.cache and
// re-require it after writing the fixture — same pattern as srs.ts/srsConfig.ts
// in test/utils.test.js.
function loadAppConfig(rawConfig) {
    if (rawConfig === undefined) {
        fs.rmSync(configPath, { force: true });
    } else {
        fs.writeFileSync(configPath, JSON.stringify(rawConfig), 'utf8');
    }
    delete require.cache[require.resolve('../src/utils/appConfig')];
    return require('../src/utils/appConfig').readAppConfig;
}

function loadAppConfigRaw(text) {
    fs.writeFileSync(configPath, text, 'utf8');
    delete require.cache[require.resolve('../src/utils/appConfig')];
    return require('../src/utils/appConfig').readAppConfig;
}

const FULL_VALID_CONFIG = {
    port: 8080,
    database_path: './db.sqlite',
    srs_config_path: './srs.conf',
    ffmpeg_path: 'ffmpeg',
    ffprobe_path: 'ffprobe',
};

describe('readAppConfig: BUNRYU_CONFIG', () => {
    test('reads the file at that path and resolves relative paths against its directory', () => {
        const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-appconfig-other-'));
        const otherPath = path.join(otherDir, 'custom.json');
        fs.writeFileSync(
            otherPath,
            JSON.stringify({
                port: 9191,
                dashboard_password: 'chosen-pass',
                database_path: './x.sqlite',
            }),
        );
        fs.rmSync(configPath, { force: true });
        process.env.BUNRYU_CONFIG = otherPath;
        try {
            delete require.cache[require.resolve('../src/utils/appConfig')];
            const config = require('../src/utils/appConfig').readAppConfig();
            assert.equal(config.port, 9191);
            assert.equal(config.dashboardPassword, 'chosen-pass');
            assert.equal(config.databasePath, path.join(otherDir, 'x.sqlite'));
        } finally {
            delete process.env.BUNRYU_CONFIG;
            delete require.cache[require.resolve('../src/utils/appConfig')];
            fs.rmSync(otherDir, { recursive: true, force: true });
        }
    });

    test('a missing file at that path throws and names it', () => {
        process.env.BUNRYU_CONFIG = path.join(tempDir, 'nope', 'bunryu.json');
        try {
            delete require.cache[require.resolve('../src/utils/appConfig')];
            assert.throws(
                () => require('../src/utils/appConfig').readAppConfig(),
                /Failed to read app config .*nope/,
            );
        } finally {
            delete process.env.BUNRYU_CONFIG;
            delete require.cache[require.resolve('../src/utils/appConfig')];
        }
    });
});

describe('readAppConfig: file-level errors', () => {
    test('throws a descriptive error when bunryu.json does not exist', () => {
        const readAppConfig = loadAppConfig(undefined);
        assert.throws(() => readAppConfig(), /Failed to read app config/);
    });

    test('throws a descriptive error on malformed JSON', () => {
        const readAppConfig = loadAppConfigRaw('{ this is not json');
        assert.throws(() => readAppConfig(), /Failed to read app config/);
    });

    test('an empty object uses every default', () => {
        const readAppConfig = loadAppConfig({});
        const cfg = readAppConfig();
        assert.equal(cfg.port, 8080);
        assert.equal(cfg.ffmpegPath, 'ffmpeg');
        assert.equal(cfg.ffprobePath, 'ffprobe');
        assert.ok(cfg.databasePath.endsWith('db.sqlite'));
        assert.ok(cfg.srsConfigPath.endsWith('srs.conf'));
    });
});

describe('readAppConfig: hook_port', () => {
    test('defaults to 8082', () => {
        assert.equal(loadAppConfig({})().hookPort, 8082);
    });

    test('uses a valid configured port and rejects invalid ones', () => {
        assert.equal(loadAppConfig({ hook_port: 18082 })().hookPort, 18082);
        for (const bad of [0, 70000, '8082', null, 1.5]) {
            assert.equal(loadAppConfig({ hook_port: bad })().hookPort, 8082);
        }
    });
});

describe('readAppConfig: dashboard_password', () => {
    test('is empty (no default) when absent', () => {
        assert.equal(loadAppConfig({})().dashboardPassword, '');
    });

    test('is used as given, without trimming', () => {
        const readAppConfig = loadAppConfig({ dashboard_password: '  s3cret pw ' });
        assert.equal(readAppConfig().dashboardPassword, '  s3cret pw ');
    });

    for (const bad of ['', 12345, null, true, ['x']]) {
        test(`treats ${JSON.stringify(bad)} as no password`, () => {
            const readAppConfig = loadAppConfig({ dashboard_password: bad });
            assert.equal(readAppConfig().dashboardPassword, '');
        });
    }

    test('BUNRYU_DASHBOARD_PASSWORD wins over the file', () => {
        process.env.BUNRYU_DASHBOARD_PASSWORD = 'from-env';
        try {
            const readAppConfig = loadAppConfig({ dashboard_password: 'from-file' });
            assert.equal(readAppConfig().dashboardPassword, 'from-env');
        } finally {
            delete process.env.BUNRYU_DASHBOARD_PASSWORD;
        }
    });
});

describe('readAppConfig: port validation (asPort)', () => {
    for (const bad of [0, -1, 65536, 8080.5, NaN, Infinity, '8080', null, true, [8080]]) {
        test(`rejects ${JSON.stringify(bad)} and falls back to the default 8080`, () => {
            const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG, port: bad });
            assert.equal(readAppConfig().port, 8080);
        });
    }

    test('accepts the boundary value 65535', () => {
        const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG, port: 65535 });
        assert.equal(readAppConfig().port, 65535);
    });

    test('accepts the boundary value 1', () => {
        const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG, port: 1 });
        assert.equal(readAppConfig().port, 1);
    });
});

describe('readAppConfig: PORT/DATABASE_PATH env overrides', () => {
    const originalPort = process.env.PORT;
    const originalDbPath = process.env.DATABASE_PATH;

    after(() => {
        if (originalPort === undefined) delete process.env.PORT;
        else process.env.PORT = originalPort;
        if (originalDbPath === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = originalDbPath;
    });

    beforeEach(() => {
        delete process.env.PORT;
        delete process.env.DATABASE_PATH;
    });

    test('PORT env var overrides bunryu.json when set', () => {
        process.env.PORT = '9999';
        const readAppConfig = loadAppConfig(FULL_VALID_CONFIG);
        assert.equal(readAppConfig().port, 9999);
    });

    test('an invalid PORT env var falls back to bunryu.json, not the hardcoded default', () => {
        process.env.PORT = 'not-a-number';
        const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG, port: 9000 });
        assert.equal(readAppConfig().port, 9000);
    });

    test('DATABASE_PATH env var overrides bunryu.json when set', () => {
        process.env.DATABASE_PATH = 'override.sqlite';
        const readAppConfig = loadAppConfig(FULL_VALID_CONFIG);
        assert.equal(readAppConfig().databasePath, path.resolve(tempDir, 'override.sqlite'));
    });

    test('with no env vars set, bunryu.json values are used as before', () => {
        const readAppConfig = loadAppConfig(FULL_VALID_CONFIG);
        assert.equal(readAppConfig().port, 8080);
        assert.ok(readAppConfig().databasePath.endsWith('db.sqlite'));
    });
});

describe('readAppConfig: string fields (asString)', () => {
    test('an empty or whitespace-only ffmpeg_path falls back to the default', () => {
        const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG, ffmpeg_path: '   ' });
        assert.equal(readAppConfig().ffmpegPath, 'ffmpeg');
    });

    test('a non-string ffmpeg_path falls back to the default', () => {
        const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG, ffmpeg_path: 123 });
        assert.equal(readAppConfig().ffmpegPath, 'ffmpeg');
    });

    test('trims surrounding whitespace from a valid string', () => {
        const readAppConfig = loadAppConfig({
            ...FULL_VALID_CONFIG,
            ffmpeg_path: '  /opt/ffmpeg  ',
        });
        assert.equal(readAppConfig().ffmpegPath, '/opt/ffmpeg');
    });
});

describe('readAppConfig: path resolution', () => {
    test('a relative database_path resolves against the config directory (cwd)', () => {
        const readAppConfig = loadAppConfig({
            ...FULL_VALID_CONFIG,
            database_path: 'data/db.sqlite',
        });
        assert.equal(readAppConfig().databasePath, path.resolve(tempDir, 'data/db.sqlite'));
    });

    test('an absolute database_path is used verbatim', () => {
        const readAppConfig = loadAppConfig({
            ...FULL_VALID_CONFIG,
            database_path: '/var/lib/bunryu/db.sqlite',
        });
        assert.equal(readAppConfig().databasePath, '/var/lib/bunryu/db.sqlite');
    });

    test('a bare ffmpeg_path command name (PATH lookup) is left unresolved, not turned into a file path', () => {
        const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG, ffmpeg_path: 'ffmpeg' });
        assert.equal(readAppConfig().ffmpegPath, 'ffmpeg');
    });

    test('a ./ or ../-prefixed ffmpeg_path resolves to an absolute path', () => {
        const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG, ffmpeg_path: './bin/ffmpeg' });
        assert.equal(readAppConfig().ffmpegPath, path.resolve(tempDir, './bin/ffmpeg'));
    });

    test('an absolute ffmpeg_path is used verbatim', () => {
        const readAppConfig = loadAppConfig({
            ...FULL_VALID_CONFIG,
            ffmpeg_path: '/usr/bin/ffmpeg',
        });
        assert.equal(readAppConfig().ffmpegPath, '/usr/bin/ffmpeg');
    });
});

describe('readAppConfig: output_watchdog defaults and validation', () => {
    test('missing output_watchdog uses every documented default', () => {
        const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG });
        const wd = readAppConfig().outputWatchdog;
        assert.equal(wd.warmupMs, 90_000);
        assert.equal(wd.stallMs, 45_000);
        assert.equal(wd.intervalMs, 5_000);
        assert.equal(wd.socketWarmupMs, 15_000);
        assert.equal(wd.socketGraceMs, 30_000);
        assert.equal(wd.memoryLimitMb, 200);
        assert.deepEqual(wd.memoryLimitMbByEncoding, {
            vertical_rotate: 450,
            '720p': 650,
            '1080p': 950,
        });
        assert.equal(wd.translatorMeterStaleMs, 10_000);
    });

    test('output_watchdog as a non-object (e.g. a string) is ignored, defaults used', () => {
        const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG, output_watchdog: 'nonsense' });
        assert.equal(readAppConfig().outputWatchdog.warmupMs, 90_000);
    });

    test('zero, negative, or non-finite watchdog values fall back to their default', () => {
        const readAppConfig = loadAppConfig({
            ...FULL_VALID_CONFIG,
            output_watchdog: {
                warmup_ms: 0,
                stall_ms: -5,
                interval_ms: Infinity,
                socket_grace_ms: NaN,
            },
        });
        const wd = readAppConfig().outputWatchdog;
        assert.equal(wd.warmupMs, 90_000);
        assert.equal(wd.stallMs, 45_000);
        assert.equal(wd.intervalMs, 5_000);
        assert.equal(wd.socketGraceMs, 30_000);
    });

    test('a valid override is honored exactly', () => {
        const readAppConfig = loadAppConfig({
            ...FULL_VALID_CONFIG,
            output_watchdog: { warmup_ms: 1000, stall_ms: 2000, translator_meter_stale_ms: 3000 },
        });
        const wd = readAppConfig().outputWatchdog;
        assert.equal(wd.warmupMs, 1000);
        assert.equal(wd.stallMs, 2000);
        assert.equal(wd.translatorMeterStaleMs, 3000);
        // Untouched fields still fall back to defaults.
        assert.equal(wd.intervalMs, 5_000);
    });

    test('zero, negative, or non-finite translator_meter_stale_ms falls back to its default', () => {
        const readAppConfig = loadAppConfig({
            ...FULL_VALID_CONFIG,
            output_watchdog: { translator_meter_stale_ms: -5 },
        });
        assert.equal(readAppConfig().outputWatchdog.translatorMeterStaleMs, 10_000);
    });

    test('memory_limit_mb_by_encoding merges over (not replaces) the built-in defaults', () => {
        const readAppConfig = loadAppConfig({
            ...FULL_VALID_CONFIG,
            output_watchdog: { memory_limit_mb_by_encoding: { '720p': 999 } },
        });
        const byEncoding = readAppConfig().outputWatchdog.memoryLimitMbByEncoding;
        assert.equal(byEncoding['720p'], 999);
        // vertical_rotate/1080p weren't touched — still the shipped defaults.
        assert.equal(byEncoding.vertical_rotate, 450);
        assert.equal(byEncoding['1080p'], 950);
    });

    test('an unknown encoding key with an invalid value falls back to the hardcoded base limit, not a configured memory_limit_mb override', () => {
        // asMemoryLimitMbByEncoding is resolved independently of memory_limit_mb
        // (readWatchdogConfig calls it with only the by-encoding map, not the
        // resolved base), so an overridden base does NOT compose here — the
        // fallback for an unlisted encoding is always the hardcoded 200. This
        // is fail-safe (a lower cap, not a higher one), so it's asserted as
        // documented current behavior rather than "fixed".
        const readAppConfig = loadAppConfig({
            ...FULL_VALID_CONFIG,
            output_watchdog: {
                memory_limit_mb: 300,
                memory_limit_mb_by_encoding: { custom_profile: -50, '720p': 'not-a-number' },
            },
        });
        const wd = readAppConfig().outputWatchdog;
        assert.equal(wd.memoryLimitMbByEncoding.custom_profile, 200);
        // 720p had a shipped default (650) to fall back to instead of the base.
        assert.equal(wd.memoryLimitMbByEncoding['720p'], 650);
    });

    test('memory_limit_mb_by_encoding as a non-object is ignored, defaults used', () => {
        const readAppConfig = loadAppConfig({
            ...FULL_VALID_CONFIG,
            output_watchdog: { memory_limit_mb_by_encoding: ['720p', 999] },
        });
        // Arrays are typeof 'object', so this actually passes the `typeof
        // === 'object'` guard and gets iterated as {0: '720p', 1: 999} —
        // document the real (slightly odd) resulting shape rather than assume.
        const byEncoding = readAppConfig().outputWatchdog.memoryLimitMbByEncoding;
        assert.equal(byEncoding.vertical_rotate, 450);
        assert.equal(byEncoding['720p'], 650);
    });
});

describe('readAppConfig: caching', () => {
    test('caches after the first read — a later file change is not picked up without a process restart', () => {
        const readAppConfig = loadAppConfig({ ...FULL_VALID_CONFIG, port: 1111 });
        assert.equal(readAppConfig().port, 1111);

        // Overwrite the file directly (bypassing loadAppConfig's require.cache
        // reset) to simulate an external edit while the process is running.
        fs.writeFileSync(configPath, JSON.stringify({ ...FULL_VALID_CONFIG, port: 2222 }), 'utf8');
        assert.equal(readAppConfig().port, 1111, 'must keep serving the cached value');
    });
});
