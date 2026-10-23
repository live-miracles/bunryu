'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

const {
    registerSrsHooks,
    registerSrsLogsApi,
    registerRejectedPublishesApi,
} = require('../../src/api/srs');
const { createInputState } = require('../../src/services/inputState');
const { createRejectedPublishes } = require('../../src/services/rejectedPublishes');
const childProcess = require('node:child_process');

class MockRequest extends Readable {
    constructor(method, url, body) {
        super();
        this.method = method;
        this.url = url;
        this.headers = {};
        this.socket = { remoteAddress: '127.0.0.1' };
        this.connection = this.socket;
        this.body = body;
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

function dispatch(app, method, route, body) {
    return new Promise((resolve, reject) => {
        app.handle(new MockRequest(method, route, body), new MockResponse(resolve), reject);
    });
}

function createHarness(assignedKeys, unassignedKeys = [], outputs = []) {
    const app = express();
    const calls = { listStreamKeys: 0, listPipelines: 0, listOutputs: 0 };
    let configRev = 1;
    const db = {
        getConfigRev: () => configRev,
        listStreamKeys: () => {
            calls.listStreamKeys++;
            return [...assignedKeys, ...unassignedKeys].map((key, index) => ({
                id: index + 1,
                slot: index + 1,
                key,
            }));
        },
        listOutputs: () => {
            calls.listOutputs++;
            return outputs;
        },
        listPipelines: () => {
            calls.listPipelines++;
            return assignedKeys.map((streamKey, index) => ({
                id: index + 1,
                name: `Pipeline ${index + 1}`,
                streamKey,
                streamKeyId: index + 1,
            }));
        },
    };
    const inputState = createInputState();
    const rejectedPublishes = createRejectedPublishes();
    const events = [];
    const diagnostics = {
        event: (event, fields = {}) => events.push({ event, ...fields }),
        close: async () => {},
    };
    registerSrsHooks(app, db, inputState, rejectedPublishes, diagnostics);
    registerRejectedPublishesApi(app, rejectedPublishes);
    return {
        calls,
        bumpConfigRev: () => {
            configRev++;
        },
        rejected: () => dispatch(app, 'GET', '/api/rejected-publishes'),
        publish: (body) => dispatch(app, 'POST', '/api/srs/on_publish', body),
        play: (body) => dispatch(app, 'POST', '/api/srs/on_play', body),
        ready: () => dispatch(app, 'GET', '/api/ready'),
        inputState,
        events,
    };
}

describe('SRS publish hook integration', () => {
    test('the hook listener does not serve readiness (that stays on the dashboard port)', async () => {
        const harness = createHarness([]);

        await assert.rejects(harness.ready());
    });

    test('a non-IP "ip" never reaches logs or the dashboard list (no log forging)', async (t) => {
        const lines = [];
        t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
        const harness = createHarness([]);
        const forged = '6.6.6.6\n[srs-hook] allowed publish from 10.0.0.1: key01_<redacted>';

        const res = await harness.publish({ app: 'live', stream: 'key01_deadbeef', ip: forged });
        const rejected = await harness.rejected();

        assert.equal(res.status, 403);
        assert.ok(lines.length > 0);
        assert.ok(
            lines.every((l) => !l.includes('\n')),
            'no embedded newline in any log line',
        );
        assert.ok(lines.every((l) => !l.includes('allowed publish')));
        assert.equal(rejected.body.rejected[0].ip, null);
    });

    test('an invalid ip on a play is treated as non-loopback and refused (fail closed)', async () => {
        const harness = createHarness([]);

        const res = await harness.play({ app: 'live', stream: 'key01_good', ip: '127.0.0.1\nx' });

        assert.equal(res.status, 403);
    });

    test('allows an assigned stream key', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ app: 'live', stream: 'key01_good' });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { code: 0 });
    });

    test('rejects an unassigned stream key', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ app: 'live', stream: 'key99_bad' });

        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { code: 403 });
    });

    test('records a rejected unassigned key, listing only its label', async () => {
        const harness = createHarness(['key01_good'], ['key02_spare']);
        const logs = [];
        const origLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
        try {
            await harness.publish({
                app: 'live',
                stream: 'key02_spare',
                tcUrl: 'srt://127.0.0.1/live',
                ip: '127.0.0.1',
            });
            await harness.publish({ app: 'live', stream: 'key02_spare', ip: '127.0.0.1' });
        } finally {
            console.log = origLog;
        }

        const res = await harness.rejected();
        assert.equal(res.body.rejected.length, 1);
        const [entry] = res.body.rejected;
        assert.equal(entry.label, 'key02');
        assert.equal(entry.reason, 'unassigned');
        assert.equal(entry.protocol, 'rtmp');
        assert.equal(entry.attempts, 2);
        assert.ok(!JSON.stringify(res.body).includes('spare'));
        // Repeats are throttled; the logged line carries the full stream name.
        const rejectedLogs = logs.filter((l) => l.includes('rejected publish'));
        assert.equal(rejectedLogs.length, 1);
        assert.ok(rejectedLogs[0].includes('"key02_spare"'));
    });

    test('flags a stale key (right label, wrong secret) as unknown', async () => {
        const harness = createHarness(['key01_good']);

        await harness.publish({ app: 'live', stream: 'key01_old', ip: '203.0.113.5' });

        const [entry] = (await harness.rejected()).body.rejected;
        assert.equal(entry.label, 'key01');
        assert.equal(entry.reason, 'unknown');
        assert.equal(entry.ip, '203.0.113.5');
    });

    test('lists names that are not shaped like a stream key only as an aggregate', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ app: 'live', stream: 'random-name' });

        assert.equal(res.status, 403);
        const { rejected } = (await harness.rejected()).body;
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason, 'unrecognized');
        assert.equal(rejected[0].label, '');
        assert.ok(!JSON.stringify(rejected).includes('random-name'));
    });

    test('records and logs a publish with no stream name instead of failing silently', async () => {
        const harness = createHarness(['key01_good']);
        const logs = [];
        const origLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
        let res;
        try {
            res = await harness.publish({ app: 'live', tcUrl: 'srt://127.0.0.1/live' });
        } finally {
            console.log = origLog;
        }

        assert.equal(res.status, 400);
        assert.ok(logs.some((l) => l.includes('missing stream name')));
        const { rejected } = (await harness.rejected()).body;
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].protocol, 'srt');
        assert.equal(rejected[0].reason, 'unrecognized');
    });

    test('allowed publishes are not listed as rejected', async () => {
        const harness = createHarness(['key01_good']);

        await harness.publish({ app: 'live', stream: 'key01_good' });

        assert.deepEqual((await harness.rejected()).body, { rejected: [], omitted: 0 });
    });

    test('records a rejected outside play (e.g. SRT id missing m=publish) apart from publishes', async () => {
        const harness = createHarness(['key01_good']);
        const logs = [];
        const origLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
        let res;
        try {
            res = await harness.play({
                app: 'live',
                stream: 'key01_good',
                ip: '203.0.113.5',
                tcUrl: 'srt://203.0.113.9/live',
            });
            await harness.play({
                app: 'live',
                stream: 'abc',
                ip: '203.0.113.5',
                tcUrl: 'srt://x/live',
            });
        } finally {
            console.log = origLog;
        }

        assert.equal(res.status, 403);
        const { rejected } = (await harness.rejected()).body;
        assert.equal(rejected.length, 2);
        const keyed = rejected.find((r) => r.label === 'key01');
        assert.equal(keyed.kind, 'play');
        assert.equal(keyed.reason, 'assigned');
        assert.equal(keyed.protocol, 'srt');
        const aggregate = rejected.find((r) => r.reason === 'unrecognized');
        assert.equal(aggregate.kind, 'play');
        assert.ok(!JSON.stringify(rejected).includes('good'));
        assert.ok(!JSON.stringify(rejected).includes('abc'));
        assert.ok(logs.some((l) => l.includes('rejected play') && l.includes('"key01_good"')));
        assert.ok(logs.some((l) => l.includes('rejected play') && l.includes('"abc"')));
    });

    test('loopback plays (the app own ffmpeg) are allowed and not recorded', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.play({ app: 'live', stream: 'key01_good', ip: '127.0.0.1' });

        assert.equal(res.status, 200);
        assert.deepEqual((await harness.rejected()).body, { rejected: [], omitted: 0 });
    });

    test('does not query the DB per rejected attempt for key labelling', async () => {
        const harness = createHarness(['key01_good'], ['key02_spare']);
        const rejectionsBefore = harness.calls.listStreamKeys;
        const pipelinesBefore = harness.calls.listPipelines;

        for (let i = 0; i < 50; i++) {
            await harness.publish({ app: 'live', stream: 'key02_spare', ip: '203.0.113.5' });
            await harness.play({ app: 'live', stream: 'key02_spare', ip: '203.0.113.5' });
        }

        // One rebuild of the key sets; the authorization path itself still reads
        // pipelines on every publish (unchanged behavior).
        assert.equal(harness.calls.listStreamKeys - rejectionsBefore, 1);
        assert.equal(harness.calls.listPipelines - pipelinesBefore, 50 + 1);

        // A config change (e.g. regenerated keys) refreshes the labelling.
        harness.bumpConfigRev();
        await harness.publish({ app: 'live', stream: 'key02_spare', ip: '203.0.113.5' });
        assert.equal(harness.calls.listStreamKeys - rejectionsBefore, 2);
    });

    test('names that are not key-shaped never trigger a key lookup', async () => {
        const harness = createHarness(['key01_good']);
        const before = harness.calls.listStreamKeys;

        for (let i = 0; i < 20; i++) {
            await harness.publish({ app: 'live', stream: `junk-${i}`, ip: '203.0.113.5' });
            await harness.play({ app: 'live', stream: `junk-${i}`, ip: '203.0.113.5' });
        }

        assert.equal(harness.calls.listStreamKeys, before);
    });

    test('caps the rows returned and reports how many were left out', async () => {
        const harness = createHarness(['key01_good']);

        for (let i = 10; i < 50; i++) {
            await harness.publish({ app: 'live', stream: `key${i}_x`, ip: '203.0.113.5' });
        }

        const { rejected, omitted } = (await harness.rejected()).body;
        assert.equal(rejected.length, 25);
        assert.equal(omitted, 15);
    });

    test('rejects a cross-protocol publish to an already-live pipeline', async () => {
        const harness = createHarness(['key01_good']);
        harness.inputState.setPipelineState(1, true, 'rtmp');

        const res = await harness.publish({
            app: 'live',
            stream: 'key01_good',
            tcUrl: 'srt://10.0.0.1/live',
        });

        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { code: 403 });
    });

    test('a retried cross-protocol publish is logged once per window, with diagnostics', async (t) => {
        const harness = createHarness(['key01_good']);
        harness.inputState.setPipelineState(1, true, 'rtmp');
        const lines = [];
        t.mock.method(console, 'log', (line) => lines.push(String(line)));

        for (let i = 0; i < 5; i += 1) {
            await harness.publish({
                app: 'live',
                stream: 'key01_good',
                tcUrl: 'srt://10.0.0.1/live',
                ip: '127.0.0.1',
            });
        }

        assert.equal(lines.filter((l) => l.includes('already live via rtmp')).length, 1);
        const rejected = harness.events.filter((e) => e.event === 'publish-rejected');
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].pipelineId, 1);
        assert.equal(rejected[0].protocol, 'srt');
        assert.match(rejected[0].why, /already live via rtmp/);
    });

    test('an allowed publish is recorded in diagnostics', async () => {
        const harness = createHarness(['key01_good']);

        await harness.publish({ app: 'live', stream: 'key01_good', ip: '203.0.113.5' });

        const allowed = harness.events.filter((e) => e.event === 'publish-allowed');
        assert.equal(allowed.length, 1);
        assert.equal(allowed[0].pipelineId, 1);
        assert.equal(allowed[0].protocol, 'rtmp');
        assert.equal(allowed[0].ip, '203.0.113.5');
    });

    test('allows a same-protocol republish to an already-live pipeline (reconnect)', async () => {
        const harness = createHarness(['key01_good']);
        harness.inputState.setPipelineState(1, true, 'rtmp');

        const res = await harness.publish({
            app: 'live',
            stream: 'key01_good',
            tcUrl: 'rtmp://10.0.0.1/live',
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { code: 0 });
    });

    test('allows a publish to a currently-idle pipeline regardless of protocol', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({
            app: 'live',
            stream: 'key01_good',
            tcUrl: 'srt://10.0.0.1/live',
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { code: 0 });
    });

    test('rejects a publish with no stream field at all', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ app: 'live' });

        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { code: 400 });
    });

    test('rejects a publish with an empty-string stream', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ app: 'live', stream: '' });

        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { code: 400 });
    });

    test('rejecting a publish with no hookApp does not crash (skips the kick call)', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.publish({ stream: 'key99_bad' });

        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { code: 403 });
    });

    test('rejects a very long, non-matching stream value without crashing', async () => {
        const harness = createHarness(['key01_good']);
        const longStream = 'x'.repeat(10_000);

        const res = await harness.publish({ app: 'live', stream: longStream });

        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { code: 403 });
    });

    test('a stream key match is case-sensitive and exact (no substring/prefix match)', async () => {
        const harness = createHarness(['key01_good']);

        for (const stream of ['KEY01_GOOD', 'key01_goodextra', 'key01_goo']) {
            const res = await harness.publish({ app: 'live', stream });
            assert.equal(res.status, 403);
        }
    });

    test('debounces repeated kicks for the same app/stream, but not across different streams', async (t) => {
        let fetchCalls = 0;
        t.mock.method(globalThis, 'fetch', async () => {
            fetchCalls += 1;
            return { ok: true, json: async () => ({ clients: [] }) };
        });
        const harness = createHarness(['key01_good']);

        await harness.publish({ app: 'live', stream: 'key99_bad' });
        await harness.publish({ app: 'live', stream: 'key99_bad' });
        await harness.publish({ app: 'live', stream: 'key99_bad' });
        await harness.publish({ app: 'live', stream: 'key98_bad' });

        // kickSrsClientsByStream is fire-and-forget from the handler's point of
        // view; the mocked fetch's own body still runs synchronously up to its
        // first await when invoked, so the count is already settled here, but
        // flush the microtask queue once for safety.
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(fetchCalls, 2);
    });
});

