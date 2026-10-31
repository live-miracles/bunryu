'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { buildOverviewModel } = require('../public/ts/core/overview-model');

const NOW = 1_000_000;

const liveInput = (overrides = {}) => ({
    connected: true,
    live: true,
    isSrt: false,
    mediaOk: true,
    mediaProbeStartedAt: null,
    mediaCheckedAt: null,
    mediaError: null,
    keyframes: null,
    recvBitrateKbps: 4000,
    sendBitrateKbps: null,
    readers: 0,
    uptimeMs: 120_000,
    publisherIp: null,
    publisherType: null,
    video: null,
    audio: null,
    audioTracks: [{}],
    ...overrides,
});
const offInput = () => liveInput({ connected: false, live: false, mediaOk: null });

const output = (id, overrides = {}) => ({
    id,
    pipelineId: '1',
    seq: 1,
    name: `Out ${id}`,
    url: `rtmp://live.example/app/${id}`,
    desiredState: 'running',
    status: 'running',
    pid: 1,
    bitrateKbps: 4000,
    cpuPercent: null,
    memoryUsageBytes: null,
    startedAtMs: 1,
    failures: 0,
    nextRetryAtMs: null,
    warningReason: null,
    warningSinceMs: null,
    lastError: null,
    hasErrorHistory: false,
    lastErrorAt: null,
    videoEncoding: 'copy',
    audioEncoding: 'copy',
    dependents: [],
    ...overrides,
});
const stopped = (id) => output(id, { desiredState: 'stopped', status: 'stopped', pid: null });
const failed = (id) => output(id, { status: 'failed', bitrateKbps: null, lastError: 'Refused' });
const warning = (id) => output(id, { warningReason: 'Timestamp discontinuities' });

const idleBonding = () => ({
    inputActive: false,
    outputConnected: false,
    acceptedBySrs: false,
    publishConflict: false,
    localSrtPublisherConflict: false,
    retryFailures: 0,
    forwardedPackets: 0,
    lastPacketAt: null,
    lastInputPacketAt: null,
    lastError: null,
    input: {
        bonded: false,
        expectedLegs: 1,
        recvPacketsTotal: 0,
        recvUniquePacketsTotal: 0,
        recvLossTotal: 0,
        recvDropTotal: 0,
        retransTotal: 0,
        legs: [],
    },
});

const pipeline = (id, input, outs, extra = {}) => ({
    id: String(id),
    name: `Pipeline ${id}`,
    streamKey: `key0${id}_secret`,
    rtmpPublishUrl: `rtmp://srv.example/live/key0${id}_secret`,
    srtPublishUrl: `srt://srv.example:8890?streamid=publish:live/key0${id}_secret`,
    groupId: null,
    alerts: [],
    srtBonding: idleBonding(),
    input,
    outs,
    renditions: [],
    ...extra,
});

const leg = (over = {}) => ({
    ip: '203.0.113.10',
    state: 'running',
    health: 'ok',
    healthReason: null,
    recvRateMbps: null,
    ...over,
});

// A relay input that is flowing into SRS; `bonded` makes it a two-leg group.
const relayPipeline = (id, { bonded = false, bondingOver = {}, legs } = {}) => {
    const base = idleBonding();
    return pipeline(id, liveInput({ publisherIp: '127.0.0.1' }), [], {
        srtBonding: {
            ...base,
            inputActive: true,
            outputConnected: true,
            acceptedBySrs: true,
            forwardedPackets: 500,
            lastPacketAt: NOW - 1000,
            lastInputPacketAt: NOW - 1000,
            input: {
                ...base.input,
                bonded,
                expectedLegs: bonded ? 2 : 1,
                legs: legs ?? (bonded ? [leg(), leg({ ip: '203.0.113.11' })] : [leg()]),
            },
            ...bondingOver,
        },
    });
};

const build = (pipelines, over = {}) =>
    buildOverviewModel({
        pipelines,
        metrics: {},
        relayProcessRunning: true,
        nowMs: NOW,
        filter: 'all',
        inputSearch: '',
        outputSearch: '',
        ...over,
    });

const outputNames = (table) => table.rows.map((r) => r.output.name);

