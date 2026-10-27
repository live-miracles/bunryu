'use strict';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-version-'));
const originalCwd = process.cwd();
const pkgVersion = require('../../package.json').version;

before(() => {
    fs.writeFileSync(
        path.join(tempDir, 'bunryu.json'),
        JSON.stringify(
            {
                port: 8080,
                database_path: './db.sqlite',
                srs_config_path: './srs.conf',
                ffmpeg_path: 'ffmpeg',
                ffprobe_path: 'ffprobe',
            },
            null,
            4,
        ),
        'utf8',
    );
    fs.writeFileSync(
        path.join(tempDir, 'srs.conf'),
        'listen 1935;\nhttp_api {\n    listen 1985;\n}\n',
        'utf8',
    );
});

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

class MockRequest extends Readable {
    constructor(method, url) {
        super();
        this.method = method;
        this.url = url;
        this.headers = {};
        this.socket = { remoteAddress: '127.0.0.1' };
        this.connection = this.socket;
    }

    _read() {
        this.push(null);
    }
}

class MockResponse extends Writable {
    constructor(resolve) {
        super();
        this.statusCode = 200;
        this.headers = {};
        this.chunks = [];
        this.resolve = resolve;
        this.setHeader = (name, value) => {
            this.headers[String(name).toLowerCase()] = value;
        };
        this.getHeader = (name) => this.headers[String(name).toLowerCase()];
        this.removeHeader = (name) => {
            delete this.headers[String(name).toLowerCase()];
        };
        this.writeHead = (statusCode, headers = {}) => {
            this.statusCode = statusCode;
            for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
            return this;
        };
        this.end = (chunk, encoding, callback) => {
            if (chunk) this.chunks.push(Buffer.from(chunk, encoding));
            const text = Buffer.concat(this.chunks).toString('utf8');
            this.resolve({
                status: this.statusCode,
                body: text ? JSON.parse(text) : undefined,
            });
            if (callback) callback();
            return this;
        };
    }

    _write(chunk, _encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }
}

function dispatch(app, method, route) {
    return new Promise((resolve, reject) => {
        app.handle(new MockRequest(method, route), new MockResponse(resolve), reject);
    });
}

function jsonResponse(body) {
    return { ok: true, status: 200, json: async () => body };
}

// version.ts caches its result forever at module scope, and pulls the SRS API
// port through appConfig/srsConfig (also module-cached) — every test needs a
// fully fresh require chain plus its own fixture.
function loadHarness(t, { execImpl, fetchImpl, existsSyncImpl } = {}) {
    process.chdir(tempDir);
    for (const mod of [
        '../../src/api/version',
        '../../src/utils/appConfig',
        '../../src/utils/srsConfig',
    ]) {
        delete require.cache[require.resolve(mod)];
    }
    t.mock.method(
        childProcess,
        'execFile',
        execImpl ??
            ((_cmd, _args, _opts, cb) => {
                queueMicrotask(() => cb(null, '', ''));
            }),
    );
    t.mock.method(globalThis, 'fetch', fetchImpl ?? (async () => jsonResponse({ data: {} })));
    t.mock.method(fs, 'existsSync', existsSyncImpl ?? (() => false));
    const { registerVersionApi } = require('../../src/api/version');
    const app = express();
    registerVersionApi(app);
    return { get: () => dispatch(app, 'GET', '/api/version') };
}