describe('SRS publish hook: internal app (shared encodes)', () => {
    const rendition = (overrides = {}) => ({
        id: '1-2',
        pipelineId: 1,
        desiredState: 'running',
        url: 'rtmp://127.0.0.1:21935/internal/r1_720p_a0',
        videoEncoding: '720p',
        audioEncoding: '0',
        ...overrides,
    });
    const publish = (harness, overrides = {}) =>
        harness.publish({
            app: 'internal',
            stream: 'r1_720p_a0',
            ip: '127.0.0.1',
            tcUrl: 'rtmp://127.0.0.1:21935/internal',
            ...overrides,
        });

    test('accepts a loopback publish for a running rendition', async () => {
        const harness = createHarness(['key01_good'], [], [rendition()]);

        const res = await publish(harness);

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { code: 0 });
    });

    test('accepts IPv6 and mapped-IPv4 loopback', async () => {
        const harness = createHarness(['key01_good'], [], [rendition()]);

        for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.5']) {
            const res = await publish(harness, { ip });
            assert.equal(res.status, 200, ip);
        }
    });

    test('rejects a publish from a non-loopback address without touching the DB', async () => {
        const harness = createHarness(['key01_good'], [], [rendition()]);

        const res = await publish(harness, { ip: '203.0.113.9' });

        assert.equal(res.status, 403);
        assert.equal(harness.calls.listOutputs, 0);
    });

    test('rejects an unknown stream name', async () => {
        const harness = createHarness(['key01_good'], [], [rendition()]);

        const res = await publish(harness, { stream: 'r1_1080p_a0' });

        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { code: 403 });
    });

    test('rejects a rendition whose desired state is stopped', async () => {
        const harness = createHarness(['key01_good'], [], [rendition({ desiredState: 'stopped' })]);

        const res = await publish(harness);

        assert.equal(res.status, 403);
    });

    test('rejects a stream that is not a rendition row (a user output with the same URL tail)', async () => {
        const harness = createHarness(
            ['key01_good'],
            [],
            [rendition({ url: 'rtmp://example.com/internal/r1_720p_a0' })],
        );

        const res = await publish(harness);

        assert.equal(res.status, 403);
    });

    test('rejects a pipeline key published under the internal app', async () => {
        const harness = createHarness(['key01_good'], [], [rendition()]);

        const res = await publish(harness, { stream: 'key01_good' });

        assert.equal(res.status, 403);
    });

    test('rejects an SRT publish into the internal app even from loopback', async () => {
        const harness = createHarness(['key01_good'], [], [rendition()]);

        const res = await publish(harness, { tcUrl: 'srt://127.0.0.1:10080' });

        assert.equal(res.status, 403);
    });

    test('a rejected internal publish is recorded and listed', async () => {
        const harness = createHarness(['key01_good'], [], [rendition()]);

        await publish(harness, { stream: 'bogus', ip: '203.0.113.9' });
        const list = await harness.rejected();

        assert.equal(list.body.rejected.length + list.body.omitted > 0, true);
    });

    test('the live app behaves as before when renditions exist', async () => {
        const harness = createHarness(['key01_good'], [], [rendition()]);

        const ok = await harness.publish({ app: 'live', stream: 'key01_good' });
        const bad = await harness.publish({ app: 'live', stream: 'r1_720p_a0' });

        assert.equal(ok.status, 200);
        assert.equal(bad.status, 403);
        assert.equal(harness.calls.listOutputs, 0);
    });
});