describe('an output table under the All / Active / Issues filter', () => {
    const pipelines = () => [
        pipeline(1, liveInput(), [output('ok'), warning('warn'), failed('err'), stopped('off')]),
    ];

    test('All lists every output', () => {
        assert.deepEqual(outputNames(build(pipelines()).outputs), [
            'Out ok',
            'Out warn',
            'Out err',
            'Out off',
        ]);
    });

    test('Issues lists the warnings and errors only', () => {
        const { outputs } = build(pipelines(), { filter: 'problems' });
        assert.deepEqual(outputNames(outputs), ['Out warn', 'Out err']);
    });

    test('Active leaves out the stopped ones', () => {
        const { outputs } = build(pipelines(), { filter: 'active' });
        assert.deepEqual(outputNames(outputs), ['Out ok', 'Out warn', 'Out err']);
    });

    test('the counts ignore the filter and the search', () => {
        for (const over of [
            { filter: 'all' },
            { filter: 'problems' },
            { filter: 'active', outputSearch: 'warn' },
        ]) {
            const { outputs } = build(pipelines(), over);
            assert.equal(outputs.total, 4);
            assert.equal(outputs.problems, 2);
            assert.equal(outputs.active, 3);
        }
    });

    test('each row carries its status', () => {
        const { outputs } = build(pipelines());
        assert.deepEqual(
            outputs.rows.map((r) => r.status),
            ['good', 'warn', 'error', 'off'],
        );
    });
});

describe('the Outputs search box', () => {
    const pipelines = () => [
        pipeline(1, liveInput(), [output('yt', { name: 'YouTube EN' }), output('tw')]),
        pipeline(2, liveInput(), [output('fb', { url: 'rtmps://fb.example/rtmp/abcd-1234' })]),
    ];

    test('matches the pipeline name, the output name or the destination URL', () => {
        assert.deepEqual(outputNames(build(pipelines(), { outputSearch: 'youtube' }).outputs), [
            'YouTube EN',
        ]);
        assert.deepEqual(outputNames(build(pipelines(), { outputSearch: 'pipeline 2' }).outputs), [
            'Out fb',
        ]);
        assert.deepEqual(outputNames(build(pipelines(), { outputSearch: 'abcd-1234' }).outputs), [
            'Out fb',
        ]);
    });

    test('a search with no match says so, quoting the trimmed query as plain text', () => {
        const { outputs } = build(pipelines(), { outputSearch: '  <b>zzz</b> ' });
        assert.deepEqual(outputs.rows, []);
        assert.equal(outputs.empty, 'No outputs match “<b>zzz</b>”.');
    });

    test('the search message wins over the filter message', () => {
        const { outputs } = build(pipelines(), { filter: 'problems', outputSearch: 'zzz' });
        assert.equal(outputs.empty, 'No outputs match “zzz”.');
    });

    test('a search that leaves rows has no empty message', () => {
        assert.equal(build(pipelines(), { outputSearch: 'out' }).outputs.empty, null);
    });
});

describe('the sentence an empty table shows', () => {
    const healthy = () => [pipeline(1, liveInput(), [output('a')])];
    const idle = () => [pipeline(1, offInput(), [stopped('a')])];

    test('says there is nothing to list when there are no pipelines or outputs at all', () => {
        const none = build([]);
        assert.equal(none.inputs.empty, 'No pipelines yet.');
        assert.equal(none.outputs.empty, 'No outputs yet.');
        // The relay and shared-encode tables are left out instead.
        assert.equal(none.relay.empty, null);
        assert.equal(none.sharedEncodes.empty, null);
        // A filter does not change that.
        assert.equal(build([], { filter: 'problems' }).inputs.empty, 'No pipelines yet.');
    });

    test('names what the Issues filter found nothing of', () => {
        const m = build(healthy(), { filter: 'problems' });
        assert.equal(m.inputs.empty, 'No input issues.');
        assert.equal(m.outputs.empty, 'No output issues.');
    });

    test('names what the Active filter found nothing of', () => {
        const m = build(idle(), { filter: 'active' });
        assert.equal(m.inputs.empty, 'No active inputs.');
        assert.equal(m.outputs.empty, 'No active outputs.');
    });

    test('has no sentence while the table has rows', () => {
        const m = build(healthy());
        assert.equal(m.inputs.empty, null);
        assert.equal(m.outputs.empty, null);
    });
});

