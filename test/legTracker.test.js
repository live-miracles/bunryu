'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createLegTracker } = require('../src/services/legTracker');

const POLL = 5000;

function setup() {
    const logs = [];
    const events = [];
    const tracker = createLegTracker({
        historyMaxSamples: 4,
        pollIntervalMs: POLL,
        healthWindowMs: 60_000,
        appendPipelineLog: (pipelineId, event, message) =>
            logs.push({ pipelineId, event, message }),
        diagnostics: { event: (name, fields) => events.push({ name, ...fields }) },
    });
    return { tracker: withFlow(tracker), logs, events };
}

// Unless a test pins a leg's packet count, packets keep arriving: the count is the
// time of the poll.
function withFlow(tracker) {
    return {
        ...tracker,
        observe: (pipelineId, inp, active, now) =>
            tracker.observe(
                pipelineId,
                { ...inp, legs: inp.legs.map((l) => ({ ...l, recvPacketsTotal: now })) },
                active,
                now,
            ),
    };
}

const leg = (ip, over = {}) => ({
    ip,
    port: 4000,
    state: 'running',
    recvLossTotal: 0,
    recvDropTotal: 0,
    retransTotal: 0,
    belatedTotal: 0,
    recvRateMbps: 5,
    rttMs: 30,
    latencyMs: 120,
    ...over,
});

const input = (legs, bonded = true) => ({ bonded, legs });
const codes = (obs) => obs.alerts.map((a) => a.code);

describe('leg group', () => {
    test('a bonded group that lost a leg alerts with how many are down, until it is whole again', () => {
        const { tracker } = setup();
        const both = input([leg('10.0.0.1'), leg('10.0.0.2')]);
        const one = input([leg('10.0.0.1')]);

        let obs = tracker.observe(1, both, true, 1000);
        assert.equal(obs.expectedLegs, 2);
        assert.deepEqual(codes(obs), []);

        obs = tracker.observe(1, one, true, 6000);
        assert.equal(obs.expectedLegs, 2);
        assert.deepEqual(obs.alerts[0], {
            severity: 'warning',
            code: 'bonded-leg-down',
            message: '1 of 2 bonded legs is down.',
            sinceMs: 6000,
        });

        // The alert keeps the time the leg went missing.
        obs = tracker.observe(1, one, true, 11_000);
        assert.equal(obs.alerts[0].sinceMs, 6000);

        obs = tracker.observe(1, both, true, 16_000);
        assert.deepEqual(codes(obs), []);
    });

    test('the group is forgotten when the input goes away, and when the pipeline is deleted', () => {
        const { tracker } = setup();
        tracker.observe(1, input([leg('10.0.0.1'), leg('10.0.0.2')]), true, 1000);
        tracker.observe(1, input([]), false, 6000);
        // A new, smaller group starts from what it has now.
        const obs = tracker.observe(1, input([leg('10.0.0.1')]), true, 11_000);
        assert.equal(obs.expectedLegs, 1);
        assert.deepEqual(codes(obs), []);

        tracker.observe(2, input([leg('10.0.1.1')]), true, 11_000);
        tracker.keepOnly(new Set([2]));
        assert.deepEqual(tracker.history(1), []);
        assert.equal(tracker.history(2).length, 1);
    });

    test('a plain input reports what the relay lists as its legs', () => {
        const { tracker } = setup();
        const obs = tracker.observe(1, input([leg('203.0.113.9')], false), true, 1000);
        assert.equal(obs.expectedLegs, 1);
        assert.deepEqual(codes(obs), []);
    });
});

describe('leg changes in the pipeline log and diagnostics', () => {
    test('a leg joining or leaving is recorded once, with the legs it concerns', () => {
        const { tracker, logs, events } = setup();
        tracker.observe(1, input([leg('10.0.0.1')]), true, 1000);
        assert.equal(events.length, 1, 'the first poll records the legs it starts with');
        assert.match(logs[0].message, /^Bonded input connected with 1 leg/);
        tracker.observe(1, input([leg('10.0.0.1'), leg('10.0.0.2')]), true, 6000);
        assert.equal(events.length, 2);
        assert.equal(events[1].name, 'bonded-legs-changed');
        assert.deepEqual(events[1].joined, ['10.0.0.2:4000']);
        assert.equal(logs.length, 2);
        assert.equal(logs[1].event, 'legs');
        // Unchanged legs leave no more lines.
        tracker.observe(1, input([leg('10.0.0.1'), leg('10.0.0.2')]), true, 11_000);
        assert.equal(events.length, 2);
        assert.equal(logs.length, 2);
    });

    test('a failing pipeline log never breaks the poll', () => {
        const tracker = createLegTracker({
            historyMaxSamples: 4,
            pollIntervalMs: POLL,
            healthWindowMs: 60_000,
            appendPipelineLog: () => {
                throw new Error('database is locked');
            },
        });
        tracker.observe(1, input([leg('10.0.0.1')]), true, 1000);
        assert.doesNotThrow(() =>
            tracker.observe(1, input([leg('10.0.0.1'), leg('10.0.0.2')]), true, 6000),
        );
    });
});

