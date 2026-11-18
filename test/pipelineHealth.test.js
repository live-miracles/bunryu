'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    buildPipelineHealth,
    displayedMedia,
    hasLocalSrtConflict,
    isLoopbackIp,
    isSrtStream,
    localSrtTargetResource,
    localSrtTargets,
    relayAdmission,
} = require('../src/utils/pipelineHealth');

const SRT_PORT = 10080;

describe('isLoopbackIp', () => {
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

describe('localSrtTargetResource', () => {
    const resource = (url) => localSrtTargetResource(url, SRT_PORT);

    test('names the stream a local SRS SRT destination publishes into', () => {
        assert.equal(
            resource('srt://127.0.0.1:10080?streamid=#!::r=live/key01,m=publish'),
            'live/key01',
        );
        assert.equal(
            resource('srt://localhost:10080?streamid=%23!::r=live/key01,m=publish'),
            'live/key01',
        );
        assert.equal(
            resource('srt://localhost:10080?streamid=%23%21%3A%3Ar%3Dlive%2Fkey01%2Cm%3Dpublish'),
            'live/key01',
        );
    });

    test('ignores non-local hosts, other ports, other protocols and unparsable URLs', () => {
        assert.equal(resource('srt://192.0.2.10:10080?streamid=#!::r=live/key01,m=publish'), null);
        assert.equal(resource('srt://127.0.0.1:10081?streamid=#!::r=live/key01,m=publish'), null);
        assert.equal(resource('rtmp://127.0.0.1:10080/live/key01'), null);
        assert.equal(resource('srt://[::1'), null);
    });
});

describe('localSrtTargets and hasLocalSrtConflict', () => {
    const out = (id, pipelineId, key, over = {}) => ({
        id,
        pipelineId,
        desiredState: 'running',
        url: `srt://127.0.0.1:${SRT_PORT}?streamid=#!::r=live/${key},m=publish`,
        ...over,
    });
    const build = (outputs, isRunning = () => true, srtPort = () => SRT_PORT) =>
        localSrtTargets(outputs, isRunning, srtPort);

    test("another pipeline's running output into this key is a conflict", () => {
        const index = build([out('2-1', 2, 'key01')]);
        assert.equal(hasLocalSrtConflict(index, 1, 'key01'), true);
    });

    test("a pipeline's own output, another key or no outputs are not", () => {
        const index = build([out('1-1', 1, 'key01'), out('2-1', 2, 'key02')]);
        assert.equal(hasLocalSrtConflict(index, 1, 'key01'), false);
        assert.equal(hasLocalSrtConflict(index, 3, 'key03'), false);
        assert.equal(hasLocalSrtConflict(build([]), 1, 'key01'), false);
    });

    test('only an output that is desired running and running counts', () => {
        const stopped = out('2-1', 2, 'key01', { desiredState: 'stopped' });
        assert.equal(hasLocalSrtConflict(build([stopped]), 1, 'key01'), false);
        const crashed = out('2-2', 2, 'key01');
        assert.equal(
            hasLocalSrtConflict(
                build([crashed], () => false),
                1,
                'key01',
            ),
            false,
        );
    });

    test('two outputs of one pipeline conflict with another one once', () => {
        const index = build([
            out('2-1', 2, 'key01'),
            out('2-2', 2, 'key01'),
            out('1-1', 1, 'key01'),
        ]);
        assert.deepEqual([...index.get('live/key01')].sort(), [1, 2]);
        assert.equal(hasLocalSrtConflict(index, 1, 'key01'), true);
        assert.equal(hasLocalSrtConflict(index, 2, 'key01'), true);
    });

    test('the SRT port is read only when a running SRT output exists', () => {
        let reads = 0;
        const port = () => {
            reads += 1;
            return SRT_PORT;
        };
        build([out('1-1', 1, 'k', { url: 'rtmp://a.example/live/k' })], () => true, port);
        build([out('1-1', 1, 'k', { desiredState: 'stopped' })], () => true, port);
        build([out('1-1', 1, 'k')], () => false, port);
        assert.equal(reads, 0);
        build([out('1-1', 1, 'k'), out('1-2', 1, 'k')], () => true, port);
        assert.equal(reads, 1, 'once for the whole poll');
    });

    test('a failing port read fails the build, as the config check does', () => {
        assert.throws(
            () =>
                build(
                    [out('1-1', 1, 'k')],
                    () => true,
                    () => {
                        throw new Error('Failed to read SRS config');
                    },
                ),
            /Failed to read SRS config/,
        );
    });
});

describe('relayAdmission', () => {
    const relayClient = { id: 'c1', ip: '127.0.0.1', type: 'srt-publish' };
    const admit = (over = {}) =>
        relayAdmission({
            srtStream: true,
            clientsKnown: true,
            publisher: relayClient,
            localSrtPublisherConflict: false,
            inputConnected: true,
            relayInputActive: true,
            ...over,
        });

    test('SRS accepts an SRT stream published from loopback by the relay', () => {
        assert.deepEqual(admit(), { acceptedBySrs: true, publishConflict: false });
        assert.equal(admit({ publisher: { ...relayClient, type: undefined } }).acceptedBySrs, true);
    });

    test('it does not when the stream is not SRT or the publisher is not the relay', () => {
        assert.equal(admit({ srtStream: false }).acceptedBySrs, false);
        assert.equal(
            admit({ publisher: { ...relayClient, ip: '203.0.113.9' } }).acceptedBySrs,
            false,
        );
        assert.equal(
            admit({ publisher: { ...relayClient, type: 'rtmp-publish' } }).acceptedBySrs,
            false,
        );
        assert.equal(admit({ publisher: undefined }).acceptedBySrs, false);
    });

    test('without the clients list the publisher is not judged', () => {
        const unknown = admit({ clientsKnown: false, publisher: undefined });
        assert.deepEqual(unknown, { acceptedBySrs: true, publishConflict: false });
    });

    test("another pipeline's output into the same key stops SRS taking the relay", () => {
        const result = admit({ localSrtPublisherConflict: true });
        assert.deepEqual(result, { acceptedBySrs: false, publishConflict: true });
    });

    test('a live relay input SRS does not take is a conflict only while the input is connected', () => {
        const refused = { publisher: { ...relayClient, ip: '203.0.113.9' } };
        assert.equal(admit(refused).publishConflict, true);
        assert.equal(admit({ ...refused, inputConnected: false }).publishConflict, false);
        assert.equal(admit({ ...refused, relayInputActive: false }).publishConflict, false);
    });
});

describe('what the dashboard shows of the media', () => {
    const probed = {
        ok: true,
        result: {
            video: { codec: 'h264', width: 1920, height: 1080 },
            audio: null,
            audioTracks: [],
        },
    };
    const stream = { video: { codec: 'h264', width: 1280, height: 720 } };

    test('a successful probe wins over what SRS reports', () => {
        const media = displayedMedia(probed, stream);
        assert.equal(media.probed, probed.result);
        assert.equal(media.video.width, 1920);
    });

    test('a failed or missing probe falls back to SRS, then to nothing', () => {
        assert.deepEqual(displayedMedia({ ok: false, result: null }, stream), {
            probed: null,
            video: stream.video,
        });
        assert.deepEqual(displayedMedia(null, undefined), { probed: null, video: null });
    });

    test('a stream is an SRT stream only while live and published over SRT', () => {
        const srt = { tcUrl: 'srt://127.0.0.1:10080' };
        assert.equal(isSrtStream(true, srt), true);
        assert.equal(isSrtStream(false, srt), false);
        assert.equal(isSrtStream(true, { tcUrl: 'rtmp://x/live' }), false);
        assert.equal(isSrtStream(true, undefined), false);
    });
});

describe('buildPipelineHealth', () => {
    const rawRelay = (over = {}) => ({
        inputActive: false,
        outputConnected: false,
        retryFailures: 0,
        forwardedPackets: 0,
        forwardedBytes: 0,
        lastPacketAt: null,
        lastInputPacketAt: null,
        lastError: null,
        lastErrorAt: null,
        input: { bonded: false, peer: null, legs: [] },
        output: { connected: false },
        ...over,
    });
    const recent = (over = {}) => ({ input: null, output: null, legs: new Map(), ...over });
    const readings = (over = {}) => ({
        stream: undefined,
        publisher: undefined,
        clientsKnown: true,
        live: false,
        connected: false,
        protocol: null,
        uptimeMs: 5000,
        probe: { status: null, inFlightSince: null, keyframes: null },
        relay: {
            status: rawRelay(),
            expectedLegs: 0,
            legHealth: new Map(),
            recent: recent(),
        },
        localSrtPublisherConflict: false,
        ...over,
    });

    test('an input nobody publishes to has no media and no uptime', () => {
        const { input } = buildPipelineHealth(readings());
        assert.equal(input.connected, false);
        assert.equal(input.isSrt, false);
        assert.equal(input.mediaOk, null);
        assert.equal(input.keyframes, null);
        assert.equal(input.publisherIp, null);
        assert.equal(input.uptimeMs, null);
        assert.equal(input.readers, 0);
        assert.deepEqual(input.audioTracks, []);
    });

    test('a live RTMP input carries its stream figures, probe and publisher', () => {
        const stream = {
            clients: 3,
            kbps: { recv_30s: 4000, send_30s: 8000 },
            video: { codec: 'h264', width: 1280, height: 720 },
            audio: { codec: 'aac' },
        };
        const keyframes = { checkedAt: 1 };
        const { input } = buildPipelineHealth(
            readings({
                stream,
                publisher: { id: 'c1', ip: '203.0.113.9', type: 'rtmp-publish' },
                live: true,
                connected: true,
                protocol: 'rtmp',
                probe: {
                    status: { ok: true, startedAt: 10, checkedAt: 20, error: null, result: null },
                    inFlightSince: null,
                    keyframes,
                },
            }),
        );
        assert.equal(input.isSrt, false);
        assert.equal(input.readers, 2);
        assert.equal(input.recvBitrateKbps, 4000);
        assert.equal(input.sendBitrateKbps, 8000);
        assert.equal(input.uptimeMs, 5000);
        assert.equal(input.publisherIp, '203.0.113.9');
        assert.equal(input.publisherType, 'rtmp-publish');
        assert.equal(input.mediaOk, true);
        assert.equal(input.mediaProbeStartedAt, 10);
        assert.equal(input.mediaCheckedAt, 20);
        assert.equal(input.keyframes, keyframes);
        assert.equal(input.video.width, 1280);
        assert.deepEqual(input.audio, { codec: 'aac' });
    });

    test('a probe in flight shows its start before the last result', () => {
        const { input } = buildPipelineHealth(
            readings({
                connected: true,
                probe: {
                    status: { ok: false, startedAt: 10, checkedAt: 20, error: 'x', result: null },
                    inFlightSince: 30,
                    keyframes: null,
                },
            }),
        );
        assert.equal(input.mediaProbeStartedAt, 30);
        assert.equal(input.mediaOk, false);
        assert.equal(input.mediaError, 'x');
    });

    test('an SRT input is told by its stream or, while connected, by the protocol', () => {
        const viaStream = buildPipelineHealth(
            readings({ live: true, connected: true, stream: { tcUrl: 'srt://127.0.0.1:10080' } }),
        );
        assert.equal(viaStream.input.isSrt, true);
        const viaProtocol = buildPipelineHealth(readings({ connected: true, protocol: 'srt' }));
        assert.equal(viaProtocol.input.isSrt, true);
        const idle = buildPipelineHealth(readings({ connected: false, protocol: 'srt' }));
        assert.equal(idle.input.isSrt, false);
    });

    test('the relay block says whether SRS accepted the stream and who publishes it', () => {
        const publisher = { id: 'c1', ip: '127.0.0.1', type: 'srt-publish' };
        const accepted = buildPipelineHealth(
            readings({
                stream: { tcUrl: 'srt://127.0.0.1:10080' },
                publisher,
                live: true,
                connected: true,
                relay: { ...readings().relay, status: rawRelay({ inputActive: true }) },
            }),
        );
        assert.equal(accepted.srtBonding.acceptedBySrs, true);
        assert.equal(accepted.srtBonding.publishConflict, false);
        assert.deepEqual(accepted.srtBonding.srsPublisher, {
            id: 'c1',
            ip: '127.0.0.1',
            type: 'srt-publish',
        });

        const conflict = buildPipelineHealth(
            readings({
                stream: { tcUrl: 'srt://127.0.0.1:10080' },
                publisher,
                live: true,
                connected: true,
                localSrtPublisherConflict: true,
                relay: { ...readings().relay, status: rawRelay({ inputActive: true }) },
            }),
        );
        assert.equal(conflict.srtBonding.acceptedBySrs, false);
        assert.equal(conflict.srtBonding.publishConflict, true);
        assert.equal(conflict.srtBonding.localSrtPublisherConflict, true);
    });

    test("a leg's health is looked up by ip:port and its recent counters by ip", () => {
        const legs = [
            { ip: '203.0.113.1', port: 4001, state: 'running' },
            { ip: '203.0.113.2', port: 4002, state: 'running' },
        ];
        const legRecent = { spanMs: 60000, packets: 10, loss: 1, retrans: 0, drop: 0 };
        const { srtBonding } = buildPipelineHealth(
            readings({
                relay: {
                    status: rawRelay({
                        inputActive: true,
                        input: { bonded: true, peer: null, legs },
                    }),
                    expectedLegs: 2,
                    legHealth: new Map([
                        ['203.0.113.1:4001', { health: 'warn', reason: 'Leg is unstable' }],
                        ['203.0.113.2:9999', { health: 'error', reason: 'other port' }],
                    ]),
                    recent: recent({
                        input: legRecent,
                        legs: new Map([['203.0.113.2', legRecent]]),
                    }),
                },
            }),
        );
        const [first, second] = srtBonding.input.legs;
        assert.equal(srtBonding.input.expectedLegs, 2);
        assert.equal(srtBonding.input.recent, legRecent);
        assert.equal(first.health, 'warn');
        assert.equal(first.healthReason, 'Leg is unstable');
        assert.equal(first.recent, null);
        assert.equal(second.health, 'ok', 'a health kept under another port is not this leg');
        assert.equal(second.healthReason, null);
        assert.equal(second.recent, legRecent);
    });
});
