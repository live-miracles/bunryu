'use strict';

const { after, describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    hasBondedRelayPublishConflict,
    isProbeUsable,
    isLoopbackIp,
    localSrtOutputTargetsStream,
} = require('../src/services/health');

describe('health media probe validation', () => {
    test('accepts video with codec and dimensions', () => {
        assert.equal(
            isProbeUsable({
                video: {
                    codec: 'h264',
                    width: 1920,
                    height: 1080,
                    fps: 50,
                    profile: 'Main',
                    level: '4.2',
                    fieldOrder: 'progressive',
                },
                audio: null,
                audioTracks: [],
            }),
            true,
        );
    });

    test('rejects missing or dimensionless video', () => {
        assert.equal(isProbeUsable(null), false);
        assert.equal(isProbeUsable({ video: null, audio: null, audioTracks: [] }), false);
        assert.equal(
            isProbeUsable({
                video: {
                    codec: 'h264',
                    width: 0,
                    height: 0,
                    fps: null,
                    profile: '',
                    level: '',
                    fieldOrder: null,
                },
                audio: null,
                audioTracks: [],
            }),
            false,
        );
    });
});

describe('health local SRT output detection', () => {
    test('matches local SRS SRT outputs by stream resource', () => {
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://127.0.0.1:10080?streamid=#!::r=live/key01,m=publish',
                'key01',
            ),
            true,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://localhost:10080?streamid=%23!::r=live/key01,m=publish',
                'key01',
            ),
            true,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://localhost:10080?streamid=%23%21%3A%3Ar%3Dlive%2Fkey01%2Cm%3Dpublish',
                'key01',
            ),
            true,
        );
    });

    test('ignores non-local, wrong-port, and different-stream SRT outputs', () => {
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://192.0.2.10:10080?streamid=#!::r=live/key01,m=publish',
                'key01',
            ),
            false,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://127.0.0.1:10081?streamid=#!::r=live/key01,m=publish',
                'key01',
            ),
            false,
        );
        assert.equal(
            localSrtOutputTargetsStream(
                'srt://127.0.0.1:10080?streamid=#!::r=live/key02,m=publish',
                'key01',
            ),
            false,
        );
    });
});

describe('health loopback ip detection', () => {
    test('accepts IPv4 and IPv6 loopback forms', () => {
        assert.equal(isLoopbackIp('127.0.0.1'), true);
        assert.equal(isLoopbackIp('::1'), true);
        assert.equal(isLoopbackIp('::ffff:127.0.0.1'), true);
    });

    test('rejects non-loopback, malformed, and empty values', () => {
        assert.equal(isLoopbackIp('127.0.0.2'), false);
        assert.equal(isLoopbackIp('10.0.0.1'), false);
        assert.equal(isLoopbackIp(''), false);
        assert.equal(isLoopbackIp(null), false);
        assert.equal(isLoopbackIp(undefined), false);
    });
});

describe('health bonded relay publish conflict detection', () => {
    test('flags any existing pipeline input when bonded relay input is active but not accepted', () => {
        assert.equal(
            hasBondedRelayPublishConflict({
                inputConnected: true,
                relayInputActive: true,
                relayAcceptedBySrs: false,
            }),
            true,
        );
    });

    test('does not flag idle pipelines or relay publishers accepted by SRS', () => {
        assert.equal(
            hasBondedRelayPublishConflict({
                inputConnected: false,
                relayInputActive: true,
                relayAcceptedBySrs: false,
            }),
            false,
        );
        assert.equal(
            hasBondedRelayPublishConflict({
                inputConnected: true,
                relayInputActive: false,
                relayAcceptedBySrs: false,
            }),
            false,
        );
        assert.equal(
            hasBondedRelayPublishConflict({
                inputConnected: true,
                relayInputActive: true,
                relayAcceptedBySrs: true,
            }),
            false,
        );
    });
});

// ── createHealthService poll orchestration ─────────────

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-health-'));
const originalCwd = process.cwd();

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockRequest extends Readable {
    constructor() {
        super();
        this.method = 'GET';
        this.url = '/api/health';
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
            this.resolve(text ? JSON.parse(text) : undefined);
            if (callback) callback();
            return this;
        };
    }
    _write(chunk, _encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }
}

function getSnapshot(app) {
    return new Promise((resolve, reject) => {
        app.handle(new MockRequest(), new MockResponse(resolve), reject);
    });
}

function jsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function makeFakeDb(pipelines, outputs = []) {
    const logs = [];
    return {
        logs,
        appendLogThrows: false,
        getConfigRev: () => 1,
        listPipelines: () => pipelines,
        listOutputs: () => outputs,
        appendPipelineLog(pipelineId, event, message) {
            if (this.appendLogThrows) throw new Error('db busy');
            logs.push({ id: logs.length + 1, pipelineId, event, message });
            return logs.length;
        },
        updatePipelineLog(pipelineId, id, message) {
            const row = logs.find((l) => l.id === id && l.pipelineId === pipelineId);
            if (row) row.message = message;
            return !!row;
        },
    };
}

function makeFakeOutputService() {
    const restarts = [];
    return {
        restarts,
        getStats: () => ({
            status: 'stopped',
            pid: null,
            bitrateKbps: null,
            startedAtMs: null,
            failures: 0,
            warningReason: null,
            memoryUsageBytes: null,
            memoryLimitBytes: null,
            cpuPercent: null,
        }),
        restartPipelineOutputs(pipelineId, staggerBase) {
            restarts.push({ pipelineId, staggerBase });
            return 0;
        },
        formatRestarts: [],
        restartRunningOutputs(pipelineId, why, startedBeforeMs) {
            this.formatRestarts.push({ pipelineId, why, startedBeforeMs });
            return 3;
        },
    };
}

function makeFakeSrtRelay() {
    return {
        getStats: () => ({ status: 'stopped', lastError: null }),
        getStreamStatus: () => makeBondingStatus({ inputActive: false }),
    };
}

// The SRS/relay rows of the Server events table, without any host resource rows a
// real /proc reading on the machine running the tests could add.
function srsServiceEvents(service) {
    return service.getSrsEvents().filter((e) => e.source !== 'host');
}

function makeDiagnosticsSpy() {
    const events = [];
    return {
        events,
        event(event, fields = {}) {
            events.push({ event, ...fields });
        },
        close() {},
    };
}

// Fills in the full SrtRelayStreamStatus shape (see src/services/srtRelay.ts)
// so tests only need to specify the fields a given scenario cares about.
function makeBondingStatus(overrides = {}) {
    const { input: inputOverrides, output: outputOverrides, ...rest } = overrides;
    return {
        inputActive: true,
        outputConnected: true,
        retryFailures: 0,
        forwardedPackets: 0,
        forwardedBytes: 0,
        lastPacketAt: null,
        lastInputPacketAt: null,
        lastErrorAt: null,
        lastError: null,
        ...rest,
        input: {
            bonded: true,
            peer: null,
            recvPacketsTotal: 0,
            recvUniquePacketsTotal: 0,
            recvLossTotal: 0,
            recvDropTotal: 0,
            retransTotal: 0,
            rttMs: null,
            latencyMs: 100,
            bandwidthMbps: null,
            recvRateMbps: null,
            belatedTotal: 0,
            belatedAvgMs: null,
            undecryptTotal: null,
            reorderDistance: null,
            rcvBufMs: null,
            legs: [],
            ...inputOverrides,
        },
        output: {
            sentPacketsTotal: 0,
            sendLossTotal: 0,
            sendDropTotal: 0,
            retransTotal: 0,
            rttMs: null,
            latencyMs: null,
            bandwidthMbps: null,
            sendRateMbps: null,
            undecryptTotal: null,
            sndBufMs: null,
            ...outputOverrides,
        },
    };
}

function makeLeg(overrides = {}) {
    return {
        ip: '203.0.113.10',
        port: 10081,
        state: 'running',
        rttMs: 5,
        latencyMs: 100,
        recvPacketsTotal: 0,
        recvUniquePacketsTotal: 0,
        recvLossTotal: 0,
        recvDropTotal: 0,
        retransTotal: 0,
        bandwidthMbps: 10,
        recvRateMbps: 1,
        belatedTotal: 0,
        belatedAvgMs: 0,
        undecryptTotal: 0,
        reorderDistance: 0,
        rcvBufMs: 100,
        ...overrides,
    };
}

// A relay double whose getStreamStatus() result the test can swap out between
// polls to simulate the bonded relay's stats changing over time.
function makeFakeSrtRelayMutable(initialStatus) {
    let status = initialStatus;
    return {
        setStatus(next) {
            status = next;
        },
        getStats: () => ({ status: 'running', lastError: null }),
        getStreamStatus: () => status,
    };
}

async function tickPoll(t, ms = 5000) {
    t.mock.timers.tick(ms);
    await sleep(20);
}

function makeFakeInputState() {
    const live = new Map();
    const protocol = new Map();
    return {
        setSrsReachable() {},
        setPipelineState(id, isLive, proto) {
            live.set(id, isLive);
            if (proto) protocol.set(id, proto);
            else protocol.delete(id);
        },
        setInputResolution() {},
        clearPipeline(id) {
            live.delete(id);
            protocol.delete(id);
        },
        isLive: (id) => live.get(id) ?? false,
        getProtocol: (id) => protocol.get(id) ?? null,
    };
}

function loadHealthService(t) {
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
    // No pipeline in these tests reaches the ffprobe-scheduling branch with a
    // real url unless explicitly connected+protocol'd; guard it anyway so a
    // real ffprobe binary is never shelled out to during this suite.
    t.mock.method(childProcess, 'execFile', (_cmd, _args, _opts, cb) => {
        queueMicrotask(() => cb(new Error('ffprobe disabled in test'), '', ''));
    });
    delete require.cache[require.resolve('../src/services/health')];
    delete require.cache[require.resolve('../src/utils/srsConfig')];
    return require('../src/services/health').createHealthService;
}