describe('leg health', () => {
    const health = (obs, key) => obs.legHealth.get(key);

    test('a leg that is not carrying packets is told apart from a standby', () => {
        const { tracker } = setup();
        const obs = tracker.observe(
            1,
            input([
                leg('10.0.0.1'),
                leg('10.0.0.2', { state: 'idle' }),
                leg('10.0.0.3', { state: 'pending' }),
                leg('10.0.0.4', { state: 'unknown' }),
            ]),
            true,
            1000,
        );
        assert.deepEqual(health(obs, '10.0.0.1:4000'), { health: 'ok', reason: null });
        assert.deepEqual(health(obs, '10.0.0.2:4000'), { health: 'ok', reason: null });
        assert.deepEqual(health(obs, '10.0.0.3:4000'), {
            health: 'warn',
            reason: 'Leg is pending.',
        });
        assert.deepEqual(health(obs, '10.0.0.4:4000'), {
            health: 'error',
            reason: 'Leg state is unknown.',
        });
    });

    test('an idle link with nothing else running is a warning, and a plain input says Connection', () => {
        const { tracker } = setup();
        const obs = tracker.observe(
            1,
            input([leg('203.0.113.9', { state: 'idle' })], false),
            true,
            1000,
        );
        assert.deepEqual(health(obs, '203.0.113.9:4000'), {
            health: 'warn',
            reason: 'Connection is idle.',
        });
    });

    test('a connected leg whose packet count stops for 10 s alerts, and clears when packets flow', () => {
        const { tracker } = setup();
        const at = (packets, now) =>
            tracker.observe(
                1,
                input([leg('10.0.0.1', { recvUniquePacketsTotal: packets })]),
                true,
                now,
            );
        assert.deepEqual(codes(at(100, 1000)), []);
        assert.deepEqual(codes(at(100, 6000)), []);
        assert.deepEqual(codes(at(100, 11_000)), [], 'quiet for 5 s is not yet 10 s');
        const stalled = at(100, 16_000);
        const noFlow = stalled.alerts.find((a) => a.code === 'bonded-leg-no-flow');
        assert.equal(noFlow.sinceMs, 6000);
        assert.equal(
            noFlow.message,
            'Bonded leg 10.0.0.1:4000 is connected but has stopped delivering packets.',
        );
        assert.equal(health(stalled, '10.0.0.1:4000').health, 'warn');
        assert.deepEqual(codes(stalled), ['bonded-leg-no-flow', 'bonded-leg-quality']);
        assert.deepEqual(codes(at(900, 21_000)), []);
    });

    test('a plain input names itself in the no-flow alert', () => {
        const { tracker } = setup();
        const plain = () => input([leg('203.0.113.9', { recvUniquePacketsTotal: 5 })], false);
        let obs;
        for (const now of [1000, 6000, 11_000, 16_000])
            obs = tracker.observe(1, plain(), true, now);
        assert.equal(
            obs.alerts.find((a) => a.code === 'bonded-leg-no-flow').message,
            'SRT input from 203.0.113.9:4000 is connected but has stopped delivering packets.',
        );
    });

    test('heavy loss over the last minute is a quality alert on that leg only', () => {
        const { tracker } = setup();
        const at = (received, lost, now) =>
            tracker.observe(
                1,
                input([
                    leg('10.0.0.1', { recvUniquePacketsTotal: received, recvLossTotal: lost }),
                    leg('10.0.0.2', { recvUniquePacketsTotal: received }),
                ]),
                true,
                now,
            );
        at(0, 0, 1000);
        const obs = at(1000, 50, 6000);
        assert.deepEqual(codes(obs), ['bonded-leg-quality']);
        assert.match(
            obs.alerts[0].message,
            /^Bonded leg 10\.0\.0\.1:4000: Leg packet quality is degraded/,
        );
        assert.equal(obs.alerts[0].severity, 'warning');
        assert.equal(health(obs, '10.0.0.1:4000').health, 'warn');
        assert.equal(health(obs, '10.0.0.2:4000').health, 'ok');
    });
});

describe('leg history', () => {
    test('keeps the newest samples up to the limit, with each interval as a percentage', () => {
        const { tracker } = setup();
        for (let i = 0; i < 6; i++) {
            tracker.observe(
                1,
                input([leg('10.0.0.1', { recvUniquePacketsTotal: i * 100, recvLossTotal: i })]),
                true,
                1000 + i * POLL,
            );
        }
        const [series] = tracker.history(1);
        assert.equal(series.ip, '10.0.0.1');
        assert.equal(series.samples.length, 4);
        assert.deepEqual(
            series.samples.map((s) => s.ts),
            [2, 3, 4, 5].map((i) => 1000 + i * POLL),
        );
        assert.equal(series.samples.at(-1).receivedPackets, 100);
        assert.equal(series.samples.at(-1).lossPct, 1);
    });

    test('a leg that has been gone longer than the history covers is dropped', () => {
        const { tracker } = setup();
        tracker.observe(1, input([leg('10.0.0.1')]), true, 1000);
        tracker.observe(1, input([leg('10.0.0.2')]), true, 1000 + POLL);
        assert.deepEqual(
            tracker
                .history(1)
                .map((s) => s.ip)
                .sort(),
            ['10.0.0.1', '10.0.0.2'],
        );
        // 4 samples x 5 s of history: after more than that, the first leg's series goes.
        tracker.observe(1, input([leg('10.0.0.2')]), true, 1000 + 5 * POLL);
        assert.deepEqual(
            tracker.history(1).map((s) => s.ip),
            ['10.0.0.2'],
        );
    });
});
