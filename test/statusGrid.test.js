'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    buildStatusCards,
    groupStatusCards,
    problemEvents,
    statusTotals,
} = require('../public/ts/core/status-grid');

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
    desiredState: 'running',
    status: 'running',
    pid: 1,
    bitrateKbps: 4000,
    startedAtMs: 1,
    failures: 0,
    nextRetryAtMs: null,
    warningReason: null,
    warningSinceMs: null,
    lastError: null,
    hasErrorHistory: false,
    lastErrorAt: null,
    sharedEncode: null,
    renditionId: null,
    ...overrides,
});

const stopped = (id) => output(id, { desiredState: 'stopped', status: 'stopped', pid: null });
const failed = (id) =>
    output(id, {
        status: 'failed',
        bitrateKbps: null,
        lastError: 'Connection refused',
        lastErrorAt: 5,
    });
const warning = (id) => output(id, { warningReason: 'Timestamp discontinuities' });

const pipeline = (id, input, outs, extra = {}) => ({
    id: String(id),
    name: `Pipeline ${id}`,
    groupId: null,
    alerts: [],
    srtBonding: { acceptedBySrs: false, input: { bonded: false } },
    input,
    outs,
    renditions: [],
    ...extra,
});

const NOW = 1_000_000;
const RELAY_UP = { relayProcessRunning: true, nowMs: NOW };
const cardsOf = (pipelines, relay = RELAY_UP) => buildStatusCards(pipelines, relay);

// A bonded relay input whose SRS side is accepted and flowing, with the given legs.
const relayPipeline = (legs, srtBonding = {}, extra = {}) =>
    pipeline(1, liveInput({ isSrt: true }), [output('a')], {
        srtBonding: {
            inputActive: true,
            outputConnected: true,
            acceptedBySrs: true,
            publishConflict: false,
            localSrtPublisherConflict: false,
            retryFailures: 0,
            forwardedPackets: 500,
            lastPacketAt: NOW - 1000,
            lastInputPacketAt: NOW - 1000,
            lastError: null,
            input: { bonded: true, expectedLegs: legs.length, legs },
            ...srtBonding,
        },
        ...extra,
    });
const okLeg = (ip) => ({ ip, state: 'running', health: 'ok', healthReason: null });