describe('createHealthService poll orchestration', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/health')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
        delete require.cache[require.resolve('../src/utils/srsConfig')];
    });

    test('marks srsReachable false and logs a down event when the streams fetch rejects', async (t) => {
        t.mock.method(globalThis, 'fetch', async () => {
            throw new Error('ECONNREFUSED');
        });
        const createHealthService = loadHealthService(t);
        const db = makeFakeDb([]);
        const service = createHealthService(
            db,
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);

        const snapshot = await getSnapshot(app);
        assert.equal(snapshot.srsReachable, false);
        const events = srsServiceEvents(service);
        assert.equal(events.length, 1);
        assert.equal(events[0].source, 'srs');
        assert.equal(events[0].type, 'problem');
        assert.match(events[0].message, /ECONNREFUSED/);

        service.shutdown();
    });

    test('a poll that throws is recorded and does not reject unhandled', async (t) => {
        t.mock.method(globalThis, 'fetch', async () => {
            throw new Error('ECONNREFUSED');
        });
        const createHealthService = loadHealthService(t);
        const db = makeFakeDb([]);
        db.listPipelines = () => {
            throw new Error('database is locked');
        };
        const unhandled = [];
        const onUnhandled = (reason) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        t.after(() => process.off('unhandledRejection', onUnhandled));
        const events = [];
        const service = createHealthService(
            db,
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            { event: (event, fields) => events.push({ event, ...fields }), close: async () => {} },
        );

        service.start();
        await sleep(20);
        service.shutdown();

        assert.deepEqual(unhandled, []);
        const failed = events.find((e) => e.event === 'health-poll-failed');
        assert.ok(failed, 'expected a health-poll-failed diagnostics event');
        assert.match(failed.error, /database is locked/);
    });

    test('does not log a second down event on consecutive unreachable polls', async (t) => {
        t.mock.method(globalThis, 'fetch', async () => {
            throw new Error('down');
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);
        const snap1 = await getSnapshot(app);
        assert.equal(snap1.srsReachable, false);
        assert.equal(srsServiceEvents(service).length, 1);

        service.shutdown();
    });

    test('a malformed (non-JSON) streams response is treated as unreachable, not a crash', async (t) => {
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) {
                return { ok: true, status: 200, json: async () => JSON.parse('not json') };
            }
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);

        const snapshot = await getSnapshot(app);
        assert.equal(snapshot.srsReachable, false);

        service.shutdown();
    });

    test('a clients-endpoint failure alone does not flip srsReachable false (streams endpoint is load-bearing)', async (t) => {
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) {
                return jsonResponse({ code: 0, streams: [] });
            }
            throw new Error('clients endpoint down');
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);

        const snapshot = await getSnapshot(app);
        assert.equal(snapshot.srsReachable, true);

        service.shutdown();
    });

    // POLL_INTERVAL_MS (5s) is not configurable, so these two tests fake only
    // 'setInterval' to fire the second poll deterministically without a real
    // 5s wait, while leaving setTimeout/setImmediate real so the async fetch
    // chain and ffprobe scheduling underneath each poll still resolve normally.
    test('logs an up event once SRS becomes reachable again after an outage', async (t) => {
        let failing = true;
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (failing) throw new Error('down');
            if (String(url).includes('/streams/')) return jsonResponse({ code: 0, streams: [] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);
        assert.equal((await getSnapshot(app)).srsReachable, false);
        assert.equal(srsServiceEvents(service).length, 1);

        failing = false;
        t.mock.timers.tick(5000);
        await sleep(20);

        assert.equal((await getSnapshot(app)).srsReachable, true);
        const events = srsServiceEvents(service);
        assert.equal(events.length, 2);
        assert.equal(events[1].type, 'recovered');

        service.shutdown();
    });

    test('hides a pipeline as offline during an SRS outage even though it was live moments before', async (t) => {
        let reachable = true;
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (!reachable) throw new Error('down');
            if (String(url).includes('/streams/')) {
                return jsonResponse({
                    code: 0,
                    streams: [
                        {
                            id: 's1',
                            name: 'key01',
                            vhost: '__defaultVhost__',
                            app: 'live',
                            tcUrl: 'rtmp://x/live',
                            live_ms: 0,
                            publish: { active: true, cid: 'cid-1' },
                            kbps: { recv_30s: 100, send_30s: 100 },
                            clients: 1,
                            frames: 0,
                            recv_bytes: 0,
                            send_bytes: 0,
                        },
                    ],
                });
            }
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const db = makeFakeDb([pipeline]);
        const service = createHealthService(
            db,
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);
        const liveSnap = await getSnapshot(app);
        assert.equal(liveSnap.pipelines['1'].input.connected, true);
        assert.equal(liveSnap.pipelines['1'].input.live, true);
        assert.ok(db.logs.some((l) => l.event === 'online'));

        reachable = false;
        t.mock.timers.tick(5000);
        await sleep(20);

        const outageSnap = await getSnapshot(app);
        assert.equal(outageSnap.srsReachable, false);
        // Displayed state must not show a stale "green" input while SRS
        // itself is unreachable, even though the pipeline was live seconds
        // ago and no offline log entry has fired (no false transition).
        assert.equal(outageSnap.pipelines['1'].input.connected, false);
        assert.equal(outageSnap.pipelines['1'].input.live, false);
        assert.equal(
            db.logs.filter((l) => l.event === 'offline').length,
            0,
            'an SRS outage must not itself log a pipeline offline transition',
        );

        service.shutdown();
    });

    test('does not crash the poll loop when appendPipelineLog throws', async (t) => {
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) {
                return jsonResponse({
                    code: 0,
                    streams: [
                        {
                            id: 's1',
                            name: 'key01',
                            vhost: '__defaultVhost__',
                            app: 'live',
                            tcUrl: 'rtmp://x/live',
                            live_ms: 0,
                            publish: { active: true, cid: 'cid-1' },
                            kbps: { recv_30s: 0, send_30s: 0 },
                            clients: 1,
                            frames: 0,
                            recv_bytes: 0,
                            send_bytes: 0,
                        },
                    ],
                });
            }
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const db = makeFakeDb([pipeline]);
        db.appendLogThrows = true;
        const outputService = makeFakeOutputService();
        const service = createHealthService(
            db,
            outputService,
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);

        const snapshot = await getSnapshot(app);
        assert.equal(snapshot.pipelines['1'].input.connected, true);
        // The pipeline just went live: restartPipelineOutputs must still have
        // been invoked even though appendPipelineLog threw.
        assert.equal(outputService.restarts.length, 1);
        assert.equal(outputService.restarts[0].pipelineId, 1);

        service.shutdown();
    });

    test('restartPipelineOutputs is invoked exactly once on the offline-to-online transition', async (t) => {
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) {
                return jsonResponse({
                    code: 0,
                    streams: [
                        {
                            id: 's1',
                            name: 'key01',
                            vhost: '__defaultVhost__',
                            app: 'live',
                            tcUrl: 'rtmp://x/live',
                            live_ms: 0,
                            publish: { active: true, cid: 'cid-1' },
                            kbps: { recv_30s: 0, send_30s: 0 },
                            clients: 1,
                            frames: 0,
                            recv_bytes: 0,
                            send_bytes: 0,
                        },
                    ],
                });
            }
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const outputService = makeFakeOutputService();
        const service = createHealthService(
            makeFakeDb([pipeline]),
            outputService,
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);
        assert.equal(outputService.restarts.length, 1);

        service.shutdown();
    });

    test('an unassigned/deleted pipeline never appears in the snapshot', async (t) => {
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) return jsonResponse({ code: 0, streams: [] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        service.start();
        await sleep(20);

        const snapshot = await getSnapshot(app);
        assert.deepEqual(snapshot.pipelines, {});

        service.shutdown();
    });
});

