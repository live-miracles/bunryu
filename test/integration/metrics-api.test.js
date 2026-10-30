'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');
const fs = require('node:fs');

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function makeFakeSrtRelayService(pid) {
    return { getStats: () => ({ pid: pid ?? null }) };
}

// metrics.ts keeps disk/net/cpu/history state at module scope and only starts
// its sampling intervals once ever (metricsStarted guard) — every test needs
// a fully fresh require.
function loadHarness(t, { disks, fetchImpl, relayPid, procStatusByPid = {} } = {}) {
    delete require.cache[require.resolve('../../src/api/metrics')];
    delete require.cache[require.resolve('../../src/utils/procStats')];

    // The data directory's filesystem is whichever directory is not '/'. A filesystem
    // left out of `disks` is unreadable.
    const diskOf = (dir) => (dir === '/' ? disks?.root : disks?.data);
    t.mock.method(fs, 'statfsSync', (dir) => {
        const disk = diskOf(dir);
        if (!disk) throw new Error('ENOENT');
        return { bsize: 1, blocks: disk.total, bavail: disk.available };
    });
    t.mock.method(fs, 'statSync', (dir) => ({ dev: dir === '/' ? 1 : 2 }));

    const originalReadFileSync = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (filePath, ...rest) => {
        const key = String(filePath);
        if (key === '/proc/net/dev') {
            return 'Inter-|   Receive\n face |bytes packets\n  lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\neth0: 5000 10 0 0 0 0 0 0 8000 20 0 0 0 0 0 0\n';
        }
        const statusMatch = key.match(/^\/proc\/(\d+)\/status$/);
        if (statusMatch && procStatusByPid[statusMatch[1]] !== undefined) {
            return procStatusByPid[statusMatch[1]];
        }
        const statMatch = key.match(/^\/proc\/(\d+)\/stat$/);
        if (statMatch && procStatusByPid[statMatch[1]] !== undefined) {
            // Minimal valid /proc/pid/stat: fields after ')' space-separated,
            // utime/stime are the 14th/15th field overall (index 11/12 after ')').
            return `${statMatch[1]} (node) S ${'0 '.repeat(50)}`;
        }
        return originalReadFileSync(filePath, ...rest);
    });

    t.mock.method(globalThis, 'fetch', fetchImpl ?? (async () => jsonResponse({ data: {} })));

    const { registerMetricsApi } = require('../../src/api/metrics');
    const app = express();
    registerMetricsApi(app, makeFakeSrtRelayService(relayPid));
    return {
        system: () => dispatch(app, 'GET', '/api/metrics/system'),
        history: (after) =>
            dispatch(
                app,
                'GET',
                after === undefined
                    ? '/api/metrics/history'
                    : `/api/metrics/history?after=${after}`,
            ),
    };
}

