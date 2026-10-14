'use strict';

const { after, afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-relay-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
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
fs.writeFileSync(path.join(tempDir, 'srs.conf'), 'listen 1935;\n', 'utf8');
const relayConfigPath = path.join(tempDir, 'srt-bonding-relay.json');

function writeRelayConfig(overrides = {}) {
    fs.writeFileSync(
        relayConfigPath,
        JSON.stringify(
            {
                input_host: '0.0.0.0',
                input_port: 10081,
                output_host: '127.0.0.1',
                output_port: 10080,
                status_port: 8081,
                passphrase: '',
                ...overrides,
            },
            null,
            4,
        ).concat('\n'),
        'utf8',
    );
}

writeRelayConfig();

const { createSrtRelayService } = require('../src/services/srtRelay');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = fn();
        if (value) return value;
        await sleep(25);
    }
    assert.fail('timed out waiting for condition');
}

const EMPTY_INPUT = {
    recvPacketsTotal: 0,
    recvUniquePacketsTotal: 0,
    recvLossTotal: 0,
    recvDropTotal: 0,
    retransTotal: 0,
    rttMs: null,
    latencyMs: null,
    bandwidthMbps: null,
    recvRateMbps: null,
    belatedTotal: null,
    belatedAvgMs: null,
    undecryptTotal: null,
    reorderDistance: null,
    rcvBufMs: null,
    legs: [],
};

const EMPTY_OUTPUT = {
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
};

// The service's own fallback for a streamId it has never seen reported (as
// opposed to EMPTY_INPUT above, which is a mocked payload that explicitly
// reports zeroes) — recvPacketsTotal stays null rather than 0 since no data
// ever flowed.
const UNREPORTED_INPUT = {
    ...EMPTY_INPUT,
    recvPacketsTotal: null,
    recvLossTotal: null,
    recvDropTotal: null,
    retransTotal: null,
};