describe('Version API integration', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    test('falls back to "unknown" for every external tool that fails or is unavailable', async (t) => {
        const { get } = loadHarness(t, {
            execImpl: (_cmd, _args, _opts, cb) => {
                queueMicrotask(() => cb(new Error('not found'), '', ''));
            },
            fetchImpl: async () => {
                throw new Error('ECONNREFUSED');
            },
            existsSyncImpl: () => false,
        });

        const res = await get();

        assert.equal(res.status, 200);
        assert.equal(res.body.commit, 'unknown');
        assert.equal(res.body.srs, 'unknown');
        assert.equal(res.body.srtRelay, 'unknown');
        assert.equal(res.body.ffmpeg, 'unknown');
        assert.equal(res.body.node, process.version);
        // Not sourced externally — read straight from package.json.
        assert.equal(res.body.app, pkgVersion);
    });

    test('a failing command reports "unknown", not its error text', async (t) => {
        const { get } = loadHarness(t, {
            execImpl: (cmd, _args, _opts, cb) => {
                if (cmd === 'git') {
                    const err = Object.assign(new Error('exit 128'), { code: 128 });
                    return queueMicrotask(() =>
                        cb(
                            err,
                            '',
                            'fatal: not a git repository (or any parent up to mount point /)\n',
                        ),
                    );
                }
                queueMicrotask(() => cb(null, '', ''));
            },
        });

        const res = await get();
        assert.equal(res.status, 200);
        assert.equal(res.body.commit, 'unknown');
    });

    test('parses a successful git/ffmpeg/SRS/relay response into the expected shape', async (t) => {
        const { get } = loadHarness(t, {
            execImpl: (cmd, args, _opts, cb) => {
                if (cmd === 'git' && args.some((a) => a.includes('%h %s'))) {
                    return queueMicrotask(() => cb(null, 'abc1234 Fix things\n', ''));
                }
                if (cmd === 'git' && args.some((a) => a.includes('%cd'))) {
                    return queueMicrotask(() => cb(null, '2026-07-01 12:00\n', ''));
                }
                if (cmd === 'ffmpeg') {
                    return queueMicrotask(() =>
                        cb(null, 'ffmpeg version 7.1-static Copyright (c) 2000-2024\n', ''),
                    );
                }
                queueMicrotask(() => cb(null, '', ''));
            },
            fetchImpl: async () => jsonResponse({ data: { version: '6.0.155' } }),
            existsSyncImpl: () => false,
        });

        const res = await get();

        assert.equal(res.status, 200);
        assert.equal(res.body.commit, '2026-07-01 12:00 abc1234 Fix things');
        assert.equal(res.body.srs, '6.0.155');
        assert.equal(res.body.ffmpeg, '7.1-static');
        assert.equal(res.body.srtRelay, 'unknown');
        assert.equal(res.body.node, process.version);
    });

    test('a malformed (non-JSON-shaped) SRS versions response falls back to "unknown", not a crash', async (t) => {
        const { get } = loadHarness(t, {
            fetchImpl: async () => jsonResponse('just a string, not {data:{version}}'),
        });

        const res = await get();
        assert.equal(res.status, 200);
        assert.equal(res.body.srs, 'unknown');
    });

    test('an SRS response with ok:false falls back to "unknown" instead of surfacing an HTTP error', async (t) => {
        const { get } = loadHarness(t, {
            fetchImpl: async () => ({
                ok: false,
                status: 500,
                json: async () => ({ data: { version: 'should-not-be-used' } }),
            }),
        });

        const res = await get();
        assert.equal(res.status, 200);
        // Current behavior: the code only checks resp.json(), not resp.ok, so
        // a non-ok response whose body still parses is used as-is. Documented
        // here so a future change to check res.ok is a deliberate one.
        assert.equal(res.body.srs, 'should-not-be-used');
    });

    test('detects a present goryu binary and runs --version on it', async (t) => {
        const { get } = loadHarness(t, {
            execImpl: (cmd, args, _opts, cb) => {
                if (String(cmd).includes('goryu')) {
                    return queueMicrotask(() => cb(null, 'goryu v1.2.3\n', ''));
                }
                queueMicrotask(() => cb(null, '', ''));
            },
            existsSyncImpl: (candidate) => String(candidate).includes('goryu'),
        });

        const res = await get();
        assert.equal(res.status, 200);
        assert.equal(res.body.srtRelay, 'goryu v1.2.3');
    });

    test('the response is cached: a second request does not re-invoke external tools', async (t) => {
        let execCalls = 0;
        let fetchCalls = 0;
        const { get } = loadHarness(t, {
            execImpl: (_cmd, _args, _opts, cb) => {
                execCalls++;
                queueMicrotask(() => cb(null, 'v1\n', ''));
            },
            fetchImpl: async () => {
                fetchCalls++;
                return jsonResponse({ data: { version: '6.0.0' } });
            },
        });

        const first = await get();
        const callsAfterFirst = execCalls;
        const fetchAfterFirst = fetchCalls;
        assert.ok(callsAfterFirst > 0);
        assert.ok(fetchAfterFirst > 0);

        const second = await get();
        assert.deepEqual(second.body, first.body);
        assert.equal(
            execCalls,
            callsAfterFirst,
            'external commands must not run again on a cache hit',
        );
        assert.equal(
            fetchCalls,
            fetchAfterFirst,
            'SRS version must not be refetched on a cache hit',
        );
    });

    test('reports the CPU model with padding and repeated spaces collapsed', async (t) => {
        t.mock.method(os, 'cpus', () => [
            { model: '  Intel(R) Xeon(R)   CPU @ 2.20GHz ' },
            { model: 'Intel(R) Xeon(R) CPU @ 2.20GHz' },
        ]);
        const { get } = loadHarness(t);

        const res = await get();
        assert.equal(res.status, 200);
        assert.equal(res.body.cpuModel, 'Intel(R) Xeon(R) CPU @ 2.20GHz');
    });

    test('reports the kernel UDP buffer caps, read again on every request', async (t) => {
        const caps = { rmem_max: '16777216\n', wmem_max: '212992\n' };
        const realReadFileSync = fs.readFileSync;
        t.mock.method(fs, 'readFileSync', (file, ...rest) => {
            const name = String(file).replace('/proc/sys/net/core/', '');
            if (!String(file).startsWith('/proc/sys/net/core/')) {
                return realReadFileSync(file, ...rest);
            }
            if (caps[name] == null) throw new Error('ENOENT');
            return caps[name];
        });
        const { get } = loadHarness(t);

        const first = await get();
        assert.equal(first.body.rmemMaxBytes, 16777216);
        assert.equal(first.body.wmemMaxBytes, 212992);

        caps.rmem_max = '1048576\n';
        caps.wmem_max = null; // unreadable
        const second = await get();
        assert.equal(second.body.rmemMaxBytes, 1048576, 'a cached response shows the live cap');
        assert.equal(second.body.wmemMaxBytes, null);
    });

    test('a platform that reports no CPUs gets "unknown" instead of an error', async (t) => {
        t.mock.method(os, 'cpus', () => []);
        const { get } = loadHarness(t);

        const res = await get();
        assert.equal(res.status, 200);
        assert.equal(res.body.cpuModel, 'unknown');
    });

    test('multi-line ffmpeg/git output only uses the first line', async (t) => {
        const { get } = loadHarness(t, {
            execImpl: (cmd, _args, _opts, cb) => {
                if (cmd === 'ffmpeg') {
                    return queueMicrotask(() =>
                        cb(null, 'ffmpeg version 6.1.1\nbuilt with gcc\nconfiguration: ...\n', ''),
                    );
                }
                queueMicrotask(() => cb(null, '', ''));
            },
        });

        const res = await get();
        assert.equal(res.body.ffmpeg, '6.1.1');
    });
});
