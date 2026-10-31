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
    srtBonding: { acceptedBySrs: false, input: { bonded: false } },
    input,
    outs,
    renditions: [],
    ...extra,
});

describe('buildStatusCards', () => {
    test('a live input with running outputs is healthy', () => {
        const [card] = buildStatusCards([pipeline(1, liveInput(), [output('a'), output('b')])]);
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
        const [card] = buildStatusCards([pipeline(1, liveInput(), [warning('a')])]);
        assert.equal(card.dots[0].name, 'Out a');
        assert.equal(card.dots[0].status, 'warn');
        assert.equal(card.dots[0].message, 'Timestamp discontinuities');
    });

    test('a failed output is an error and the card an issue', () => {
        const [card] = buildStatusCards([pipeline(1, liveInput(), [output('a'), failed('b')])]);
        assert.deepEqual(
            card.dots.map((d) => d.status),
            ['good', 'error'],
        );
        assert.equal(card.severity, 'error');
        assert.equal(card.hasIssue, true);
    });

    test('a stopped output is neither a problem nor healthy', () => {
        const [card] = buildStatusCards([pipeline(1, liveInput(), [output('a'), stopped('b')])]);
        assert.equal(card.dots[1].status, 'off');
        assert.equal(card.hasIssue, false);
    });

    test('an offline input with no running outputs is not an issue', () => {
        const [card] = buildStatusCards([pipeline(1, offInput(), [stopped('a'), stopped('b')])]);
        assert.equal(card.inputStatus, 'off');
        assert.equal(card.hasIssue, false);
        assert.equal(card.type, '');
    });

    test('an offline input whose outputs should be running is an issue through them', () => {
        const [card] = buildStatusCards([pipeline(1, offInput(), [output('a')])]);
        assert.equal(card.dots[0].status, 'warn');
        assert.equal(card.hasIssue, true);
    });

    test('an input with a media problem is an issue even when its outputs are fine', () => {
        const [card] = buildStatusCards([
            pipeline(1, liveInput({ mediaOk: false, mediaError: 'No video' }), [output('a')]),
        ]);
        assert.equal(card.inputStatus, 'error');
        assert.equal(card.inputMessage, 'No video');
        assert.equal(card.hasIssue, true);
        assert.equal(card.severity, 'error');
    });

    test('the type shows how the input arrives', () => {
        const type = (p) => buildStatusCards([p])[0].type;
        assert.equal(type(pipeline(1, liveInput({ isSrt: true }), [])), 'SRT');
        const relay = (bonded) => ({ acceptedBySrs: true, input: { bonded } });
        assert.equal(type(pipeline(1, liveInput(), [], { srtBonding: relay(true) })), 'Bonded');
        assert.equal(type(pipeline(1, liveInput(), [], { srtBonding: relay(false) })), 'Relay');
    });
});

describe('statusTotals', () => {
    test('counts inputs and outputs, and the pipelines with issues', () => {
        const cards = buildStatusCards([
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
    const cards = buildStatusCards([
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
        const healthy = buildStatusCards([pipeline(1, liveInput(), [output('a')])]);
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