describe('SRT relay service', () => {
    const cleanup = [];

    afterEach(async () => {
        while (cleanup.length) {
            await cleanup.pop()();
        }
        writeRelayConfig();
        global.fetch = originalFetch;
    });

    const originalFetch = global.fetch;

    after(() => {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('reports the relay as running when the status endpoint responds', async () => {
        const startedAtMs = Date.now() - 1000;
        const lastErrorAt = Date.now() - 500;
        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 12345,
                    startedAtMs,
                    updatedAtMs: Date.now(),
                    activeStreamIds: ['#!::r=live/key01,m=publish'],
                    lastError: null,
                    streamStates: [
                        {
                            streamId: '#!::r=live/key01,m=publish',
                            inputActive: true,
                            outputConnected: true,
                            retryFailures: 0,
                            forwardedPackets: 42,
                            forwardedBytes: 65536,
                            lastPacketAt: startedAtMs + 900,
                            lastInputPacketAt: startedAtMs + 900,
                            input: {
                                recvPacketsTotal: 120,
                                recvUniquePacketsTotal: 118,
                                recvLossTotal: 2,
                                recvDropTotal: 0,
                                retransTotal: 3,
                                rttMs: 4.25,
                                latencyMs: 240,
                                bandwidthMbps: null,
                                recvRateMbps: null,
                                belatedTotal: null,
                                belatedAvgMs: null,
                                undecryptTotal: null,
                                reorderDistance: null,
                                rcvBufMs: null,
                                legs: [
                                    {
                                        ip: '203.0.113.10',
                                        port: 10081,
                                        state: 'running',
                                        rttMs: 4.1,
                                        latencyMs: 240,
                                        recvPacketsTotal: 60,
                                        recvUniquePacketsTotal: 59,
                                        recvLossTotal: 1,
                                        recvDropTotal: 0,
                                        retransTotal: 1,
                                        bandwidthMbps: 12.3,
                                        recvRateMbps: 0.47,
                                        belatedTotal: 0,
                                        belatedAvgMs: 0,
                                        undecryptTotal: 0,
                                        reorderDistance: 0,
                                        rcvBufMs: 221,
                                    },
                                ],
                            },
                            output: {
                                sentPacketsTotal: 40,
                                sendLossTotal: 1,
                                sendDropTotal: 0,
                                retransTotal: 2,
                                rttMs: 5.1,
                                latencyMs: 200,
                                bandwidthMbps: 11.8,
                                sendRateMbps: 0.42,
                                undecryptTotal: 0,
                                sndBufMs: 1,
                            },
                            lastErrorAt,
                            lastError: null,
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().pid === 12345);
        assert.equal(service.getStats().status, 'running');
        assert.equal(service.getStats().startedAtMs, startedAtMs);
        assert.equal(service.getStreamStatus('#!::r=live/key01,m=publish').inputActive, true);
        assert.deepEqual(service.getStreamStatus('#!::r=live/key01,m=publish'), {
            inputActive: true,
            outputConnected: true,
            retryFailures: 0,
            forwardedPackets: 42,
            forwardedBytes: 65536,
            lastPacketAt: startedAtMs + 900,
            lastInputPacketAt: startedAtMs + 900,
            input: {
                recvPacketsTotal: 120,
                recvUniquePacketsTotal: 118,
                recvLossTotal: 2,
                recvDropTotal: 0,
                retransTotal: 3,
                rttMs: 4.25,
                latencyMs: 240,
                bandwidthMbps: null,
                recvRateMbps: null,
                belatedTotal: null,
                belatedAvgMs: null,
                undecryptTotal: null,
                reorderDistance: null,
                rcvBufMs: null,
                legs: [
                    {
                        ip: '203.0.113.10',
                        port: 10081,
                        state: 'running',
                        rttMs: 4.1,
                        latencyMs: 240,
                        recvPacketsTotal: 60,
                        recvUniquePacketsTotal: 59,
                        recvLossTotal: 1,
                        recvDropTotal: 0,
                        retransTotal: 1,
                        bandwidthMbps: 12.3,
                        recvRateMbps: 0.47,
                        belatedTotal: 0,
                        belatedAvgMs: 0,
                        undecryptTotal: 0,
                        reorderDistance: 0,
                        rcvBufMs: 221,
                    },
                ],
            },
            output: {
                sentPacketsTotal: 40,
                sendLossTotal: 1,
                sendDropTotal: 0,
                retransTotal: 2,
                rttMs: 5.1,
                latencyMs: 200,
                bandwidthMbps: 11.8,
                sendRateMbps: 0.42,
                undecryptTotal: 0,
                sndBufMs: 1,
            },
            lastErrorAt,
            lastError: null,
        });
    });

    test('normalizes invalid belated averages from libsrt to null', async () => {
        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 12345,
                    startedAtMs: Date.now() - 1000,
                    updatedAtMs: Date.now(),
                    streamStates: [
                        {
                            streamId: '#!::r=live/key01,m=publish',
                            inputActive: true,
                            input: {
                                belatedAvgMs: 9.00201e15,
                                legs: [{ belatedAvgMs: 9.00201e15 }],
                            },
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().pid === 12345);
        const stream = service.getStreamStatus('#!::r=live/key01,m=publish');
        assert.equal(stream.input.belatedAvgMs, null);
        assert.equal(stream.input.legs[0].belatedAvgMs, null);
    });

    test('matches stream status by resource path when encoder streamid includes extra fields', async () => {
        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 12345,
                    startedAtMs: Date.now() - 1000,
                    updatedAtMs: Date.now(),
                    activeStreamIds: ['#!::u=bridge,h=encoder.example,r=live/key01,m=publish'],
                    lastError: null,
                    streamStates: [
                        {
                            streamId: '#!::u=bridge,h=encoder.example,r=live/key01,m=publish',
                            inputActive: true,
                            outputConnected: true,
                            retryFailures: 0,
                            forwardedPackets: 0,
                            forwardedBytes: 0,
                            lastPacketAt: null,
                            lastInputPacketAt: null,
                            input: EMPTY_INPUT,
                            output: EMPTY_OUTPUT,
                            lastErrorAt: null,
                            lastError: null,
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().status === 'running');
        assert.deepEqual(service.getStreamStatus('#!::r=live/key01,m=publish'), {
            inputActive: true,
            outputConnected: true,
            retryFailures: 0,
            forwardedPackets: 0,
            forwardedBytes: 0,
            lastPacketAt: null,
            lastInputPacketAt: null,
            input: EMPTY_INPUT,
            output: EMPTY_OUTPUT,
            lastErrorAt: null,
            lastError: null,
        });
    });

    test('reports an unreachable relay as stopped before any successful poll', async () => {
        global.fetch = async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:8081');
        };
        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().lastError);
        assert.equal(service.getStats().status, 'stopped');
        assert.equal(service.getStats().port, 10081);
        assert.equal(service.getStreamStatus('#!::r=live/key02,m=publish').inputActive, false);
    });

    test('reads relay input and status ports from JSON config', async () => {
        writeRelayConfig({ input_port: 12081, output_port: 12080, status_port: 12082 });
        let fetchedUrl = '';
        global.fetch = async (url) => {
            fetchedUrl = String(url);
            return new Response(
                JSON.stringify({
                    pid: 54321,
                    startedAtMs: Date.now(),
                    streamStates: [],
                    lastError: null,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        };

        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().pid === 54321);
        assert.equal(service.getStats().port, 12081);
        assert.equal(fetchedUrl, 'http://127.0.0.1:12082/status');
    });

    test('reports a previously reachable relay as failed when the endpoint goes away', async () => {
        let calls = 0;
        global.fetch = async () => {
            calls += 1;
            if (calls === 1) {
                return new Response(
                    JSON.stringify({
                        pid: 222,
                        startedAtMs: Date.now() - 5000,
                        updatedAtMs: Date.now(),
                        activeStreamIds: [],
                        lastError: null,
                        streamStates: [],
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            throw new Error('connect ECONNREFUSED 127.0.0.1:8081');
        };
        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().status === 'running');
        await waitFor(() => service.getStats().status === 'failed', 8000);
        assert.match(service.getStats().lastError || '', /fetch|connect|ECONNREFUSED/i);
    });

    test('clears stale per-stream errors after the relay restarts', async () => {
        const erroredState = {
            streamId: '#!::r=live/key03,m=publish',
            inputActive: false,
            outputConnected: false,
            retryFailures: 4,
            forwardedPackets: 900,
            forwardedBytes: 1310720,
            lastPacketAt: Date.now() - 5000,
            lastInputPacketAt: Date.now() - 1000,
            input: {
                ...EMPTY_INPUT,
                recvPacketsTotal: 950,
                recvUniquePacketsTotal: 940,
                recvLossTotal: 10,
                recvDropTotal: 2,
                retransTotal: 6,
                rttMs: 12.5,
            },
            output: {
                ...EMPTY_OUTPUT,
                sentPacketsTotal: 880,
                sendLossTotal: 3,
                sendDropTotal: 1,
                retransTotal: 5,
                rttMs: 13.1,
            },
            lastErrorAt: Date.now() - 4000,
            lastError: 'Relay output error: broken pipe',
        };

        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 1001,
                    startedAtMs: Date.now() - 10000,
                    updatedAtMs: Date.now(),
                    activeStreamIds: [],
                    lastError: 'srt_sendmsg2: broken pipe',
                    streamStates: [erroredState],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const firstService = createSrtRelayService();
        cleanup.push(async () => firstService.shutdown());
        firstService.start();

        await waitFor(() => firstService.getStats().pid === 1001);
        assert.equal(
            firstService.getStreamStatus(erroredState.streamId).lastError,
            erroredState.lastError,
        );

        firstService.shutdown();

        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 1002,
                    startedAtMs: Date.now() - 500,
                    updatedAtMs: Date.now(),
                    activeStreamIds: [],
                    lastError: null,
                    streamStates: [],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const restartedService = createSrtRelayService();
        cleanup.push(async () => restartedService.shutdown());
        restartedService.start();

        await waitFor(() => restartedService.getStats().pid === 1002);
        assert.deepEqual(restartedService.getStreamStatus(erroredState.streamId), {
            inputActive: false,
            outputConnected: false,
            retryFailures: 0,
            forwardedPackets: 0,
            forwardedBytes: 0,
            lastPacketAt: null,
            lastInputPacketAt: null,
            input: UNREPORTED_INPUT,
            output: EMPTY_OUTPUT,
            lastErrorAt: null,
            lastError: null,
        });
    });

    test('marks the relay as stopped with a descriptive error on a non-2xx status code', async () => {
        global.fetch = async () => new Response('Internal Server Error', { status: 503 });
        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().lastError);
        assert.equal(service.getStats().status, 'stopped');
        assert.match(service.getStats().lastError || '', /503/);
    });

    test('marks the relay as stopped instead of crashing when the response body is not valid JSON', async () => {
        global.fetch = async () =>
            new Response('<html>not json</html>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
            });
        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().lastError);
        assert.equal(service.getStats().status, 'stopped');
        assert.equal(service.getStreamStatus('#!::r=live/key01,m=publish').inputActive, false);
    });

    test('treats a fetch timeout the same as any other connection failure', async () => {
        global.fetch = async () => {
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        };
        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().lastError);
        assert.equal(service.getStats().status, 'stopped');
        assert.match(service.getStats().lastError || '', /timeout/i);
    });

    test('drops stream states with a missing, empty, or non-string streamId instead of crashing', async () => {
        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 777,
                    startedAtMs: Date.now(),
                    updatedAtMs: Date.now(),
                    lastError: null,
                    streamStates: [
                        { inputActive: true, input: EMPTY_INPUT, output: EMPTY_OUTPUT },
                        {
                            streamId: '',
                            inputActive: true,
                            input: EMPTY_INPUT,
                            output: EMPTY_OUTPUT,
                        },
                        {
                            streamId: 12345,
                            inputActive: true,
                            input: EMPTY_INPUT,
                            output: EMPTY_OUTPUT,
                        },
                        {
                            streamId: '#!::r=live/keyOK,m=publish',
                            inputActive: true,
                            forwardedPackets: 5,
                            input: EMPTY_INPUT,
                            output: EMPTY_OUTPUT,
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().pid === 777);
        assert.equal(
            service.getStreamStatus('#!::r=live/keyOK,m=publish').forwardedPackets,
            5,
            'the well-formed entry must still be indexed',
        );
        // None of the malformed entries can be looked up (no valid streamId to
        // key them by) — this only proves they didn't crash the poll loop.
        assert.equal(service.getStreamStatus('').inputActive, false);
    });

    test('getStreamStatus returns the exact empty-status shape for a totally unknown streamId', async () => {
        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 1,
                    startedAtMs: Date.now(),
                    updatedAtMs: Date.now(),
                    lastError: null,
                    streamStates: [],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().pid === 1);
        assert.deepEqual(service.getStreamStatus('#!::r=live/never-seen,m=publish'), {
            inputActive: false,
            outputConnected: false,
            retryFailures: 0,
            forwardedPackets: 0,
            forwardedBytes: 0,
            lastPacketAt: null,
            lastInputPacketAt: null,
            input: UNREPORTED_INPUT,
            output: EMPTY_OUTPUT,
            lastErrorAt: null,
            lastError: null,
        });
        // A streamId with no parseable r= resource falls back the same way.
        assert.deepEqual(
            service.getStreamStatus('totally-garbage-not-a-streamid'),
            service.getStreamStatus('#!::r=live/never-seen,m=publish'),
        );
    });

    test('keeps per-stream status lookup stable with 20 concurrent streams', async () => {
        const streamStates = Array.from({ length: 20 }, (_, idx) => {
            const streamNum = String(idx + 1).padStart(2, '0');
            return {
                streamId: `#!::u=bridge-${streamNum},r=live/key${streamNum},m=publish`,
                inputActive: true,
                outputConnected: idx % 2 === 0,
                retryFailures: idx % 3,
                forwardedPackets: (idx + 1) * 100,
                forwardedBytes: (idx + 1) * 1456 * 100,
                lastPacketAt: Date.now() - idx * 100,
                lastInputPacketAt: Date.now() - idx * 100,
                input: {
                    ...EMPTY_INPUT,
                    recvPacketsTotal: (idx + 1) * 120,
                    recvUniquePacketsTotal: (idx + 1) * 118,
                    recvLossTotal: idx,
                    recvDropTotal: idx % 2,
                    retransTotal: idx + 2,
                    rttMs: 2.5 + idx / 10,
                },
                output: {
                    ...EMPTY_OUTPUT,
                    sentPacketsTotal: (idx + 1) * 90,
                    sendLossTotal: idx % 2,
                    sendDropTotal: idx % 4 === 0 ? 1 : 0,
                    retransTotal: idx + 1,
                    rttMs: 2.5 + idx / 10,
                },
                lastErrorAt: idx % 4 === 0 ? Date.now() - 1000 : null,
                lastError: idx % 4 === 0 ? `intermittent error ${streamNum}` : null,
            };
        });

        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 3030,
                    startedAtMs: Date.now() - 2000,
                    updatedAtMs: Date.now(),
                    activeStreamIds: streamStates.map((s) => s.streamId),
                    lastError: null,
                    streamStates,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const service = createSrtRelayService();
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().pid === 3030);
        assert.equal(
            service.getStreamStatus('#!::u=bridge-20,r=live/key20,m=publish').inputActive,
            true,
        );
        assert.deepEqual(service.getStreamStatus('#!::r=live/key20,m=publish'), {
            inputActive: true,
            outputConnected: false,
            retryFailures: 1,
            forwardedPackets: 2000,
            forwardedBytes: 2912000,
            lastPacketAt: streamStates[19].lastPacketAt,
            lastInputPacketAt: streamStates[19].lastInputPacketAt,
            input: {
                ...EMPTY_INPUT,
                recvPacketsTotal: 2400,
                recvUniquePacketsTotal: 2360,
                recvLossTotal: 19,
                recvDropTotal: 1,
                retransTotal: 21,
                rttMs: 4.4,
            },
            output: {
                ...EMPTY_OUTPUT,
                sentPacketsTotal: 1800,
                sendLossTotal: 1,
                sendDropTotal: 0,
                retransTotal: 20,
                rttMs: 4.4,
            },
            lastErrorAt: null,
            lastError: null,
        });
    });

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

    test('logs a relay-transition and a first-sight relay-input-transition on the first poll', async () => {
        global.fetch = async () =>
            new Response(
                JSON.stringify({
                    pid: 222,
                    startedAtMs: Date.now(),
                    updatedAtMs: Date.now(),
                    activeStreamIds: ['#!::r=live/key01,m=publish'],
                    lastError: null,
                    streamStates: [
                        {
                            streamId: '#!::r=live/key01,m=publish',
                            inputActive: true,
                            outputConnected: true,
                            retryFailures: 0,
                            forwardedPackets: 0,
                            forwardedBytes: 0,
                            lastPacketAt: null,
                            lastInputPacketAt: null,
                            input: EMPTY_INPUT,
                            output: EMPTY_OUTPUT,
                            lastErrorAt: null,
                            lastError: null,
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const diagnostics = makeDiagnosticsSpy();
        const service = createSrtRelayService(diagnostics);
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().status === 'running');

        const relayTransition = diagnostics.events.find((e) => e.event === 'relay-transition');
        assert.deepEqual(relayTransition, {
            event: 'relay-transition',
            from: 'stopped',
            to: 'running',
            pid: 222,
            error: null,
        });

        const inputTransition = diagnostics.events.find(
            (e) => e.event === 'relay-input-transition',
        );
        assert.deepEqual(inputTransition, {
            event: 'relay-input-transition',
            streamId: '#!::r=live/key01,m=publish',
            inputActive: true,
            outputConnected: true,
        });
    });

    test('logs relay-transition running->failed once a previously reachable relay stops responding', async () => {
        let calls = 0;
        global.fetch = async () => {
            calls += 1;
            if (calls === 1) {
                return new Response(
                    JSON.stringify({
                        pid: 333,
                        startedAtMs: Date.now() - 5000,
                        updatedAtMs: Date.now(),
                        activeStreamIds: [],
                        lastError: null,
                        streamStates: [],
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            throw new Error('connect ECONNREFUSED 127.0.0.1:8081');
        };

        const diagnostics = makeDiagnosticsSpy();
        const service = createSrtRelayService(diagnostics);
        cleanup.push(async () => service.shutdown());
        service.start();

        await waitFor(() => service.getStats().status === 'running');
        await waitFor(() => service.getStats().status === 'failed', 8000);

        const transitions = diagnostics.events.filter((e) => e.event === 'relay-transition');
        assert.deepEqual(transitions[0], {
            event: 'relay-transition',
            from: 'stopped',
            to: 'running',
            pid: 333,
            error: null,
        });
        assert.equal(transitions[1].from, 'running');
        assert.equal(transitions[1].to, 'failed');
        assert.match(transitions[1].error, /ECONNREFUSED/);
    });
});