describe('buildStatusCards', () => {
    test('a bonded relay leg with a warning shows on the card, as it does in the sidebar', () => {
        const [card] = cardsOf([
            relayPipeline([
                okLeg('203.0.113.10'),
                {
                    ip: '203.0.113.11',
                    state: 'running',
                    health: 'warn',
                    healthReason: 'Leg packet quality is degraded over the last minute',
                },
            ]),
        ]);
        assert.equal(card.type, 'Bonded');
        assert.equal(card.inputStatus, 'warn');
        assert.match(card.inputMessage, /Leg 203\.0\.113\.11: Leg packet quality is degraded/);
        assert.equal(card.severity, 'warn');
        assert.equal(card.hasIssue, true);
        assert.equal(statusTotals([card]).inputs.problem, 1);
    });

    test('a lost bonded leg warns on the card even when the media input itself is fine', () => {
        const [card] = cardsOf([
            relayPipeline([okLeg('203.0.113.10')], {
                input: { bonded: true, expectedLegs: 2, legs: [okLeg('203.0.113.10')] },
            }),
        ]);
        assert.equal(card.inputStatus, 'warn');
        assert.match(card.inputMessage, /1 of 2 bonded legs down/);
    });

    test('a relay forward that cannot reach SRS makes the card an error', () => {
        const [card] = cardsOf([
            relayPipeline([okLeg('a'), okLeg('b')], {
                outputConnected: false,
                lastError: 'refused',
            }),
        ]);
        assert.equal(card.inputStatus, 'error');
        assert.match(card.inputMessage, /Relay output reconnecting: refused/);
        assert.equal(card.severity, 'error');
    });

    test('a healthy relay leaves the card good, and a relay that is down is ignored', () => {
        const healthy = relayPipeline([okLeg('a'), okLeg('b')]);
        assert.equal(cardsOf([healthy])[0].inputStatus, 'good');
        assert.equal(cardsOf([healthy])[0].hasIssue, false);
        const lostLeg = relayPipeline([okLeg('a')], {
            input: { bonded: true, expectedLegs: 2, legs: [okLeg('a')] },
        });
        const down = cardsOf([lostLeg], { relayProcessRunning: false, nowMs: NOW })[0];
        assert.equal(down.inputStatus, 'good');
    });

    test('an input problem stays the first message when the relay has one too', () => {
        const [card] = cardsOf([
            relayPipeline(
                [okLeg('a')],
                { input: { bonded: true, expectedLegs: 2, legs: [okLeg('a')] } },
                {
                    input: liveInput({ isSrt: true, mediaOk: false, mediaError: 'No video' }),
                },
            ),
        ]);
        assert.equal(card.inputStatus, 'error');
        assert.match(card.inputMessage, /No video/);
    });

    test('a live input with running outputs is healthy', () => {
        const [card] = cardsOf([pipeline(1, liveInput(), [output('a'), output('b')])]);
        assert.equal(card.inputStatus, 'good');
        assert.deepEqual(
            card.dots.map((d) => d.status),
            ['good', 'good'],
        );
        assert.equal(card.hasIssue, false);
        assert.equal(card.severity, 'none');
        assert.equal(card.type, 'RTMP');
    });

    test('a dot carries the output name and what is wrong', () => {
        const [card] = cardsOf([pipeline(1, liveInput(), [warning('a')])]);
        assert.equal(card.dots[0].name, 'Out a');
        assert.equal(card.dots[0].status, 'warn');
        assert.equal(card.dots[0].message, 'Timestamp discontinuities');
    });

    test('a failed output is an error and the card an issue', () => {
        const [card] = cardsOf([pipeline(1, liveInput(), [output('a'), failed('b')])]);
        assert.deepEqual(
            card.dots.map((d) => d.status),
            ['good', 'error'],
        );
        assert.equal(card.severity, 'error');
        assert.equal(card.hasIssue, true);
    });

    test('a stopped output is neither a problem nor healthy', () => {
        const [card] = cardsOf([pipeline(1, liveInput(), [output('a'), stopped('b')])]);
        assert.equal(card.dots[1].status, 'off');
        assert.equal(card.hasIssue, false);
    });

    test('an offline input with no running outputs is not an issue', () => {
        const [card] = cardsOf([pipeline(1, offInput(), [stopped('a'), stopped('b')])]);
        assert.equal(card.inputStatus, 'off');
        assert.equal(card.hasIssue, false);
        assert.equal(card.type, '');
    });

    test('an offline input whose outputs should be running is an issue through them', () => {
        const [card] = cardsOf([pipeline(1, offInput(), [output('a')])]);
        assert.equal(card.dots[0].status, 'warn');
        assert.equal(card.hasIssue, true);
    });

    test('an input with a media problem is an issue even when its outputs are fine', () => {
        const [card] = cardsOf([
            pipeline(1, liveInput({ mediaOk: false, mediaError: 'No video' }), [output('a')]),
        ]);
        assert.equal(card.inputStatus, 'error');
        assert.equal(card.inputMessage, 'No video');
        assert.equal(card.hasIssue, true);
        assert.equal(card.severity, 'error');
    });

    test('the type shows how the input arrives', () => {
        const type = (p) => cardsOf([p])[0].type;
        assert.equal(type(pipeline(1, liveInput({ isSrt: true }), [])), 'SRT');
        const relay = (bonded) => ({ acceptedBySrs: true, input: { bonded } });
        assert.equal(type(pipeline(1, liveInput(), [], { srtBonding: relay(true) })), 'Bonded');
        assert.equal(type(pipeline(1, liveInput(), [], { srtBonding: relay(false) })), 'Relay');
    });
});