describe('SRS play hook integration', () => {
    test('allows plays from loopback (app ffmpeg pulls)', async () => {
        const harness = createHarness(['key01_good']);

        for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
            const res = await harness.play({ app: 'live', stream: 'key01_good', ip });
            assert.equal(res.status, 200);
            assert.deepEqual(res.body, { code: 0 });
        }
    });

    test('rejects plays from any non-loopback address', async () => {
        const harness = createHarness(['key01_good']);

        for (const ip of ['203.0.113.5', '10.0.0.4', '::ffff:203.0.113.5', undefined]) {
            const res = await harness.play({ app: 'live', stream: 'key01_good', ip });
            assert.equal(res.status, 403);
            assert.deepEqual(res.body, { code: 403 });
        }
    });

    test('rejects an ip that merely starts with a loopback-like prefix but is not localhost', async () => {
        const harness = createHarness(['key01_good']);

        // '127' without the trailing dot must not match the '127.' prefix check.
        for (const ip of ['1270.0.0.1', '127', '::ffff:127', 'localhost']) {
            const res = await harness.play({ app: 'live', stream: 'key01_good', ip });
            assert.equal(res.status, 403);
        }
    });

    test('loopback plays succeed even with no stream field (hook does not validate stream on play)', async () => {
        const harness = createHarness(['key01_good']);

        const res = await harness.play({ app: 'live', ip: '127.0.0.1' });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { code: 0 });
    });
});