describe('createHealthService diagnostics and bonded-leg alerts', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/health')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
        delete require.cache[require.resolve('../src/utils/srsConfig')];
    });

    function streamFixture(overrides = {}) {
        return {
            id: 's1',
            name: 'key01',
            vhost: '__defaultVhost__',
            app: 'live',
            tcUrl: 'rtmp://x/live',
            live_ms: 0,
            publish: { active: true, cid: 'cid-1' },
            kbps: { recv_30s: 1000, send_30s: 0 },
            clients: 1,
            frames: 0,
            recv_bytes: 0,
            send_bytes: 0,
            ...overrides,
        };
    }

    test('surfaces packet-drop, retransmission, belated, latency, bitrate-collapse, and forwarding-stalled alerts once a relay baseline exists', async (t) => {
        let stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const relay = makeFakeSrtRelayMutable(
            makeBondingStatus({
                forwardedPackets: 1000,
                input: {
                    recvUniquePacketsTotal: 1000,
                    recvDropTotal: 0,
                    retransTotal: 0,
                    belatedTotal: 0,
                    latencyMs: 100,
                },
            }),
        );
        const diagnostics = makeDiagnosticsSpy();
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        const service = createHealthService(
            makeFakeDb([pipeline]),
            makeFakeOutputService(),
            relay,
            makeFakeInputState(),
            diagnostics,
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);
        // Baseline poll: no previous sample yet, so no alerts should fire.
        assert.deepEqual((await getSnapshot(app)).pipelines['1'].alerts, []);

        // Same publish.cid, only the bitrate changes — kept out of the same
        // object literal reused above so the streams fetch reflects it live.
        stream = streamFixture({ kbps: { recv_30s: 300, send_30s: 0 } });
        relay.setStatus(
            makeBondingStatus({
                forwardedPackets: 1000, // unchanged despite more received packets below
                input: {
                    recvUniquePacketsTotal: 1600,
                    recvDropTotal: 50,
                    retransTotal: 40,
                    belatedTotal: 150,
                    latencyMs: 1500,
                },
            }),
        );
        await tickPoll(t);

        const alerts = (await getSnapshot(app)).pipelines['1'].alerts;
        assert.deepEqual(
            alerts.map((a) => a.code),
            [
                'srt-packets-dropped',
                'srt-retransmissions',
                'srt-belated-packets',
                'srt-latency-spike',
                'input-bitrate-collapse',
                'relay-forwarding-stalled',
            ],
        );
        assert.equal(
            alerts.find((a) => a.code === 'input-bitrate-collapse').message,
            'Input bitrate dropped from 1 Mb/s to 300 kb/s.',
        );

        service.shutdown();
    });

    describe('input frame rate', () => {
        // Polls an RTMP input whose ffprobe reports 50 fps; `framesPerPoll(i)`
        // is how many frames SRS counts between poll i-1 and poll i (5 s).
        // The measurement window is 2 minutes, i.e. 24 polls.
        async function pollFrameRate(t, framesPerPoll, { polls = 27, changeCidAt = null } = {}) {
            let frames = 1024;
            let cid = 'cid-1';
            t.mock.method(globalThis, 'fetch', async (url) => {
                if (String(url).includes('/streams/'))
                    return jsonResponse({
                        code: 0,
                        streams: [streamFixture({ frames, publish: { active: true, cid } })],
                    });
                return jsonResponse({ code: 0, clients: [] });
            });
            const createHealthService = loadHealthService(t);
            childProcess.execFile.mock.mockImplementation((_cmd, _args, _opts, cb) => {
                queueMicrotask(() =>
                    cb(
                        null,
                        JSON.stringify({
                            streams: [
                                {
                                    codec_type: 'video',
                                    codec_name: 'h264',
                                    width: 1920,
                                    height: 1080,
                                    r_frame_rate: '50/1',
                                },
                            ],
                        }),
                        '',
                    ),
                );
                return { kill() {} };
            });
            const service = createHealthService(
                makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
                makeFakeOutputService(),
                makeFakeSrtRelay(),
                makeFakeInputState(),
            );
            const app = express();
            service.registerRoutes(app);
            t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
            service.start();
            await sleep(300);
            const history = [];
            for (let i = 1; i <= polls; i++) {
                frames += framesPerPoll(i);
                if (i === changeCidAt) cid = 'cid-2';
                await tickPoll(t);
                history.push((await getSnapshot(app)).pipelines['1'].alerts.map((a) => a.code));
            }
            service.shutdown();
            return history;
        }

        test('warns when the counted frame rate is below 90% of the probed rate', async (t) => {
            // 200 frames per 5 s poll is 40 fps against a 50 fps encoder.
            const history = await pollFrameRate(t, () => 200);
            assert.deepEqual(history[22], []);
            assert.ok(
                history.at(-1).includes('input-low-framerate'),
                `expected input-low-framerate, got ${JSON.stringify(history.at(-1))}`,
            );
        });

        test('warns when the counted frame rate is above 110% of the probed rate', async (t) => {
            const history = await pollFrameRate(t, () => 280);
            assert.ok(
                history.at(-1).includes('input-high-framerate'),
                `expected input-high-framerate, got ${JSON.stringify(history.at(-1))}`,
            );
        });

        test('stays quiet at the probed rate, even with counter steps every other poll', async (t) => {
            // SRS adds frames in batches; 500 then 0 is the worst alignment.
            const history = await pollFrameRate(t, (i) => (i % 2 ? 500 : 0));
            assert.deepEqual(history.flat(), []);
        });

        test('restarts the measurement when the publisher changes', async (t) => {
            // 40 fps would be flagged once a full window has passed; the new
            // cid at poll 20 restarts it, so nothing is flagged by poll 27.
            const history = await pollFrameRate(t, () => 200, { changeCidAt: 20 });
            assert.ok(
                history.flat().includes('publisher-reconnected'),
                `expected the cid change to be seen, got ${JSON.stringify(history)}`,
            );
            assert.ok(!history.flat().includes('input-low-framerate'), JSON.stringify(history));
        });
    });

    describe('keyframe interval check', () => {
        // ffprobe packet lines for 12 s at 25 fps, a keyframe every `gop` seconds.
        const packets = (gop) =>
            Array.from({ length: 300 }, (_, i) => {
                const t = i / 25;
                return `${(t + 0.08).toFixed(6)},${t.toFixed(6)},${i % (gop * 25) === 0 ? 'K__' : '___'}`;
            }).join('\n');

        // One pipeline; the probe answers the stream JSON, the keyframe call `keyframeAnswer`.
        async function keyframes(
            t,
            { gop, keyframeError = null, hangKeyframe = null, settleFirst = true },
        ) {
            let cid = 'cid-1';
            t.mock.method(globalThis, 'fetch', async (url) => {
                if (String(url).includes('/streams/'))
                    return jsonResponse({
                        code: 0,
                        streams: [streamFixture({ publish: { active: true, cid } })],
                    });
                return jsonResponse({ code: 0, clients: [] });
            });
            const createHealthService = loadHealthService(t);
            const calls = [];
            childProcess.execFile.mock.mockImplementation((_cmd, args, _opts, cb) => {
                calls.push(args);
                queueMicrotask(() => {
                    if (args.includes('-read_intervals')) {
                        if (hangKeyframe) return; // still reading its 12 s window
                        if (keyframeError) return cb(keyframeError, '', 'boom');
                        return cb(null, packets(gop), '');
                    }
                    cb(
                        null,
                        JSON.stringify({
                            streams: [
                                {
                                    codec_type: 'video',
                                    codec_name: 'h264',
                                    width: 1920,
                                    height: 1080,
                                    r_frame_rate: '50/1',
                                },
                            ],
                        }),
                        '',
                    );
                });
                if (hangKeyframe && args.includes('-read_intervals')) {
                    return { exitCode: null, signalCode: null, kill: hangKeyframe };
                }
                return { kill() {} };
            });
            const diagnostics = makeDiagnosticsSpy();
            const db = makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]);
            const app = express();
            const service = createHealthService(
                db,
                makeFakeOutputService(),
                makeFakeSrtRelay(),
                makeFakeInputState(),
                diagnostics,
            );
            service.registerRoutes(app);
            t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
            service.start();
            await sleep(300);
            // The check starts 60 s after the first successful probe, from a poll.
            const settle = async () => {
                for (let i = 0; i < 13; i++) await tickPoll(t);
                await sleep(100);
            };
            if (settleFirst) await settle();
            return {
                calls,
                diagnostics,
                db,
                settle,
                snapshot: async () => {
                    await tickPoll(t); // the next poll carries the probe results
                    return (await getSnapshot(app)).pipelines['1'];
                },
                reconnect: async (nextCid) => {
                    cid = nextCid;
                    await tickPoll(t);
                    await sleep(300);
                },
                shutdown: () => service.shutdown(),
            };
        }

        test('a 6 s GOP raises input-keyframe-interval, with the measurement shown', async (t) => {
            const ctx = await keyframes(t, { gop: 6 });
            const pipeline = await ctx.snapshot();
            assert.equal(pipeline.input.keyframes.keyframes, 2);
            assert.equal(pipeline.input.keyframes.maxGapSec, 6);
            const alert = pipeline.alerts.find((a) => a.code === 'input-keyframe-interval');
            assert.ok(alert, JSON.stringify(pipeline.alerts));
            assert.equal(alert.severity, 'warning');
            assert.match(alert.message, /6\.0 s/);
            const event = ctx.diagnostics.events.find((e) => e.event === 'keyframe-interval');
            assert.equal(event.tooLong, true);
            assert.equal(event.maxGapSec, 6);
            assert.equal(ctx.db.logs.filter((l) => l.event === 'keyframe_interval').length, 1);
            ctx.shutdown();
        });

        test('a 2 s GOP raises nothing but is still reported', async (t) => {
            const ctx = await keyframes(t, { gop: 2 });
            const pipeline = await ctx.snapshot();
            assert.equal(pipeline.input.keyframes.meanGapSec, 2);
            assert.ok(!pipeline.alerts.some((a) => a.code === 'input-keyframe-interval'));
            assert.equal(
                ctx.diagnostics.events.find((e) => e.event === 'keyframe-interval').tooLong,
                false,
            );
            assert.equal(ctx.db.logs.filter((l) => l.event === 'keyframe_interval').length, 0);
            ctx.shutdown();
        });

        test('runs once per publisher, not on every poll, and again for a new publisher', async (t) => {
            const ctx = await keyframes(t, { gop: 2 });
            const count = () => ctx.calls.filter((a) => a.includes('-read_intervals')).length;
            assert.equal(count(), 1);
            await tickPoll(t);
            await tickPoll(t);
            await sleep(300);
            assert.equal(count(), 1);
            await ctx.reconnect('cid-2');
            await ctx.settle();
            assert.equal(count(), 2);
            ctx.shutdown();
        });

        test('waits 60 s after the first successful probe before measuring', async (t) => {
            const ctx = await keyframes(t, { gop: 2, settleFirst: false });
            const count = () => ctx.calls.filter((a) => a.includes('-read_intervals')).length;
            for (let i = 0; i < 11; i++) await tickPoll(t); // 55 s
            await sleep(100);
            assert.equal(count(), 0);
            assert.equal((await ctx.snapshot()).input.keyframes, null);
            await ctx.settle();
            assert.equal(count(), 1);
            assert.equal((await ctx.snapshot()).input.keyframes.maxGapSec, 2);
            ctx.shutdown();
        });

        test('a publisher that changes during the wait is measured on its own clock', async (t) => {
            const ctx = await keyframes(t, { gop: 2, settleFirst: false });
            const count = () => ctx.calls.filter((a) => a.includes('-read_intervals')).length;
            for (let i = 0; i < 9; i++) await tickPoll(t); // 45 s
            await ctx.reconnect('cid-2'); // new publisher: its probe restarts the 60 s
            for (let i = 0; i < 9; i++) await tickPoll(t); // 45 s later, 95 s after the first probe
            await sleep(100);
            assert.equal(count(), 0, 'the first publisher never got a check');
            await ctx.settle();
            assert.equal(count(), 1);
            ctx.shutdown();
        });

        test('shutdown kills a check still in flight', async (t) => {
            const kills = [];
            const ctx = await keyframes(t, { gop: 2, hangKeyframe: (sig) => kills.push(sig) });
            assert.equal(ctx.calls.filter((a) => a.includes('-read_intervals')).length, 1);
            ctx.shutdown();
            assert.deepEqual(kills, ['SIGKILL']);
        });

        test('after a mass reconnect only a few checks run at once, the rest queue', async (t) => {
            const keys = ['key01', 'key02', 'key03', 'key04', 'key05', 'key06'];
            t.mock.method(globalThis, 'fetch', async (url) => {
                if (String(url).includes('/streams/'))
                    return jsonResponse({
                        code: 0,
                        streams: keys.map((name, i) =>
                            streamFixture({
                                id: `s${i}`,
                                name,
                                publish: { active: true, cid: `c${i}` },
                            }),
                        ),
                    });
                return jsonResponse({ code: 0, clients: [] });
            });
            const createHealthService = loadHealthService(t);
            const started = [];
            const waiting = [];
            childProcess.execFile.mock.mockImplementation((_cmd, args, _opts, cb) => {
                if (args.includes('-read_intervals')) {
                    started.push(args.at(-1));
                    waiting.push(cb); // each check reads its 12 s window until released
                } else {
                    queueMicrotask(() =>
                        cb(
                            null,
                            JSON.stringify({
                                streams: [
                                    {
                                        codec_type: 'video',
                                        codec_name: 'h264',
                                        width: 1920,
                                        height: 1080,
                                        r_frame_rate: '50/1',
                                    },
                                ],
                            }),
                            '',
                        ),
                    );
                }
                return { exitCode: null, signalCode: null, kill() {} };
            });
            const db = makeFakeDb(
                keys.map((streamKey, i) => ({
                    id: i + 1,
                    name: `P${i + 1}`,
                    streamKey,
                    streamKeyId: i + 1,
                })),
            );
            const service = createHealthService(
                db,
                makeFakeOutputService(),
                makeFakeSrtRelay(),
                makeFakeInputState(),
            );
            t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
            service.start();
            await sleep(2000); // every pipeline's probe, 200 ms apart
            for (let i = 0; i < 13; i++) await tickPoll(t); // 60 s after the probes
            await sleep(100);
            assert.equal(started.length, 4, 'four checks run, two wait');
            waiting.shift()(null, packets(2), '');
            await sleep(50);
            assert.equal(started.length, 5, 'a finished check starts the next one');
            service.shutdown();
        });

        test('a failed check is a diagnostics event, raises no alert and is not retried', async (t) => {
            const ctx = await keyframes(t, {
                gop: 2,
                keyframeError: Object.assign(new Error('exit 1'), { code: 1 }),
            });
            t.mock.method(console, 'warn', () => {});
            await tickPoll(t);
            await tickPoll(t);
            await sleep(300);
            const pipeline = await ctx.snapshot();
            assert.equal(pipeline.input.keyframes, null);
            assert.equal(pipeline.input.mediaOk, true);
            assert.ok(!pipeline.alerts.some((a) => a.code === 'input-keyframe-interval'));
            const failed = ctx.diagnostics.events.filter(
                (e) => e.event === 'keyframe-probe-failed',
            );
            assert.equal(failed.length, 1);
            assert.equal(failed[0].reason, 'exit');
            assert.equal(ctx.calls.filter((a) => a.includes('-read_intervals')).length, 1);
            ctx.shutdown();
        });
    });

    describe('input format change on a new publisher', () => {
        // One pipeline whose publisher cid and ffprobe answer the test controls.
        async function format(t) {
            let cid = 'cid-1';
            let probe = { codec: 'h264', width: 1920, height: 1080, audio: 1 };
            t.mock.method(globalThis, 'fetch', async (url) => {
                if (String(url).includes('/streams/'))
                    return jsonResponse({
                        code: 0,
                        streams: [streamFixture({ publish: { active: true, cid } })],
                    });
                return jsonResponse({ code: 0, clients: [] });
            });
            const createHealthService = loadHealthService(t);
            childProcess.execFile.mock.mockImplementation((_cmd, _args, _opts, cb) => {
                queueMicrotask(() => {
                    if (!probe) return cb(new Error('no media'), '', '');
                    const streams = [
                        {
                            codec_type: 'video',
                            codec_name: probe.codec,
                            width: probe.width,
                            height: probe.height,
                            r_frame_rate: '50/1',
                        },
                        ...Array.from({ length: probe.audio }, () => ({
                            codec_type: 'audio',
                            codec_name: 'aac',
                            sample_rate: '48000',
                            channels: 2,
                        })),
                    ];
                    cb(null, JSON.stringify({ streams }), '');
                });
                return { kill() {} };
            });
            const outputs = makeFakeOutputService();
            const diagnostics = makeDiagnosticsSpy();
            const db = makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]);
            const service = createHealthService(
                db,
                outputs,
                makeFakeSrtRelay(),
                makeFakeInputState(),
                diagnostics,
            );
            t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
            service.start();
            await sleep(300); // first poll and its probe
            return {
                outputs,
                diagnostics,
                db,
                // A new publisher: another cid, probed on the next poll.
                async reconnect(nextProbe, nextCid, ms = 5000) {
                    probe = nextProbe;
                    cid = nextCid;
                    await tickPoll(t, ms);
                    await sleep(300);
                },
                shutdown: () => service.shutdown(),
            };
        }

        test('restarts the running outputs when the next publisher has another resolution', async (t) => {
            const ctx = await format(t);
            assert.equal(ctx.outputs.formatRestarts.length, 0, 'the first probe only records');
            await ctx.reconnect({ codec: 'h264', width: 1280, height: 720, audio: 1 }, 'cid-2');
            assert.equal(ctx.outputs.formatRestarts.length, 1);
            const [call] = ctx.outputs.formatRestarts;
            assert.equal(call.pipelineId, 1);
            assert.match(call.why, /h264 1920x1080, 1 audio track to h264 1280x720, 1 audio track/);
            assert.ok(call.startedBeforeMs > 0);
            const event = ctx.diagnostics.events.find((e) => e.event === 'input-format-changed');
            assert.equal(event.outputsRestarted, 3);
            assert.equal(event.suppressed, false);
            assert.ok(ctx.db.logs.some((l) => l.event === 'format_changed'));
            ctx.shutdown();
        });

        test('restarts on a changed codec or audio track count too', async (t) => {
            const ctx = await format(t);
            await ctx.reconnect({ codec: 'hevc', width: 1920, height: 1080, audio: 1 }, 'cid-2');
            assert.match(ctx.outputs.formatRestarts.at(-1).why, /to hevc 1920x1080/);
            await ctx.reconnect(
                { codec: 'hevc', width: 1920, height: 1080, audio: 2 },
                'cid-3',
                65_000,
            );
            assert.match(
                ctx.outputs.formatRestarts.at(-1).why,
                /1 audio track to hevc 1920x1080, 2 audio tracks/,
            );
            ctx.shutdown();
        });

        test('leaves the outputs alone when the next publisher has the same format', async (t) => {
            const ctx = await format(t);
            await ctx.reconnect({ codec: 'h264', width: 1920, height: 1080, audio: 1 }, 'cid-2');
            assert.equal(ctx.outputs.formatRestarts.length, 0);
            assert.ok(!ctx.diagnostics.events.some((e) => e.event === 'input-format-changed'));
            ctx.shutdown();
        });

        test('a failed probe restarts nothing and does not forget the last good format', async (t) => {
            const ctx = await format(t);
            await ctx.reconnect(null, 'cid-2');
            assert.equal(ctx.outputs.formatRestarts.length, 0);
            // The encoder comes back as it was: still no change from the last good probe.
            await ctx.reconnect(
                { codec: 'h264', width: 1920, height: 1080, audio: 1 },
                'cid-3',
                65_000,
            );
            assert.equal(ctx.outputs.formatRestarts.length, 0);
            ctx.shutdown();
        });

        test('a second change within a minute is reported but does not restart again', async (t) => {
            const ctx = await format(t);
            await ctx.reconnect({ codec: 'h264', width: 1280, height: 720, audio: 1 }, 'cid-2');
            await ctx.reconnect({ codec: 'h264', width: 1920, height: 1080, audio: 1 }, 'cid-3');
            assert.equal(ctx.outputs.formatRestarts.length, 1);
            const events = ctx.diagnostics.events.filter((e) => e.event === 'input-format-changed');
            assert.deepEqual(
                events.map((e) => [e.suppressed, e.outputsRestarted]),
                [
                    [false, 3],
                    [true, 0],
                ],
            );
            ctx.shutdown();
        });
    });

    test('records one started and one ended event per alert episode', async (t) => {
        const stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        let received = 1000;
        let dropped = 0;
        const status = () =>
            makeBondingStatus({
                forwardedPackets: received,
                input: { recvUniquePacketsTotal: received, recvDropTotal: dropped },
            });
        const relay = makeFakeSrtRelayMutable(status());
        const diagnostics = makeDiagnosticsSpy();
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        const service = createHealthService(
            makeFakeDb([pipeline]),
            makeFakeOutputService(),
            relay,
            makeFakeInputState(),
            diagnostics,
        );
        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);

        // Drops on two polls with one clean poll between: one episode.
        for (const drops of [5, 0, 5, 0, 0, 0, 0, 0, 0, 0]) {
            received += 900;
            dropped += drops;
            relay.setStatus(status());
            await tickPoll(t);
        }

        const episodes = diagnostics.events.filter((e) => e.event.startsWith('pipeline-alert-'));
        assert.deepEqual(
            episodes.map((e) => [e.event, e.code]),
            [
                ['pipeline-alert-started', 'srt-packets-dropped'],
                ['pipeline-alert-ended', 'srt-packets-dropped'],
            ],
        );
        assert.equal(episodes[0].pipelineId, 1);
        assert.match(episodes[0].message, /dropped 5 packets/);
        assert.equal(episodes[1].activePolls, 2);

        service.shutdown();
    });

    test('forgets a bonded leg that has sent no sample for an hour', async (t) => {
        const stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const relay = makeFakeSrtRelayMutable(
            makeBondingStatus({ input: { legs: [makeLeg({ ip: '203.0.113.10' })] } }),
        );
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        const service = createHealthService(
            makeFakeDb([pipeline]),
            makeFakeOutputService(),
            relay,
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);
        t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
        service.start();
        await sleep(20);

        // The cellular leg comes back on a new IP; the old one never returns.
        relay.setStatus(makeBondingStatus({ input: { legs: [makeLeg({ ip: '198.51.100.20' })] } }));
        t.mock.timers.tick(61 * 60 * 1000 - 5000);
        await sleep(20);
        await tickPoll(t);

        const req = new MockRequest();
        req.url = '/api/health/pipelines/1/legs/history';
        const history = await new Promise((resolve, reject) => {
            app.handle(req, new MockResponse(resolve), reject);
        });
        assert.deepEqual(
            history.legs.map((leg) => leg.ip),
            ['198.51.100.20'],
        );

        service.shutdown();
    });

    test('an alert keeps the time its episode started instead of moving to each poll', async (t) => {
        const stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        let received = 1000;
        let dropped = 0;
        const status = () =>
            makeBondingStatus({
                forwardedPackets: received,
                input: { recvUniquePacketsTotal: received, recvDropTotal: dropped },
            });
        const relay = makeFakeSrtRelayMutable(status());
        const service = createHealthService(
            makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
            makeFakeOutputService(),
            relay,
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);
        t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
        service.start();
        await sleep(20);

        const sinceByPoll = [];
        for (const drops of [5, 5, 5]) {
            received += 900;
            dropped += drops;
            relay.setStatus(status());
            await tickPoll(t);
            const alert = (await getSnapshot(app)).pipelines['1'].alerts.find(
                (a) => a.code === 'srt-packets-dropped',
            );
            sinceByPoll.push(alert.sinceMs);
        }

        assert.equal(sinceByPoll[1], sinceByPoll[0], 'sinceMs must not move with each poll');
        assert.equal(sinceByPoll[2], sinceByPoll[0]);
        service.shutdown();
    });

    test('the output health passes the warning start time through', async (t) => {
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [streamFixture()] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb(
                [{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }],
                [
                    {
                        id: '1-1',
                        pipelineId: 1,
                        seq: 1,
                        name: 'out',
                        desiredState: 'running',
                        videoEncoding: 'copy',
                        url: 'rtmp://dest.example/live/k',
                        audioEncoding: 'copy',
                        translation: null,
                        lastError: null,
                        hasErrorHistory: false,
                    },
                ],
            ),
            {
                ...makeFakeOutputService(),
                getStats: () => ({
                    ...makeFakeOutputService().getStats(),
                    status: 'running',
                    warningReason: 'falling behind',
                    warningSinceMs: 1234,
                }),
            },
            makeFakeSrtRelay(),
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);
        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);

        const out = (await getSnapshot(app)).pipelines['1'].outputs['1-1'];
        assert.equal(out.warningSinceMs, 1234);
        service.shutdown();
    });

    test('reports pure packet loss (no drops) instead of the drop alert', async (t) => {
        const stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const relay = makeFakeSrtRelayMutable(
            makeBondingStatus({
                forwardedPackets: 1000,
                input: { recvUniquePacketsTotal: 1000, recvLossTotal: 0, recvDropTotal: 0 },
            }),
        );
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        const service = createHealthService(
            makeFakeDb([pipeline]),
            makeFakeOutputService(),
            relay,
            makeFakeInputState(),
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);

        relay.setStatus(
            makeBondingStatus({
                forwardedPackets: 1900,
                input: { recvUniquePacketsTotal: 1900, recvLossTotal: 20, recvDropTotal: 0 },
            }),
        );
        await tickPoll(t);

        const alerts = (await getSnapshot(app)).pipelines['1'].alerts;
        assert.deepEqual(
            alerts.map((a) => a.code),
            ['srt-packet-loss'],
        );

        service.shutdown();
    });

    test('logs a bonded-leg-transition event and a bonded-leg-quality alert when a leg comes up with bad packet quality', async (t) => {
        const stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const relay = makeFakeSrtRelayMutable(
            makeBondingStatus({
                input: {
                    legs: [
                        makeLeg({
                            state: 'pending',
                            recvUniquePacketsTotal: 500,
                            recvDropTotal: 0,
                        }),
                    ],
                },
            }),
        );
        const diagnostics = makeDiagnosticsSpy();
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        const service = createHealthService(
            makeFakeDb([pipeline]),
            makeFakeOutputService(),
            relay,
            makeFakeInputState(),
            diagnostics,
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);

        relay.setStatus(
            makeBondingStatus({
                input: {
                    legs: [
                        makeLeg({
                            state: 'running',
                            recvUniquePacketsTotal: 1100,
                            recvDropTotal: 50,
                        }),
                    ],
                },
            }),
        );
        await tickPoll(t);

        const transition = diagnostics.events.find((e) => e.event === 'bonded-leg-transition');
        assert.ok(transition, 'expected a bonded-leg-transition event');
        assert.equal(transition.from, 'pending');
        assert.equal(transition.to, 'running');
        assert.equal(transition.pipelineId, 1);

        const snapshot = await getSnapshot(app);
        const qualityAlert = snapshot.pipelines['1'].alerts.find(
            (a) => a.code === 'bonded-leg-quality',
        );
        assert.ok(qualityAlert, 'expected a bonded-leg-quality alert');
        assert.equal(qualityAlert.severity, 'error');
        assert.match(qualityAlert.message, /^Bonded leg 203\.0\.113\.10:10081: Leg packet drops/);
        assert.equal(transition.bonded, true);
        assert.equal(snapshot.pipelines['1'].srtBonding.input.legs[0].health, 'error');

        service.shutdown();
    });

    test('flags a bonded leg that drops out of the group and clears it when the leg returns', async (t) => {
        const stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const leg = (ip) => makeLeg({ ip });
        const withLegs = (...ips) => makeBondingStatus({ input: { legs: ips.map(leg) } });
        const relay = makeFakeSrtRelayMutable(withLegs('203.0.113.10', '203.0.113.11'));
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        const service = createHealthService(
            makeFakeDb([pipeline]),
            makeFakeOutputService(),
            relay,
            makeFakeInputState(),
            makeDiagnosticsSpy(),
        );
        const app = express();
        service.registerRoutes(app);
        const legDownAlert = async () => {
            const snapshot = await getSnapshot(app);
            const { alerts, srtBonding } = snapshot.pipelines['1'];
            return {
                alert: alerts.find((a) => a.code === 'bonded-leg-down'),
                legs: srtBonding.input.legs.length,
                expectedLegs: srtBonding.input.expectedLegs,
            };
        };

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);
        assert.deepEqual(await legDownAlert(), { alert: undefined, legs: 2, expectedLegs: 2 });

        // The relay lists a failed leg as absent, never as broken.
        relay.setStatus(withLegs('203.0.113.10'));
        await tickPoll(t);
        const lost = await legDownAlert();
        assert.equal(lost.legs, 1);
        assert.equal(lost.expectedLegs, 2);
        assert.equal(lost.alert.severity, 'warning');
        assert.equal(lost.alert.message, '1 of 2 bonded legs is down.');

        relay.setStatus(withLegs('203.0.113.10', '203.0.113.12'));
        await tickPoll(t);
        assert.deepEqual(await legDownAlert(), { alert: undefined, legs: 2, expectedLegs: 2 });

        service.shutdown();
    });

    test('forgets how many legs a bonded input had once the input goes away', async (t) => {
        const stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const relay = makeFakeSrtRelayMutable(
            makeBondingStatus({
                input: {
                    legs: [makeLeg({ ip: '203.0.113.10' }), makeLeg({ ip: '203.0.113.11' })],
                },
            }),
        );
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        const service = createHealthService(
            makeFakeDb([pipeline]),
            makeFakeOutputService(),
            relay,
            makeFakeInputState(),
            makeDiagnosticsSpy(),
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);

        relay.setStatus(makeBondingStatus({ inputActive: false, input: { legs: [] } }));
        await tickPoll(t);
        // A new session that starts with a single leg has not lost anything.
        relay.setStatus(makeBondingStatus({ input: { legs: [makeLeg({ ip: '203.0.113.10' })] } }));
        await tickPoll(t);

        const { alerts, srtBonding } = (await getSnapshot(app)).pipelines['1'];
        assert.equal(
            alerts.some((a) => a.code === 'bonded-leg-down'),
            false,
        );
        assert.equal(srtBonding.input.expectedLegs, 1);

        service.shutdown();
    });

    describe('a main/backup group', () => {
        // In a backup group the standby leg is idle by design while the main leg runs.
        const legsWith = (...states) =>
            makeBondingStatus({
                input: {
                    legs: states.map((state, i) =>
                        makeLeg({ ip: `203.0.113.${10 + i}`, state, recvUniquePacketsTotal: 500 }),
                    ),
                },
            });

        async function legHealths(t, status) {
            const stream = streamFixture();
            t.mock.method(globalThis, 'fetch', async (url) => {
                if (String(url).includes('/streams/'))
                    return jsonResponse({ code: 0, streams: [stream] });
                return jsonResponse({ code: 0, clients: [] });
            });
            const createHealthService = loadHealthService(t);
            const service = createHealthService(
                makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
                makeFakeOutputService(),
                makeFakeSrtRelayMutable(status),
                makeFakeInputState(),
                makeDiagnosticsSpy(),
            );
            const app = express();
            service.registerRoutes(app);
            t.mock.timers.enable({ apis: ['setInterval'] });
            service.start();
            await sleep(20);
            const snapshot = await getSnapshot(app);
            service.shutdown();
            return snapshot.pipelines['1'].srtBonding.input.legs.map((leg) => leg.health);
        }

        test('does not warn about a standby leg while another leg carries the stream', async (t) => {
            assert.deepEqual(await legHealths(t, legsWith('running', 'idle')), ['ok', 'ok']);
        });

        test('still warns about an idle leg when nothing is running', async (t) => {
            assert.deepEqual(await legHealths(t, legsWith('idle', 'idle')), ['warn', 'warn']);
        });

        test('still warns about a leg that is pending', async (t) => {
            assert.deepEqual(await legHealths(t, legsWith('running', 'pending')), ['ok', 'warn']);
        });
    });

    describe('bonded leg history', () => {
        // The relay drops a failed leg from legs[] instead of reporting it broken, so the pipeline
        // log and the diagnostics are where an operator can see which link went and when.
        const legsOf = (...ips) =>
            makeBondingStatus({ input: { legs: ips.map((ip) => makeLeg({ ip })) } });
        const legLines = (db) => db.logs.filter((l) => l.event === 'legs').map((l) => l.message);

        async function startService(t, status, { db = null, withDate = false, now } = {}) {
            const stream = streamFixture();
            t.mock.method(globalThis, 'fetch', async (url) => {
                if (String(url).includes('/streams/'))
                    return jsonResponse({ code: 0, streams: [stream] });
                return jsonResponse({ code: 0, clients: [] });
            });
            const createHealthService = loadHealthService(t);
            const relay = makeFakeSrtRelayMutable(status);
            const diagnostics = makeDiagnosticsSpy();
            const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
            const fakeDb = db ?? makeFakeDb([pipeline]);
            const service = createHealthService(
                fakeDb,
                makeFakeOutputService(),
                relay,
                makeFakeInputState(),
                diagnostics,
            );
            t.mock.timers.enable({
                apis: withDate ? ['setInterval', 'Date'] : ['setInterval'],
                ...(now === undefined ? {} : { now }),
            });
            service.start();
            await sleep(20);
            return { relay, diagnostics, db: fakeDb, service };
        }

        test('logs the starting legs, then each leg that is lost or joins, with addresses', async (t) => {
            const { relay, diagnostics, db, service } = await startService(
                t,
                legsOf('203.0.113.10', '203.0.113.11'),
            );
            assert.deepEqual(legLines(db), [
                'Bonded input connected with 2 legs: 203.0.113.10:10081, 203.0.113.11:10081',
            ]);

            await tickPoll(t); // nothing changed: nothing logged
            assert.equal(legLines(db).length, 1);

            relay.setStatus(legsOf('203.0.113.10'));
            await tickPoll(t);
            relay.setStatus(legsOf('203.0.113.10', '203.0.113.12'));
            await tickPoll(t);

            assert.deepEqual(legLines(db).slice(1), [
                'Bonded legs went from 2 to 1: lost 203.0.113.11:10081 (now: 203.0.113.10:10081)',
                'Bonded legs went from 1 to 2: joined 203.0.113.12:10081 (now: 203.0.113.10:10081, 203.0.113.12:10081)',
            ]);
            const events = diagnostics.events.filter((e) => e.event === 'bonded-legs-changed');
            assert.equal(events.length, 3);
            assert.deepEqual(
                events.map((e) => [e.pipelineId, e.from, e.to, e.joined, e.left]),
                [
                    [1, 0, 2, ['203.0.113.10:10081', '203.0.113.11:10081'], []],
                    [1, 2, 1, [], ['203.0.113.11:10081']],
                    [1, 1, 2, ['203.0.113.12:10081'], []],
                ],
            );
            service.shutdown();
        });

        test('reports the last minutes of loss, retransmits and drops per leg, group and output', async (t) => {
            const at = (lost, dropped, sendDropped) =>
                makeBondingStatus({
                    input: {
                        recvDropTotal: dropped,
                        legs: [makeLeg({ recvLossTotal: lost, retransTotal: lost })],
                    },
                    output: { sendDropTotal: sendDropped },
                });
            const { relay, service } = await startService(t, at(100, 40, 0), { withDate: true });
            relay.setStatus(at(107, 41, 3));
            await tickPoll(t);
            relay.setStatus(at(109, 42, 3));
            await tickPoll(t);

            const app = express();
            service.registerRoutes(app);
            const { srtBonding } = (await getSnapshot(app)).pipelines['1'];
            assert.equal(srtBonding.input.recent.spanMs, 10_000);
            assert.equal(srtBonding.input.recent.drop, 2);
            assert.equal(srtBonding.input.legs[0].recent.loss, 9);
            assert.equal(srtBonding.input.legs[0].recent.retrans, 9);
            assert.equal(srtBonding.output.recent.drop, 3);
            assert.equal(srtBonding.input.recvDropTotal, 42, 'the totals are still reported');
            service.shutdown();
        });

        describe('relay errors', () => {
            const CLOCK = 1_800_000_000_000;
            const publishError = (retryMs) =>
                `Failed to publish to downstream output: srt_connect target=127.0.0.1:10080 streamid=#!::r=live/key01,m=publish: Connection setup failure; retrying in ${retryMs} ms`;
            const withError = (message, at) =>
                makeBondingStatus({
                    inputActive: true,
                    lastError: message,
                    lastErrorAt: at,
                    input: { legs: [makeLeg()] },
                });
            const errorLines = (db) => db.logs.filter((l) => l.event === 'relay_error');

            test('writes the relay error to the pipeline log once and merges its retries', async (t) => {
                const { relay, diagnostics, db, service } = await startService(
                    t,
                    withError(null, null),
                    { withDate: true, now: CLOCK },
                );
                const at = Date.now();
                relay.setStatus(withError(publishError(1000), at));
                await tickPoll(t);
                relay.setStatus(withError(publishError(2000), at + 3000));
                await tickPoll(t);
                relay.setStatus(withError(publishError(4000), at + 8000));
                await tickPoll(t);
                relay.setStatus(withError(publishError(4000), at + 8000));
                await tickPoll(t); // the same error seen again is not a repeat

                const lines = errorLines(db);
                assert.equal(lines.length, 1, 'one line however often it retries');
                assert.equal(
                    lines[0].message,
                    'Relay error: Failed to publish to downstream output: srt_connect target=127.0.0.1:10080: Connection setup failure (seen 3 times over 8 s)',
                );
                assert.doesNotMatch(lines[0].message, /key01/);
                const events = diagnostics.events.filter((e) => e.event === 'relay-stream-error');
                assert.equal(events.length, 1, 'diagnostics are bounded too');
                assert.equal(events[0].pipelineId, 1);
                assert.equal(events[0].repeat, false);
                service.shutdown();
            });

            test('does not log an error the relay was already holding when the dashboard started', async (t) => {
                const stale = CLOCK - 10 * 60 * 1000;
                const { db, service } = await startService(
                    t,
                    withError(publishError(1000), stale),
                    { withDate: true, now: CLOCK },
                );
                await tickPoll(t);
                assert.equal(errorLines(db).length, 0);
                service.shutdown();
            });

            test('a log write that fails does not stop the poll', async (t) => {
                const { relay, db, service } = await startService(t, withError(null, null), {
                    withDate: true,
                    now: CLOCK,
                });
                db.appendLogThrows = true;
                relay.setStatus(withError(publishError(1000), Date.now()));
                await tickPoll(t);
                assert.equal(errorLines(db).length, 0);
                db.appendLogThrows = false;
                relay.setStatus(
                    withError('Input error from peer 203.0.113.9:4000: broken', Date.now()),
                );
                await tickPoll(t);
                assert.equal(errorLines(db).length, 1, 'the next error is recorded');
                service.shutdown();
            });
        });

        test('a leg that returns from a new port is logged as lost and joined', async (t) => {
            const withPort = (port) =>
                makeBondingStatus({
                    input: {
                        legs: [
                            makeLeg({ ip: '203.0.113.10', port: 10081 }),
                            makeLeg({ ip: '198.51.100.7', port }),
                        ],
                    },
                });
            const { relay, db, service } = await startService(t, withPort(49152));
            relay.setStatus(withPort(50001));
            await tickPoll(t);
            assert.equal(
                legLines(db)[1],
                'Bonded legs changed (still 2): lost 198.51.100.7:49152; joined 198.51.100.7:50001 (now: 203.0.113.10:10081, 198.51.100.7:50001)',
            );
            service.shutdown();
        });

        test('does not call the legs lost when the whole input goes away and comes back', async (t) => {
            const { relay, diagnostics, db, service } = await startService(
                t,
                legsOf('203.0.113.10', '203.0.113.11'),
            );
            relay.setStatus(makeBondingStatus({ inputActive: false, input: { legs: [] } }));
            await tickPoll(t);
            assert.equal(
                legLines(db).length,
                1,
                'an input going away is logged as offline, not as lost legs',
            );

            relay.setStatus(legsOf('203.0.113.10'));
            await tickPoll(t);
            assert.deepEqual(legLines(db).slice(1), [
                'Bonded input connected with 1 leg: 203.0.113.10:10081',
            ]);
            assert.equal(
                diagnostics.events.filter((e) => e.event === 'bonded-legs-changed').length,
                2,
            );
            service.shutdown();
        });

        test('logs nothing for a plain SRT input', async (t) => {
            const plain = (ip) =>
                makeBondingStatus({
                    input: { bonded: false, legs: [makeLeg({ ip, port: 49152 })] },
                });
            const { relay, diagnostics, db, service } = await startService(
                t,
                plain('198.51.100.7'),
            );
            relay.setStatus(plain('198.51.100.8'));
            await tickPoll(t);
            assert.deepEqual(legLines(db), []);
            assert.equal(
                diagnostics.events.some((e) => e.event === 'bonded-legs-changed'),
                false,
            );
            service.shutdown();
        });

        test('keeps a flapping leg out of the pipeline log but every change in the diagnostics', async (t) => {
            const { relay, diagnostics, db, service } = await startService(
                t,
                legsOf('203.0.113.10', '203.0.113.11'),
                { withDate: true },
            );
            // 8 changes, one per poll: the leg goes down, comes back, and so on.
            for (let i = 0; i < 8; i++) {
                relay.setStatus(
                    i % 2 === 0 ? legsOf('203.0.113.10') : legsOf('203.0.113.10', '203.0.113.11'),
                );
                await tickPoll(t);
            }
            const changes = diagnostics.events.filter((e) => e.event === 'bonded-legs-changed');
            assert.equal(changes.length, 9, 'the starting legs plus all 8 changes');
            assert.equal(
                legLines(db).length,
                4,
                'only 4 lines fit in a minute, the start included',
            );

            // The burst ends; once its minute is over the hidden changes are counted once.
            for (let i = 0; i < 13; i++) await tickPoll(t);
            const lines = legLines(db);
            assert.equal(lines.length, 5);
            assert.equal(
                lines[4],
                '5 more bonded leg changes in the last minute not shown here (all are in the diagnostics log)',
            );
            for (let i = 0; i < 13; i++) await tickPoll(t);
            assert.equal(legLines(db).length, 5, 'the summary is written once');
            service.shutdown();
        });

        test('keeps recording to the diagnostics when the pipeline log cannot be written', async (t) => {
            const db = makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]);
            const { relay, diagnostics, service } = await startService(
                t,
                legsOf('203.0.113.10', '203.0.113.11'),
                { db },
            );
            db.appendLogThrows = true;
            relay.setStatus(legsOf('203.0.113.10'));
            await tickPoll(t);
            const events = diagnostics.events.filter((e) => e.event === 'bonded-legs-changed');
            assert.equal(events.length, 2);
            assert.deepEqual(events[1].left, ['203.0.113.11:10081']);
            service.shutdown();
        });
    });

    test('describes a plain relay input as an SRT input, not a bonded leg', async (t) => {
        const stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const plainLink = (overrides) =>
            makeLeg({ ip: '198.51.100.7', port: 49152, state: 'running', ...overrides });
        const plainStatus = (linkOverrides) =>
            makeBondingStatus({
                input: {
                    bonded: false,
                    peer: { ip: '198.51.100.7', port: 49152 },
                    legs: [plainLink(linkOverrides)],
                },
            });
        const relay = makeFakeSrtRelayMutable(
            plainStatus({ recvUniquePacketsTotal: 500, recvDropTotal: 0 }),
        );
        const diagnostics = makeDiagnosticsSpy();
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        const service = createHealthService(
            makeFakeDb([pipeline]),
            makeFakeOutputService(),
            relay,
            makeFakeInputState(),
            diagnostics,
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);

        relay.setStatus(plainStatus({ recvUniquePacketsTotal: 1100, recvDropTotal: 50 }));
        await tickPoll(t);

        const snapshot = await getSnapshot(app);
        const input = snapshot.pipelines['1'].srtBonding.input;
        assert.equal(input.bonded, false);
        assert.deepEqual(input.peer, { ip: '198.51.100.7', port: 49152 });
        assert.equal(input.legs[0].health, 'error');

        const qualityAlert = snapshot.pipelines['1'].alerts.find(
            (a) => a.code === 'bonded-leg-quality',
        );
        assert.ok(qualityAlert, 'expected a quality alert for the plain input');
        assert.match(
            qualityAlert.message,
            /^SRT input from 198\.51\.100\.7:49152: Connection packet drops/,
        );
        assert.doesNotMatch(qualityAlert.message, /leg/i);
        assert.equal(input.legs[0].healthReason.startsWith('Connection packet drops'), true);

        service.shutdown();
    });

    test('logs input-publisher-transition and surfaces a transient publisher-reconnected alert on a CID change', async (t) => {
        let stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const diagnostics = makeDiagnosticsSpy();
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        const service = createHealthService(
            makeFakeDb([pipeline]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);

        stream = streamFixture({ publish: { active: true, cid: 'cid-2' } });
        await tickPoll(t);

        const transition = diagnostics.events.find((e) => e.event === 'input-publisher-transition');
        assert.deepEqual(transition, {
            event: 'input-publisher-transition',
            pipelineId: 1,
            fromCid: 'cid-1',
            toCid: 'cid-2',
            protocol: 'rtmp',
        });

        const snapshot = await getSnapshot(app);
        assert.ok(
            snapshot.pipelines['1'].alerts.some((a) => a.code === 'publisher-reconnected'),
            'expected a transient publisher-reconnected alert right after the CID change',
        );

        service.shutdown();
    });

    describe('input-flapping alert', () => {
        async function pollWithConnectionPattern(t, pattern) {
            let present = pattern[0];
            const stream = streamFixture();
            t.mock.method(globalThis, 'fetch', async (url) => {
                if (String(url).includes('/streams/'))
                    return jsonResponse({ code: 0, streams: present ? [stream] : [] });
                return jsonResponse({ code: 0, clients: [] });
            });
            const createHealthService = loadHealthService(t);
            const diagnostics = makeDiagnosticsSpy();
            const service = createHealthService(
                makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
                makeFakeOutputService(),
                makeFakeSrtRelay(),
                makeFakeInputState(),
                diagnostics,
            );
            const app = express();
            service.registerRoutes(app);
            t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
            service.start();
            await sleep(20);
            for (const next of pattern.slice(1)) {
                present = next;
                await tickPoll(t);
            }
            const snapshot = await getSnapshot(app);
            service.shutdown();
            return { alerts: snapshot.pipelines['1'].alerts, diagnostics, tickPoll };
        }

        test('three disconnects within five minutes raise a warning', async (t) => {
            const { alerts, diagnostics } = await pollWithConnectionPattern(t, [
                true,
                false,
                true,
                false,
                true,
                false,
                true,
            ]);
            const flap = alerts.find((a) => a.code === 'input-flapping');
            assert.ok(flap, 'expected an input-flapping alert');
            assert.equal(flap.severity, 'warning');
            assert.match(flap.message, /disconnected 3 times in the last 5 minutes/);
            assert.ok(
                diagnostics.events.some(
                    (e) => e.event === 'pipeline-alert-started' && e.code === 'input-flapping',
                ),
            );
        });

        test('two disconnects (an encoder restart or two) do not', async (t) => {
            const { alerts } = await pollWithConnectionPattern(t, [true, false, true, false, true]);
            assert.ok(!alerts.some((a) => a.code === 'input-flapping'));
        });

        test('disconnects older than five minutes no longer count', async (t) => {
            let present = true;
            const stream = streamFixture();
            t.mock.method(globalThis, 'fetch', async (url) => {
                if (String(url).includes('/streams/'))
                    return jsonResponse({ code: 0, streams: present ? [stream] : [] });
                return jsonResponse({ code: 0, clients: [] });
            });
            const createHealthService = loadHealthService(t);
            const service = createHealthService(
                makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
                makeFakeOutputService(),
                makeFakeSrtRelay(),
                makeFakeInputState(),
            );
            const app = express();
            service.registerRoutes(app);
            t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
            service.start();
            await sleep(20);
            for (const next of [false, true, false, true, false, true]) {
                present = next;
                await tickPoll(t);
            }
            assert.ok(
                (await getSnapshot(app)).pipelines['1'].alerts.some(
                    (a) => a.code === 'input-flapping',
                ),
            );
            // Stay connected for six minutes (72 polls): the three drops age out.
            for (let i = 0; i < 72; i++) await tickPoll(t);
            assert.ok(
                !(await getSnapshot(app)).pipelines['1'].alerts.some(
                    (a) => a.code === 'input-flapping',
                ),
            );
            service.shutdown();
        });
    });

    test('logs srs-transition and input-transition diagnostics events across an outage and recovery', async (t) => {
        let reachable = true;
        const stream = streamFixture();
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (!reachable) throw new Error('down');
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [stream] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const diagnostics = makeDiagnosticsSpy();
        const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
        const service = createHealthService(
            makeFakeDb([pipeline]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
        );
        const app = express();
        service.registerRoutes(app);

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);

        const inputTransition = diagnostics.events.find((e) => e.event === 'input-transition');
        assert.deepEqual(inputTransition, {
            event: 'input-transition',
            pipelineId: 1,
            from: 'offline',
            to: 'live',
            protocol: 'rtmp',
        });

        reachable = false;
        await tickPoll(t);
        assert.deepEqual(
            diagnostics.events.filter((e) => e.event === 'srs-transition'),
            [{ event: 'srs-transition', from: 'up', to: 'down', message: 'Unreachable: down' }],
        );

        reachable = true;
        await tickPoll(t);
        assert.deepEqual(
            diagnostics.events.filter((e) => e.event === 'srs-transition'),
            [
                { event: 'srs-transition', from: 'up', to: 'down', message: 'Unreachable: down' },
                { event: 'srs-transition', from: 'down', to: 'up' },
            ],
        );

        service.shutdown();
    });
    // Serves a fake /proc/meminfo (and process list) and lets every other read
    // through, so the rest of the health service still sees the real fs.
    function mockHostMemory(t, state) {
        const realReadFileSync = fs.readFileSync;
        const realReaddirSync = fs.readdirSync;
        t.mock.method(fs, 'readFileSync', (file, ...rest) => {
            if (file === '/proc/meminfo') {
                return `MemTotal: 1024000 kB\nMemAvailable: ${state.availableKb} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`;
            }
            if (file === '/proc/77/status') return 'Name:\tffmpeg\nVmRSS:\t 99000 kB\n';
            if (file === '/proc/pressure/cpu') {
                return `some avg10=${state.cpuSome10 ?? 0.88} avg60=0.38 avg300=0.22 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
            }
            if (file === '/proc/net/snmp') {
                return (
                    'Tcp: ActiveOpens\nTcp: 1\n' +
                    'Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors\n' +
                    `Udp: 100 0 ${state.rcvbufErrors ?? 5} 50 ${state.rcvbufErrors ?? 5} 0\n`
                );
            }
            // 0x2760 is 10080, the default SRT port; 0x1388 (5000) is not an ingest port.
            if (file === '/proc/net/udp') {
                return (
                    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n' +
                    '  12: 00000000:2760 00000000:0000 07 00000000:0000A000 00:00000000 00000000  1000 0 1 2 0000000000000000 7\n' +
                    '  13: 00000000:1388 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000 0 2 2 0000000000000000 9\n'
                );
            }
            if (file === '/proc/net/udp6') return '  sl  local_address\n';
            return realReadFileSync(file, ...rest);
        });
        t.mock.method(fs, 'readdirSync', (dir, ...rest) =>
            dir === '/proc' ? ['77'] : realReaddirSync(dir, ...rest),
        );
        // Disk: state.diskFreeRatio of a 1000-block filesystem, for both the data
        // directory (tempDir here) and '/', which share a device unless state.dataDevice
        // is set.
        const realStatSync = fs.statSync;
        t.mock.method(fs, 'statfsSync', () => ({
            bsize: 1024 * 1024,
            blocks: 1000,
            bavail: Math.round((state.diskFreeRatio ?? 0.5) * 1000),
        }));
        t.mock.method(fs, 'statSync', (file, ...rest) =>
            file === '/' || file === tempDir
                ? { dev: file === tempDir ? (state.dataDevice ?? 1) : 1 }
                : realStatSync(file, ...rest),
        );
    }

    test('logs host-memory-low/recovered transitions with top processes, with hysteresis', async (t) => {
        const state = { availableKb: 400_000 }; // 39% of 1000MB: healthy
        mockHostMemory(t, state);
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [streamFixture()] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const diagnostics = makeDiagnosticsSpy();
        const service = createHealthService(
            makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
        );
        const app = express();
        service.registerRoutes(app);
        const memoryEvents = () =>
            diagnostics.events.filter((e) => e.event.startsWith('host-memory-'));

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);
        assert.deepEqual(memoryEvents(), [], 'no event while memory is healthy');

        state.availableKb = 100_000; // ~10% < 15%
        await tickPoll(t);
        assert.equal(memoryEvents().length, 1);
        assert.equal(memoryEvents()[0].event, 'host-memory-low');
        assert.equal(memoryEvents()[0].availableMb, 98);
        assert.equal(memoryEvents()[0].totalMb, 1000);
        assert.equal(
            memoryEvents()[0].message,
            'Memory low: 98MB of 1000MB available; top: ffmpeg(77)=97MB',
        );
        assert.deepEqual(memoryEvents()[0].topProcesses, [{ pid: 77, name: 'ffmpeg', rssMb: 97 }]);

        state.availableKb = 150_000; // ~14.6%: still low, must not flap
        await tickPoll(t);
        state.availableKb = 190_000; // ~18.6% < 20% recovery threshold
        await tickPoll(t);
        assert.equal(memoryEvents().length, 1, 'no repeat events while still below recovery');

        state.availableKb = 300_000; // ~29%
        await tickPoll(t);
        assert.deepEqual(
            memoryEvents().map((e) => e.event),
            ['host-memory-low', 'host-memory-recovered'],
        );

        service.shutdown();
    });

    test('logs host-cpu-high/recovered with hysteresis and shows both in the Server events table', async (t) => {
        const state = { availableKb: 400_000, cpuSome10: 20 };
        mockHostMemory(t, state);
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [streamFixture()] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const diagnostics = makeDiagnosticsSpy();
        const service = createHealthService(
            makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
            undefined,
            () => ({
                node: { cpuPercent: 4, ramBytes: 1 },
                srs: { cpuPercent: 31.5, ramBytes: 1 },
                relay: { cpuPercent: null, ramBytes: null },
            }),
        );
        const cpuEvents = () => diagnostics.events.filter((e) => e.event.startsWith('host-cpu-'));
        const hostRows = () => service.getSrsEvents().filter((e) => e.source === 'host');

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);
        assert.deepEqual(cpuEvents(), []);

        // Five polls at 60 is 25 s of the 30 s needed (the first poll above was healthy).
        state.cpuSome10 = 60;
        for (let i = 0; i < 5; i++) await tickPoll(t);
        assert.deepEqual(cpuEvents(), [], 'not sustained long enough yet');
        await tickPoll(t);
        assert.equal(cpuEvents().length, 1);
        assert.equal(cpuEvents()[0].event, 'host-cpu-high');
        assert.equal(cpuEvents()[0].pressure10, 60);
        assert.equal(cpuEvents()[0].thresholdPercent, 50);
        assert.deepEqual(cpuEvents()[0].topConsumers, [
            { name: 'srs', cpuPercent: 31.5 },
            { name: 'node', cpuPercent: 4 },
        ]);
        assert.equal(hostRows().length, 1);
        assert.equal(hostRows()[0].type, 'problem');
        assert.match(hostRows()[0].message, /^CPU saturated: pressure 60%/);

        // Between the 30 and 50 lines: still open, however long it stays there.
        state.cpuSome10 = 40;
        for (let i = 0; i < 15; i++) await tickPoll(t);
        assert.equal(cpuEvents().length, 1);

        state.cpuSome10 = 10;
        for (let i = 0; i < 11; i++) await tickPoll(t);
        assert.equal(cpuEvents().length, 1, 'recovery needs 60 s below 30');
        await tickPoll(t);
        assert.deepEqual(
            cpuEvents().map((e) => e.event),
            ['host-cpu-high', 'host-cpu-recovered'],
        );
        assert.equal(cpuEvents()[1].peakPressure10, 60);
        assert.equal(hostRows().length, 2);
        assert.equal(hostRows()[1].type, 'recovered');

        service.shutdown();
    });

    test('logs host-disk-low/recovered per filesystem, once for a shared device', async (t) => {
        const state = { availableKb: 400_000, diskFreeRatio: 0.5 };
        mockHostMemory(t, state);
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [streamFixture()] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const diagnostics = makeDiagnosticsSpy();
        const service = createHealthService(
            makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
        );
        const app = express();
        service.registerRoutes(app);
        const diskEvents = () => diagnostics.events.filter((e) => e.event.startsWith('host-disk-'));

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);
        assert.deepEqual(diskEvents(), []);

        const hostAlerts = async () => (await getSnapshot(app)).hostAlerts;
        assert.deepEqual(await hostAlerts(), []);

        state.diskFreeRatio = 0.08; // under 10%
        await tickPoll(t);
        assert.deepEqual(await hostAlerts(), ['disk'], 'the snapshot lists the open alert');
        assert.equal(diskEvents().length, 1, 'data dir and / are one device: one event');
        assert.equal(diskEvents()[0].event, 'host-disk-low');
        assert.equal(diskEvents()[0].path, tempDir);
        assert.equal(diskEvents()[0].availableMb, 80);
        assert.equal(diskEvents()[0].totalMb, 1000);

        state.diskFreeRatio = 0.12; // above the start line, below the 15% recovery line
        await tickPoll(t);
        assert.equal(diskEvents().length, 1, 'no flapping inside the band');

        assert.deepEqual(await hostAlerts(), ['disk'], 'still open inside the band');

        state.diskFreeRatio = 0.3;
        await tickPoll(t);
        assert.deepEqual(await hostAlerts(), []);
        assert.deepEqual(
            diskEvents().map((e) => e.event),
            ['host-disk-low', 'host-disk-recovered'],
        );
        const rows = service.getSrsEvents().filter((e) => e.source === 'host');
        assert.deepEqual(
            rows.map((e) => e.type),
            ['problem', 'recovered'],
        );

        // A separate data device is checked on its own, alongside '/'.
        state.dataDevice = 2;
        state.diskFreeRatio = 0.05;
        await tickPoll(t);
        assert.deepEqual(
            diskEvents()
                .slice(2)
                .map((e) => e.path),
            [tempDir, '/'],
        );

        service.shutdown();
    });

    test('health-snapshot records node/srs/relay CPU and RSS, host memory and each output memory limit', async (t) => {
        mockHostMemory(t, { availableKb: 400_000 });
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [streamFixture()] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const diagnostics = makeDiagnosticsSpy();
        const MB = 1024 * 1024;
        const service = createHealthService(
            makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
            undefined,
            () => ({
                node: { cpuPercent: 7, ramBytes: 1 }, // node RSS is read fresh, not from here
                srs: { cpuPercent: 12, ramBytes: 48 * MB },
                relay: { cpuPercent: null, ramBytes: 10 * MB },
            }),
        );

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);

        const snapshot = diagnostics.events.find((e) => e.event === 'health-snapshot');
        assert.ok(snapshot, 'expected a health-snapshot event on the first poll');
        const { node, srs, relay } = snapshot.processes;
        assert.equal(node.cpuPercent, 7);
        assert.ok(node.rssBytes > 1, 'node RSS must be read from the live process');
        assert.ok(node.heapUsedBytes > 0);
        assert.ok(node.heapTotalBytes >= node.heapUsedBytes);
        assert.deepEqual(srs, { cpuPercent: 12, rssBytes: 48 * MB });
        assert.deepEqual(relay, { cpuPercent: null, rssBytes: 10 * MB });
        assert.deepEqual(snapshot.host, {
            totalBytes: 1024000 * 1024,
            availableBytes: 400_000 * 1024,
            swapUsedBytes: 0,
            dataDisk: {
                path: tempDir,
                totalBytes: 1000 * MB,
                availableBytes: 500 * MB,
            },
            cpuPressure: { some10: 0.88, some60: 0.38 },
            udp: {
                rcvbufErrors: 5,
                sockets: [{ port: 10080, rxQueueBytes: 40960, drops: 7 }],
                rcvbufErrorsDelta: null,
            },
        });

        service.shutdown();
    });

    test('health-snapshot reports how many datagrams the kernel dropped since the previous snapshot', async (t) => {
        const state = { availableKb: 400_000, rcvbufErrors: 5 };
        mockHostMemory(t, state);
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [streamFixture()] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const diagnostics = makeDiagnosticsSpy();
        const service = createHealthService(
            makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
        );
        const deltas = () =>
            diagnostics.events
                .filter((e) => e.event === 'health-snapshot')
                .map((e) => e.host.udp.rcvbufErrorsDelta);

        t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
        service.start();
        await sleep(20);
        state.rcvbufErrors = 12;
        for (let i = 0; i < 12; i++) await tickPoll(t); // one minute: the next snapshot
        state.rcvbufErrors = 3; // a counter that went backwards (reset) is not a negative drop
        for (let i = 0; i < 12; i++) await tickPoll(t);

        assert.deepEqual(deltas(), [null, 7, 0]);

        service.shutdown();
    });

    test('health-snapshot still records node and host memory when no process-usage source is wired', async (t) => {
        mockHostMemory(t, { availableKb: 400_000 });
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [streamFixture()] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const diagnostics = makeDiagnosticsSpy();
        const service = createHealthService(
            makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
        );

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);

        const snapshot = diagnostics.events.find((e) => e.event === 'health-snapshot');
        assert.ok(snapshot.processes.node.rssBytes > 0);
        assert.equal(snapshot.processes.node.cpuPercent, null);
        assert.deepEqual(snapshot.processes.srs, { cpuPercent: null, rssBytes: null });
        assert.equal(snapshot.host.availableBytes, 400_000 * 1024);

        service.shutdown();
    });

    test('records a failed ffprobe in diagnostics and the pipeline log, once per publisher in the log', async (t) => {
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [streamFixture()] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const diagnostics = makeDiagnosticsSpy();
        const db = makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]);
        const service = createHealthService(
            db,
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
        );

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(50);

        const failed = diagnostics.events.filter((e) => e.event === 'media-probe-failed');
        assert.equal(failed.length, 1);
        assert.equal(failed[0].pipelineId, 1);
        assert.equal(failed[0].reason, 'exit');
        assert.equal(failed[0].attempt, 1);
        assert.match(failed[0].error, /ffprobe did not detect a readable media stream/);
        const probeLogs = db.logs.filter((l) => l.event === 'probe_failed');
        assert.equal(probeLogs.length, 1);
        assert.equal(probeLogs[0].pipelineId, 1);

        service.shutdown();
    });

    test('a throw while recording a probe result is logged, not an unhandled rejection', async (t) => {
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/'))
                return jsonResponse({ code: 0, streams: [streamFixture()] });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const diagnostics = makeDiagnosticsSpy();
        diagnostics.event = (event) => {
            if (event === 'media-probe-failed') throw new Error('diagnostics write failed');
        };
        const rejections = [];
        const onRejection = (reason) => rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        t.after(() => process.off('unhandledRejection', onRejection));
        const errors = [];
        t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
        const service = createHealthService(
            makeFakeDb([{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 }]),
            makeFakeOutputService(),
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
        );

        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(50);

        assert.deepEqual(rejections, []);
        assert.ok(
            errors.some((e) => /pipeline 1.*diagnostics write failed/.test(e)),
            `expected a logged probe error, got: ${JSON.stringify(errors)}`,
        );

        service.shutdown();
    });
});

describe('shared encodes (renditions) in the health snapshot', () => {
    const RENDITION_URL = 'rtmp://127.0.0.1:1935/internal/r1_720p_a0';
    const pipeline = { id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1 };
    const stream = (overrides = {}) => ({
        id: 's1',
        name: 'key01',
        vhost: '__defaultVhost__',
        app: 'live',
        tcUrl: 'rtmp://x/live',
        live_ms: 0,
        publish: { active: true, cid: 'cid-1' },
        kbps: { recv_30s: 1000, send_30s: 0 },
        clients: 1,
        frames: 0,
        recv_bytes: 0,
        send_bytes: 0,
        ...overrides,
    });
    const outputRow = (overrides) => ({
        id: '1-1',
        pipelineId: 1,
        seq: 1,
        name: 'out',
        desiredState: 'running',
        videoEncoding: 'copy',
        url: 'rtmp://dest.example/live/k',
        audioEncoding: 'copy',
        translation: null,
        lastError: null,
        hasErrorHistory: false,
        ...overrides,
    });
    const renditionRow = (overrides = {}) =>
        outputRow({
            id: '1-1',
            name: 'Shared encode 720p · track 0',
            url: RENDITION_URL,
            videoEncoding: '720p',
            audioEncoding: '0',
            ...overrides,
        });
    const statsFor = (extra = {}) => ({
        status: 'running',
        pid: 1,
        bitrateKbps: null,
        startedAtMs: null,
        failures: 0,
        warningReason: null,
        memoryUsageBytes: null,
        memoryLimitBytes: null,
        cpuPercent: null,
        role: 'output',
        renditionId: null,
        ready: null,
        ...extra,
    });

    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/health')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
        delete require.cache[require.resolve('../src/utils/srsConfig')];
    });

    async function pollOnce(t, { streams, outputs, outputStats, diagnostics, outputService }) {
        t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url).includes('/streams/')) return jsonResponse({ code: 0, streams });
            return jsonResponse({ code: 0, clients: [] });
        });
        const createHealthService = loadHealthService(t);
        const service = createHealthService(
            makeFakeDb([pipeline], outputs),
            outputService ?? { ...makeFakeOutputService(), getStats: (id) => outputStats[id] },
            makeFakeSrtRelay(),
            makeFakeInputState(),
            diagnostics,
        );
        const app = express();
        service.registerRoutes(app);
        t.mock.timers.reset(); // pollOnce may run twice in one test
        t.mock.timers.enable({ apis: ['setInterval'] });
        service.start();
        await sleep(20);
        const snapshot = await getSnapshot(app);
        service.shutdown();
        return snapshot;
    }

    test('a rendition reports its readers: clients minus the publisher of internal/<name>', async (t) => {
        const snapshot = await pollOnce(t, {
            streams: [
                stream(),
                stream({
                    id: 's2',
                    name: 'r1_720p_a0',
                    app: 'internal',
                    clients: 3,
                    publish: { active: true, cid: 'cid-2' },
                }),
            ],
            outputs: [renditionRow()],
            outputStats: { '1-1': statsFor({ role: 'rendition', ready: true }) },
        });

        const out = snapshot.pipelines['1'].outputs['1-1'];
        assert.equal(out.readers, 2);
        assert.equal(out.role, 'rendition');
        assert.equal(out.ready, true);
    });

    test('a rendition with no live internal stream has 0 readers; other outputs have null', async (t) => {
        const snapshot = await pollOnce(t, {
            streams: [stream()],
            outputs: [renditionRow(), outputRow({ id: '1-2' })],
            outputStats: {
                '1-1': statsFor({ role: 'rendition', ready: false }),
                '1-2': statsFor({ renditionId: '1-1' }),
            },
        });

        const { outputs } = snapshot.pipelines['1'];
        assert.equal(outputs['1-1'].readers, 0);
        assert.equal(outputs['1-2'].readers, null);
        assert.equal(outputs['1-2'].renditionId, '1-1');
        assert.equal(outputs['1-2'].role, 'output');
    });

    test('an internal stream that is not publishing does not count', async (t) => {
        const snapshot = await pollOnce(t, {
            streams: [
                stream(),
                stream({
                    id: 's2',
                    name: 'r1_720p_a0',
                    app: 'internal',
                    clients: 4,
                    publish: { active: false },
                }),
            ],
            outputs: [renditionRow()],
            outputStats: { '1-1': statsFor({ role: 'rendition' }) },
        });

        assert.equal(snapshot.pipelines['1'].outputs['1-1'].readers, 0);
    });

    test('internal streams never change the pipeline input, its readers, or restart outputs', async (t) => {
        const withInternal = [
            stream({ clients: 2 }),
            // Even one named exactly like the pipeline key, in the internal app.
            stream({ id: 's2', name: 'key01', app: 'internal', clients: 9 }),
            stream({ id: 's3', name: 'r1_720p_a0', app: 'internal', clients: 5 }),
        ];
        const without = [stream({ clients: 2 })];
        const run = async (streams) => {
            const outputService = {
                ...makeFakeOutputService(),
                getStats: () => statsFor(),
            };
            const snapshot = await pollOnce(t, {
                streams,
                outputs: [renditionRow()],
                outputService,
            });
            return { input: snapshot.pipelines['1'].input, restarts: outputService.restarts };
        };

        const a = await run(without);
        const b = await run(withInternal);

        assert.equal(b.input.connected, true);
        assert.equal(b.input.readers, 1);
        // uptimeMs is wall-clock dependent; everything else must be identical.
        const stable = ({ uptimeMs: _uptimeMs, ...rest }) => rest;
        assert.deepEqual(stable(b.input), stable(a.input));
        assert.equal(b.restarts.length, a.restarts.length);
    });

    test('an internal stream alone does not make a pipeline live', async (t) => {
        const snapshot = await pollOnce(t, {
            streams: [stream({ id: 's2', name: 'key01', app: 'internal', clients: 3 })],
            outputs: [],
            outputStats: {},
        });

        assert.equal(snapshot.pipelines['1'].input.connected, false);
        assert.equal(snapshot.pipelines['1'].input.live, false);
    });

    test('the diagnostics snapshot leaves out stopped outputs', async (t) => {
        const diagnostics = makeDiagnosticsSpy();
        await pollOnce(t, {
            streams: [stream()],
            outputs: [outputRow({ id: '1-1' }), outputRow({ id: '1-2' })],
            outputStats: {
                '1-1': statsFor({}),
                '1-2': statsFor({ status: 'stopped', pid: null }),
            },
            diagnostics,
        });

        const snapshot = diagnostics.events.find((e) => e.event === 'health-snapshot');
        assert.deepEqual(Object.keys(snapshot.pipelines['1'].outputs), ['1-1']);
    });

    test('the diagnostics snapshot carries role and renditionId per output', async (t) => {
        const diagnostics = makeDiagnosticsSpy();
        await pollOnce(t, {
            streams: [stream()],
            outputs: [renditionRow(), outputRow({ id: '1-2' })],
            outputStats: {
                '1-1': statsFor({ role: 'rendition', ready: true }),
                '1-2': statsFor({ renditionId: '1-1' }),
            },
            diagnostics,
        });

        const snapshot = diagnostics.events.find((e) => e.event === 'health-snapshot');
        const outputs = snapshot.pipelines['1'].outputs;
        assert.equal(outputs['1-1'].role, 'rendition');
        assert.equal(outputs['1-1'].renditionId, null);
        assert.equal(outputs['1-1'].ready, true);
        assert.equal(outputs['1-2'].role, 'output');
        assert.equal(outputs['1-2'].renditionId, '1-1');
    });
});