describe('the Inputs table', () => {
    test('an offline input whose outputs should be running is an issue, not active', () => {
        const pipelines = [pipeline(1, offInput(), [output('a'), output('b'), stopped('c')])];
        const issues = build(pipelines, { filter: 'problems' }).inputs;
        assert.equal(issues.rows.length, 1);
        assert.equal(issues.rows[0].status, 'off');
        assert.equal(issues.rows[0].affectedOutputs, 2);
        assert.equal(issues.problems, 1);
        // It is also offline, so Active leaves it out.
        const active = build(pipelines, { filter: 'active' }).inputs;
        assert.deepEqual(active.rows, []);
        assert.equal(active.active, 0);
        assert.equal(active.empty, 'No active inputs.');
    });

    test('an offline input with only stopped outputs is neither', () => {
        const pipelines = [pipeline(1, offInput(), [stopped('a')])];
        const { inputs } = build(pipelines);
        assert.equal(inputs.rows[0].affectedOutputs, 0);
        assert.equal(inputs.problems, 0);
        assert.equal(inputs.active, 0);
    });

    test('a live input with a media error is an issue by itself', () => {
        const pipelines = [
            pipeline(1, liveInput({ mediaOk: false, mediaError: 'No video' }), [output('a')]),
        ];
        const { inputs } = build(pipelines, { filter: 'problems' });
        assert.equal(inputs.rows[0].status, 'error');
        assert.equal(inputs.rows[0].affectedOutputs, 0);
    });

    test('the search matches the name, the stream key and both publish URLs', () => {
        const pipelines = [
            pipeline(1, liveInput(), []),
            pipeline(2, liveInput(), [], { name: 'Hall' }),
        ];
        const ids = (over) => build(pipelines, over).inputs.rows.map((r) => r.pipeline.id);
        assert.deepEqual(ids({ inputSearch: 'hall' }), ['2']);
        assert.deepEqual(ids({ inputSearch: 'KEY01_SECRET' }), ['1']);
        assert.deepEqual(ids({ inputSearch: 'srv.example/live/key02' }), ['2']);
        assert.deepEqual(ids({ inputSearch: 'streamid=publish:live/key01' }), ['1']);
        assert.equal(
            build(pipelines, { inputSearch: 'nope' }).inputs.empty,
            'No inputs match “nope”.',
        );
    });

    test('the Outputs search does not touch the Inputs table', () => {
        const pipelines = [pipeline(1, liveInput(), [output('a')])];
        assert.equal(build(pipelines, { outputSearch: 'zzz' }).inputs.rows.length, 1);
    });
});

describe('the SRT Relay table', () => {
    test('is left out when no pipeline has used the relay', () => {
        const { relay } = build([pipeline(1, liveInput(), [])]);
        assert.equal(relay.total, 0);
        assert.deepEqual(relay.rows, []);
        assert.equal(relay.empty, null);
        assert.equal(relay.legIpHeader, 'Source IP');
    });

    test('lists a flowing relay input as healthy and active', () => {
        const { relay } = build([relayPipeline(1)]);
        assert.equal(relay.total, 1);
        assert.equal(relay.rows[0].relay.input, 'good');
        assert.equal(relay.problems, 0);
        assert.equal(relay.active, 1);
    });

    test('takes the clock it is given: stale packets are a problem', () => {
        const stale = build([relayPipeline(1)], { nowMs: NOW + 20_000, filter: 'problems' });
        assert.equal(stale.relay.rows.length, 1);
        assert.equal(stale.relay.problems, 1);
        const fresh = build([relayPipeline(1)], { filter: 'problems' });
        assert.deepEqual(fresh.relay.rows, []);
        assert.equal(fresh.relay.empty, 'No relay issues.');
    });

    test('Active drops a session that is idle on both sides', () => {
        // The relay saw packets once, but the input is not active now.
        const idle = relayPipeline(1, { bondingOver: { inputActive: false } });
        const { relay } = build([idle], { filter: 'active' });
        assert.deepEqual(relay.rows, []);
        assert.equal(relay.empty, 'No active relay sessions.');
        assert.equal(relay.total, 1);
        assert.equal(relay.active, 0);
    });

    test('the leg column is named for what the inputs are', () => {
        assert.equal(build([relayPipeline(1)]).relay.legIpHeader, 'Source IP');
        assert.equal(build([relayPipeline(1, { bonded: true })]).relay.legIpHeader, 'Leg IP');
        assert.equal(
            build([relayPipeline(1), relayPipeline(2, { bonded: true })]).relay.legIpHeader,
            'Leg / Source IP',
        );
    });

    test('a relay input that has not delivered a packet is not listed', () => {
        assert.equal(build([pipeline(1, offInput(), [])]).relay.total, 0);
    });
});