describe('statusTotals', () => {
    test('counts inputs and outputs, and the pipelines with issues', () => {
        const cards = cardsOf([
            pipeline(1, liveInput(), [output('a'), warning('b'), failed('c'), stopped('d')]),
            pipeline(2, offInput(), [stopped('e')]),
            pipeline(3, liveInput({ mediaOk: false, mediaError: 'x' }), []),
            pipeline(4, liveInput(), [output('f')]),
        ]);
        const totals = statusTotals(cards);
        assert.deepEqual(totals.inputs, { good: 2, problem: 1, off: 1 });
        assert.deepEqual(totals.outputs, { good: 2, warn: 1, error: 1, off: 2 });
        assert.equal(totals.pipelinesWithIssues, 2);
    });

    test('is all zeros with no pipelines', () => {
        assert.deepEqual(statusTotals([]), {
            inputs: { good: 0, problem: 0, off: 0 },
            outputs: { good: 0, warn: 0, error: 0, off: 0 },
            pipelinesWithIssues: 0,
        });
    });
});

describe('groupStatusCards', () => {
    const cards = cardsOf([
        pipeline(1, liveInput(), [output('a')], { groupId: 20 }),
        pipeline(2, liveInput(), [failed('b')], { groupId: 10 }),
        pipeline(3, liveInput(), [output('c')], { groupId: null }),
        pipeline(4, liveInput(), [output('d')], { groupId: 99 }),
    ]);
    const groups = [
        { id: 10, name: 'Main', position: 2 },
        { id: 20, name: 'Hall', position: 1 },
    ];

    test('groups come by position, then the ungrouped, each in pipeline order', () => {
        const result = groupStatusCards(cards, groups, false);
        assert.deepEqual(
            result.map((g) => [g.name, g.cards.map((c) => c.id)]),
            [
                ['Hall', ['1']],
                ['Main', ['2']],
                ['Ungrouped', ['3', '4']],
            ],
        );
    });

    test('a pipeline whose group was deleted counts as ungrouped', () => {
        const ungrouped = groupStatusCards(cards, groups, false).at(-1);
        assert.ok(ungrouped.cards.some((c) => c.id === '4'));
    });

    test('with no groups at all the cards are one unnamed list', () => {
        const result = groupStatusCards(cards, [], false);
        assert.equal(result.length, 1);
        assert.equal(result[0].name, '');
        assert.equal(result[0].cards.length, 4);
    });

    test('issues only keeps the cards with an issue and drops empty groups', () => {
        const result = groupStatusCards(cards, groups, true);
        assert.deepEqual(
            result.map((g) => [g.name, g.cards.map((c) => c.id)]),
            [['Main', ['2']]],
        );
    });

    test('issues only with no issues anywhere is empty', () => {
        const healthy = cardsOf([pipeline(1, liveInput(), [output('a')])]);
        assert.deepEqual(groupStatusCards(healthy, [], true), []);
    });
});

describe('problemEvents', () => {
    const ev = (ts, severity) => ({ ts, severity, label: 'x', message: '' });
    // The API order: newest first.
    const events = [ev(5, 'ok'), ev(4, 'error'), ev(3, 'info'), ev(2, 'warning'), ev(1, 'error')];

    test('keeps warnings and errors, oldest first', () => {
        assert.deepEqual(
            problemEvents(events, 10).map((e) => e.ts),
            [1, 2, 4],
        );
    });

    test('keeps the newest `max` of them', () => {
        assert.deepEqual(
            problemEvents(events, 2).map((e) => e.ts),
            [2, 4],
        );
    });

    test('does not reorder the list it is given', () => {
        problemEvents(events, 10);
        assert.deepEqual(
            events.map((e) => e.ts),
            [5, 4, 3, 2, 1],
        );
    });
});
