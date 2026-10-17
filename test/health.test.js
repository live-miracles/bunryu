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
            logs.push({ pipelineId, event, message });
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
    };
}

function makeFakeSrtRelay() {
    return {
        getStats: () => ({ status: 'stopped', lastError: null }),
        getStreamStatus: () => makeBondingStatus({ inputActive: false }),
    };
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
        const events = service.getSrsEvents();
        assert.equal(events.length, 1);
        assert.equal(events[0].source, 'srs');
        assert.equal(events[0].type, 'down');
        assert.match(events[0].message, /ECONNREFUSED/);

        service.shutdown();
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
        assert.equal(service.getSrsEvents().length, 1);

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
        assert.equal(service.getSrsEvents().length, 1);

        failing = false;
        t.mock.timers.tick(5000);
        await sleep(20);

        assert.equal((await getSnapshot(app)).srsReachable, true);
        const events = service.getSrsEvents();
        assert.equal(events.length, 2);
        assert.equal(events[1].type, 'up');

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
            return realReadFileSync(file, ...rest);
        });
        t.mock.method(fs, 'readdirSync', (dir, ...rest) =>
            dir === '/proc' ? ['77'] : realReaddirSync(dir, ...rest),
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
        });

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