describe('the Shared encodes table', () => {
    const withEncodes = () => [
        pipeline(1, liveInput(), [output('a')], {
            renditions: [
                output('r1', { videoEncoding: '720p', audioEncoding: '1' }),
                output('r2', { audioEncoding: '0', status: 'failed', lastError: 'Boom' }),
            ],
        }),
    ];

    test('are kept out of the Outputs table and counts', () => {
        const m = build(withEncodes());
        assert.deepEqual(outputNames(m.outputs), ['Out a']);
        assert.equal(m.outputs.total, 1);
        assert.equal(m.sharedEncodes.total, 2);
    });

    test('are judged like outputs', () => {
        const m = build(withEncodes(), { filter: 'problems' });
        assert.deepEqual(outputNames(m.sharedEncodes), ['Out r2']);
        assert.equal(m.sharedEncodes.problems, 1);
    });

    test('the Outputs search matches the pipeline or the encode label', () => {
        const names = (outputSearch) =>
            outputNames(build(withEncodes(), { outputSearch }).sharedEncodes);
        assert.deepEqual(names('720p'), ['Out r1']);
        assert.deepEqual(names('t1'), ['Out r2']);
        assert.deepEqual(names('pipeline 1'), ['Out r1', 'Out r2']);
        assert.equal(
            build(withEncodes(), { outputSearch: 'zzz' }).sharedEncodes.empty,
            'No shared encodes match “zzz”.',
        );
    });

    test('name what a filter found none of', () => {
        const healthy = [
            pipeline(1, liveInput(), [output('a')], {
                renditions: [output('r1', { videoEncoding: '720p' })],
            }),
        ];
        assert.equal(
            build(healthy, { filter: 'problems' }).sharedEncodes.empty,
            'No shared encode issues.',
        );
        const stoppedEncode = [
            pipeline(1, liveInput(), [output('a')], { renditions: [stopped('r1')] }),
        ];
        assert.equal(
            build(stoppedEncode, { filter: 'active' }).sharedEncodes.empty,
            'No active shared encodes.',
        );
    });
});

describe('the All / Active / Issues chip totals', () => {
    test('add the four tables, counting an offline input with affected outputs once as an issue', () => {
        const pipelines = [
            relayPipeline(1),
            pipeline(2, offInput(), [output('a'), stopped('b')], {
                renditions: [warning('r1')],
            }),
        ];
        const m = build(pipelines);
        // relay 1 + inputs 2 + outputs 2 + shared encodes 1
        assert.equal(m.totals.all, 6);
        assert.equal(
            m.totals.active,
            m.relay.active + m.inputs.active + m.outputs.active + m.sharedEncodes.active,
        );
        assert.equal(
            m.totals.problems,
            m.relay.problems + m.inputs.problems + m.outputs.problems + m.sharedEncodes.problems,
        );
        // Input 2 is offline with a running output: an issue, and that output warns.
        assert.equal(m.inputs.problems, 1);
        assert.equal(m.outputs.problems, 1);
        assert.equal(m.sharedEncodes.problems, 1);
        assert.equal(m.totals.problems, 3);
    });

    test('do not change with the filter', () => {
        const pipelines = [pipeline(1, liveInput(), [output('a'), failed('b')])];
        const all = build(pipelines).totals;
        assert.deepEqual(build(pipelines, { filter: 'problems' }).totals, all);
        assert.deepEqual(build(pipelines, { filter: 'active' }).totals, all);
    });
});