describe('SRS logs API integration', () => {
    function createLogsHarness(t, { execError, execOutput = '' } = {}) {
        const app = express();
        const events = [{ source: 'srs', type: 'recovered', message: 'test event', ts: 1 }];
        t.mock.method(childProcess, 'execFile', (_cmd, _args, _opts, cb) => {
            queueMicrotask(() => cb(execError ?? null, execOutput, ''));
        });
        registerSrsLogsApi(app, () => events);
        return {
            events,
            get: () => dispatch(app, 'GET', '/api/srs-logs'),
        };
    }

    test('returns app-level srs events alongside empty log tails when journalctl is unavailable', async (t) => {
        const harness = createLogsHarness(t, {
            execError: new Error('journalctl: command not found'),
        });

        const res = await harness.get();

        assert.equal(res.status, 200);
        assert.deepEqual(res.body.events, harness.events);
        assert.deepEqual(res.body.srs, { lines: [], source: 'none' });
        assert.deepEqual(res.body.dashboard, { lines: [], source: 'none' });
        assert.deepEqual(res.body.relay, { lines: [], source: 'none' });
    });

    test('parses non-empty journal output into lines with source=journal', async (t) => {
        const harness = createLogsHarness(t, { execOutput: 'line one\nline two\n\n' });

        const res = await harness.get();

        assert.equal(res.status, 200);
        assert.deepEqual(res.body.srs, { lines: ['line one', 'line two'], source: 'journal' });
        assert.deepEqual(res.body.dashboard, {
            lines: ['line one', 'line two'],
            source: 'journal',
        });
    });

    test('blank-only journal output is treated as no logs (source=none)', async (t) => {
        const harness = createLogsHarness(t, { execOutput: '\n\n   \n' });

        const res = await harness.get();

        assert.deepEqual(res.body.srs, { lines: [], source: 'none' });
    });
});