describe('Metrics API integration', () => {
    test('GET /api/metrics/system returns a fully-shaped response on first call', async (t) => {
        const { system } = loadHarness(t, {});
        const res = await system();

        assert.equal(res.status, 200);
        assert.ok(res.body.cpu.cores > 0);
        assert.equal(typeof res.body.cpu.percent, 'number');
        assert.ok(res.body.ram.totalBytes > 0);
        assert.ok(res.body.ram.usedBytes >= 0);
        assert.equal(typeof res.body.net.rxBytesPerSec, 'number');
        assert.equal(typeof res.body.net.txBytesPerSec, 'number');
        assert.ok('node' in res.body);
        assert.ok('srs' in res.body);
        assert.ok('relay' in res.body);
        assert.equal(typeof res.body.uptimeSeconds, 'number');
    });

    test('GET /api/metrics/history includes the synchronous initial sample', async (t) => {
        const { history } = loadHarness(t, {});
        const res = await history();

        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body));
        assert.ok(res.body.length >= 1);
        const sample = res.body[0];
        assert.equal(typeof sample.ts, 'number');
        assert.equal(typeof sample.cpu, 'number');
        assert.equal(typeof sample.ramUsed, 'number');
        assert.equal(typeof sample.ramTotal, 'number');
    });

    test('GET /api/metrics/history?after= returns only newer samples', async (t) => {
        const { history } = loadHarness(t, {});
        const initial = await history();
        const latestTs = initial.body.at(-1).ts;

        const atCursor = await history(latestTs);
        assert.deepEqual(atCursor.body, []);

        const beforeCursor = await history(latestTs - 1);
        assert.deepEqual(beforeCursor.body, initial.body);
    });

    test('disk is the used share of the fuller of the data directory and the root filesystem', async (t) => {
        const { system } = loadHarness(t, {
            disks: {
                root: { total: 100_000, available: 58_000 },
                data: { total: 50_000, available: 5_000 },
            },
        });
        await sleep(20);

        const res = await system();
        assert.deepEqual(res.body.disk, { totalBytes: 50_000, usedBytes: 45_000 });
    });

    test('an unreadable data directory falls back to the root filesystem', async (t) => {
        const { system } = loadHarness(t, {
            disks: { root: { total: 100_000, available: 58_000 } },
        });
        await sleep(20);

        const res = await system();
        assert.deepEqual(res.body.disk, { totalBytes: 100_000, usedBytes: 42_000 });
    });

    test('no readable filesystem leaves disk stats null instead of crashing', async (t) => {
        const { system } = loadHarness(t, {});
        await sleep(20);

        const res = await system();
        assert.equal(res.body.disk, null);
    });

    test('node process RAM usage is surfaced from /proc/<own-pid>/status', async (t) => {
        const { system } = loadHarness(t, {
            procStatusByPid: { [process.pid]: 'VmRSS:  123456 kB\n' },
        });

        const res = await system();
        assert.equal(res.body.node.ramBytes, 123456 * 1024);
        // First-ever CPU sample has no prior baseline to diff against.
        assert.equal(res.body.node.cpuPercent, null);
    });

    test('SRS process usage converts cpu_percent (0..1 fraction) and mem_kbyte correctly', async (t) => {
        const { system } = loadHarness(t, {
            fetchImpl: async () =>
                jsonResponse({ data: { self: { cpu_percent: 0.055, mem_kbyte: 20000 } } }),
        });
        await sleep(20);

        const res = await system();
        assert.ok(Math.abs(res.body.srs.cpuPercent - 5.5) < 0.001);
        assert.equal(res.body.srs.ramBytes, 20000 * 1024);
    });

    test('an SRS summaries fetch failure yields null usage instead of stale/crashed data', async (t) => {
        const { system } = loadHarness(t, {
            fetchImpl: async () => {
                throw new Error('ECONNREFUSED');
            },
        });
        await sleep(20);

        const res = await system();
        assert.deepEqual(res.body.srs, { cpuPercent: null, ramBytes: null });
    });

    test('an SRS summaries HTTP error status yields null usage', async (t) => {
        const { system } = loadHarness(t, {
            fetchImpl: async () => jsonResponse({}, false, 500),
        });
        await sleep(20);

        const res = await system();
        assert.deepEqual(res.body.srs, { cpuPercent: null, ramBytes: null });
    });

    test('relay usage is null when the relay has no pid (not running)', async (t) => {
        const { system } = loadHarness(t, { relayPid: null });
        const res = await system();
        assert.deepEqual(res.body.relay, { cpuPercent: null, ramBytes: null });
    });

    test('relay usage reads RAM from the relay pid when one is reported', async (t) => {
        const { system } = loadHarness(t, {
            relayPid: 5555,
            procStatusByPid: { 5555: 'VmRSS:  9000 kB\n' },
        });

        const res = await system();
        assert.equal(res.body.relay.ramBytes, 9000 * 1024);
    });

    test('net stats stay zero on the very first sample (no prior baseline for a rate)', async (t) => {
        const { system } = loadHarness(t, {});
        const res = await system();
        assert.equal(res.body.net.rxBytesPerSec, 0);
        assert.equal(res.body.net.txBytesPerSec, 0);
    });
});