describe('the System usage figures', () => {
    const unreported = { node: null, srs: null, relay: null, outs: null, app: null, system: null };

    test('are all unreported when nothing reports', () => {
        const { usage } = build([
            pipeline(1, liveInput({ recvBitrateKbps: null }), [output('a', { bitrateKbps: null })]),
        ]);
        assert.equal(usage.uptimeSeconds, null);
        for (const row of ['cpuPercent', 'ramBytes', 'downlinkKbps', 'uplinkKbps']) {
            assert.deepEqual(usage[row], unreported, row);
        }
    });

    test('the App column sums only what reported, and stays unreported when nothing did', () => {
        const metrics = {
            node: { cpuPercent: 10, ramBytes: 100 },
            srs: { cpuPercent: null, ramBytes: null },
            relay: { cpuPercent: 5, ramBytes: 50 },
        };
        const pipelines = [
            pipeline(1, liveInput(), [output('a', { cpuPercent: 20, memoryUsageBytes: 1000 })], {
                renditions: [output('r', { cpuPercent: 100, memoryUsageBytes: 4000 })],
            }),
            pipeline(2, liveInput(), [output('b', { cpuPercent: 0, memoryUsageBytes: null })]),
        ];
        const { usage } = build(pipelines, { metrics });
        assert.deepEqual(usage.cpuPercent, {
            node: 10,
            srs: null,
            relay: 5,
            // Outputs and shared encodes together.
            outs: 120,
            app: 135,
            system: null,
        });
        assert.deepEqual(usage.ramBytes, {
            node: 100,
            srs: null,
            relay: 50,
            outs: 5000,
            app: 5150,
            system: null,
        });
    });

    test('a zero is a figure, not a missing one', () => {
        const pipelines = [pipeline(1, liveInput(), [output('a', { cpuPercent: 0 })])];
        assert.equal(build(pipelines).usage.cpuPercent.outs, 0);
        assert.equal(build(pipelines).usage.cpuPercent.app, 0);
    });

    test('the System column scales the machine CPU to one core and converts bytes to bits', () => {
        const metrics = {
            cpu: { cores: 4, percent: 25 },
            ram: { usedBytes: 2048, totalBytes: 4096 },
            net: { rxBytesPerSec: 125_000, txBytesPerSec: 250_000 },
            uptimeSeconds: 90,
        };
        const { usage } = build([], { metrics });
        assert.equal(usage.cpuPercent.system, 100);
        assert.equal(usage.ramBytes.system, 2048);
        assert.equal(usage.downlinkKbps.system, 1000);
        assert.equal(usage.uplinkKbps.system, 2000);
        assert.equal(usage.uptimeSeconds, 90);
    });

    test('downlink leaves out publishers on loopback, which the relay or a restream feeds', () => {
        const pipelines = [
            pipeline(1, liveInput({ recvBitrateKbps: 3000, publisherIp: '198.51.100.7' }), []),
            pipeline(2, liveInput({ recvBitrateKbps: 5000, publisherIp: '127.0.0.1' }), []),
            pipeline(3, liveInput({ recvBitrateKbps: 7000, publisherIp: 'localhost' }), []),
            pipeline(4, liveInput({ recvBitrateKbps: 100, publisherIp: null }), []),
        ];
        assert.equal(build(pipelines).usage.downlinkKbps.srs, 3100);
    });

    test('downlink adds what the relay pulls in across its legs, in kbps', () => {
        const relay = relayPipeline(1, {
            bonded: true,
            legs: [leg({ recvRateMbps: 2 }), leg({ ip: '203.0.113.11', recvRateMbps: 3 })],
        });
        const direct = pipeline(2, liveInput({ recvBitrateKbps: 1000 }), []);
        const { downlinkKbps } = build([relay, direct]).usage;
        assert.equal(downlinkKbps.relay, 5000);
        // The relay input reaches SRS over loopback, so only the direct one counts there.
        assert.equal(downlinkKbps.srs, 1000);
        assert.equal(downlinkKbps.app, 6000);
    });

    test('uplink counts the outputs that push out, not those chained to this server', () => {
        const pipelines = [
            pipeline(1, liveInput(), [
                output('out', { bitrateKbps: 4000, url: 'rtmp://a.rtmp.youtube.com/live2/k' }),
                output('chain', { bitrateKbps: 4000, url: 'rtmp://127.0.0.1:1935/live/key02_x' }),
                output('local', { bitrateKbps: 4000, url: 'rtmp://localhost/live/key02_x' }),
                output('srt', { bitrateKbps: 1000, url: 'srt://dest.example:9000' }),
                output('idle', { bitrateKbps: null, url: 'rtmp://b.example/live/k' }),
            ]),
        ];
        const { uplinkKbps } = build(pipelines).usage;
        assert.equal(uplinkKbps.outs, 5000);
        assert.equal(uplinkKbps.app, 5000);
    });

    test('an unparseable destination still counts as uplink', () => {
        const pipelines = [
            pipeline(1, liveInput(), [output('odd', { bitrateKbps: 700, url: 'not a url' })]),
        ];
        assert.equal(build(pipelines).usage.uplinkKbps.outs, 700);
    });

    test('are the whole system, so the filter and searches leave them alone', () => {
        const pipelines = [
            pipeline(1, liveInput(), [output('a', { cpuPercent: 30 }), stopped('b')]),
        ];
        const all = build(pipelines).usage;
        assert.deepEqual(build(pipelines, { filter: 'problems', outputSearch: 'zzz' }).usage, all);
    });
});
