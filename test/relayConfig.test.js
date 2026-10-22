'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-relayconfig-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
fs.writeFileSync(
    path.join(tempDir, 'bunryu.json'),
    JSON.stringify({
        port: 8080,
        database_path: './db.sqlite',
        srs_config_path: './srs.conf',
        ffmpeg_path: 'ffmpeg',
        ffprobe_path: 'ffprobe',
    }),
    'utf8',
);
fs.writeFileSync(path.join(tempDir, 'srs.conf'), 'listen 1935;\n', 'utf8');

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const {
    normalizeRelayConfig,
    renderRelayConfig,
    getRelayConfigPath,
    DEFAULT_RELAY_CONFIG,
} = require('../src/utils/relayConfig');

describe('getRelayConfigPath', () => {
    test('sits alongside srs.conf', () => {
        assert.equal(getRelayConfigPath(), path.join(tempDir, 'goryu.json'));
    });
});

describe('normalizeRelayConfig', () => {
    test('a fully valid object passes through unchanged', () => {
        const input = {
            input_host: '0.0.0.0',
            input_port: 12345,
            output_host: '10.0.0.5',
            output_port: 54321,
            status_port: 9999,
            passphrase: 'secret',
        };
        assert.deepEqual(normalizeRelayConfig(input), input);
    });

    test('null, undefined, and non-object input all fall back to full defaults', () => {
        for (const bad of [null, undefined, 'nonsense', 42, []]) {
            const result = normalizeRelayConfig(bad);
            // arrays are typeof 'object' so [] passes the object guard, but has
            // no matching keys, meaning every field still falls back to default.
            assert.deepEqual(result, DEFAULT_RELAY_CONFIG);
        }
    });

    test('an out-of-range port falls back to the default for that field only', () => {
        const result = normalizeRelayConfig({ input_port: 0, output_port: 70000, status_port: -1 });
        assert.equal(result.input_port, DEFAULT_RELAY_CONFIG.input_port);
        assert.equal(result.output_port, DEFAULT_RELAY_CONFIG.output_port);
        assert.equal(result.status_port, DEFAULT_RELAY_CONFIG.status_port);
    });

    test('a non-integer port falls back to the default', () => {
        const result = normalizeRelayConfig({ input_port: 8080.5 });
        assert.equal(result.input_port, DEFAULT_RELAY_CONFIG.input_port);
    });

    test('a non-string host falls back to the default', () => {
        const result = normalizeRelayConfig({ input_host: 12345 });
        assert.equal(result.input_host, DEFAULT_RELAY_CONFIG.input_host);
    });

    test('an empty-string host is accepted verbatim (only type is checked, not emptiness)', () => {
        // asString() here (unlike appConfig.ts's asString) has no trim/non-empty
        // check — documenting the real, more permissive behavior.
        const result = normalizeRelayConfig({ input_host: '' });
        assert.equal(result.input_host, '');
    });

    test('a partial object only overrides the given fields', () => {
        const result = normalizeRelayConfig({ passphrase: 'only-this' });
        assert.equal(result.passphrase, 'only-this');
        assert.equal(result.input_host, DEFAULT_RELAY_CONFIG.input_host);
        assert.equal(result.output_port, DEFAULT_RELAY_CONFIG.output_port);
    });

    test('port boundary values 1 and 65535 are both accepted', () => {
        assert.equal(normalizeRelayConfig({ input_port: 1 }).input_port, 1);
        assert.equal(normalizeRelayConfig({ input_port: 65535 }).input_port, 65535);
    });
});

describe('readRelayConfig', () => {
    const relayPath = () => getRelayConfigPath();
    // relayConfig.ts caches its first successful read at module scope, so each test
    // re-requires it, as appConfig.test.js does.
    function freshReadRelayConfig() {
        delete require.cache[require.resolve('../src/utils/relayConfig')];
        return require('../src/utils/relayConfig').readRelayConfig;
    }

    test('throws when the file does not exist, naming the file', () => {
        fs.rmSync(relayPath(), { force: true });
        assert.throws(() => freshReadRelayConfig()(), /Failed to read relay config .*goryu\.json/);
    });

    test('throws on malformed JSON', () => {
        fs.writeFileSync(relayPath(), '{ not valid json', 'utf8');
        assert.throws(() => freshReadRelayConfig()(), /Failed to read relay config/);
    });

    test('fills the defaults for fields a valid file leaves out', () => {
        fs.writeFileSync(relayPath(), '{}', 'utf8');
        assert.deepEqual(freshReadRelayConfig()(), DEFAULT_RELAY_CONFIG);
    });

    test('reads and normalizes a valid file', () => {
        fs.writeFileSync(
            relayPath(),
            JSON.stringify({ input_port: 55555, passphrase: 'hunter2' }),
            'utf8',
        );
        const cfg = freshReadRelayConfig()();
        assert.equal(cfg.input_port, 55555);
        assert.equal(cfg.passphrase, 'hunter2');
        assert.equal(cfg.output_port, DEFAULT_RELAY_CONFIG.output_port);
    });

    test('keeps the first successful read until the next start', () => {
        fs.writeFileSync(relayPath(), JSON.stringify({ input_port: 1111 }), 'utf8');
        const read = freshReadRelayConfig();
        assert.equal(read().input_port, 1111);
        fs.writeFileSync(relayPath(), JSON.stringify({ input_port: 2222 }), 'utf8');
        assert.equal(read().input_port, 1111);
    });

    test('does not cache a failed read: a file that appears later is used', () => {
        fs.rmSync(relayPath(), { force: true });
        const read = freshReadRelayConfig();
        assert.throws(() => read(), /Failed to read relay config/);
        fs.writeFileSync(relayPath(), JSON.stringify({ input_port: 3333 }), 'utf8');
        assert.equal(read().input_port, 3333);
    });
});

describe('renderRelayConfig', () => {
    test('round-trips through JSON.parse back to an equal object', () => {
        const cfg = { ...DEFAULT_RELAY_CONFIG, passphrase: 'x"y\\z' };
        const rendered = renderRelayConfig(cfg);
        assert.deepEqual(JSON.parse(rendered), cfg);
    });

    test('ends with a trailing newline', () => {
        const rendered = renderRelayConfig(DEFAULT_RELAY_CONFIG);
        assert.ok(rendered.endsWith('\n'));
        assert.ok(!rendered.endsWith('\n\n'));
    });

    test('is pretty-printed with 4-space indentation', () => {
        const rendered = renderRelayConfig(DEFAULT_RELAY_CONFIG);
        assert.match(rendered, /\n {4}"input_host"/);
    });
});
