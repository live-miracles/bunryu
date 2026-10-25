'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { SRT_RECENT_WINDOW_MS, createSrtRecentTracker } = require('../src/utils/srtRecent');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function leg(ip, totals = {}) {
    return {
        ip,
        port: 40000,
        recvPacketsTotal: totals.packets ?? 0,
        recvUniquePacketsTotal: totals.packets ?? 0,
        recvLossTotal: totals.loss ?? 0,
        recvDropTotal: totals.drop ?? 0,
        retransTotal: totals.retrans ?? 0,
    };
}

// A bonded input reports drops only on the group; loss and retransmits are per leg.
function status({ packets = 0, drop = 0, legs = [], active = true, output = {} } = {}) {
    return {
        inputActive: active,
        outputConnected: output.connected ?? false,
        input: {
            recvUniquePacketsTotal: packets,
            recvLossTotal: null,
            retransTotal: null,
            recvDropTotal: drop,
            legs,
        },
        output: {
            sentPacketsTotal: output.packets ?? 0,
            sendLossTotal: output.loss ?? 0,
            retransTotal: output.retrans ?? 0,
            sendDropTotal: output.drop ?? 0,
        },
    };
}

describe('SRT recent counters', () => {
    test('has nothing to say after a single poll', () => {
        const tracker = createSrtRecentTracker();
        const recent = tracker.update(1, 0, status({ legs: [leg('203.0.113.1')] }));
        assert.equal(recent.input, null);
        assert.equal(recent.legs.get('203.0.113.1'), null);
    });

    test('reports how much each counter grew, with the span it covers', () => {
        const tracker = createSrtRecentTracker();
        tracker.update(1, 0, status({ packets: 1000, drop: 5, legs: [leg('a', { loss: 10 })] }));
        tracker.update(
            1,
            5 * SECOND,
            status({ packets: 1100, drop: 5, legs: [leg('a', { loss: 10 })] }),
        );
        const recent = tracker.update(
            1,
            10 * SECOND,
            status({ packets: 7000, drop: 8, legs: [leg('a', { packets: 7000, loss: 14 })] }),
        );
        assert.deepEqual(recent.input, {
            spanMs: 10 * SECOND,
            packets: 6000,
            loss: null,
            retrans: null,
            drop: 3,
        });
        assert.equal(recent.legs.get('a').loss, 4);
    });

    test('only counts the last ten minutes', () => {
        const tracker = createSrtRecentTracker();
        // 100 drops in minute 0..1, then nothing for twenty minutes.
        let recent;
        for (let t = 0; t <= 20 * MINUTE; t += 5 * SECOND) {
            const drop = t < MINUTE ? Math.round((t / MINUTE) * 100) : 100;
            recent = tracker.update(1, t, status({ drop, packets: t }));
        }
        assert.equal(recent.input.drop, 0);
        assert.ok(recent.input.spanMs <= SRT_RECENT_WINDOW_MS + 5 * SECOND);
        assert.ok(recent.input.spanMs >= SRT_RECENT_WINDOW_MS);
    });

    test('starts over when a counter goes backwards (the link reconnected)', () => {
        const tracker = createSrtRecentTracker();
        tracker.update(1, 0, status({ legs: [leg('a', { loss: 500 })] }));
        tracker.update(1, 5 * SECOND, status({ legs: [leg('a', { loss: 600 })] }));
        const recent = tracker.update(1, 10 * SECOND, status({ legs: [leg('a', { loss: 3 })] }));
        // Not "-597": the old session's counts are gone, and one poll has no span.
        assert.equal(recent.legs.get('a'), null);
        const next = tracker.update(1, 15 * SECOND, status({ legs: [leg('a', { loss: 4 })] }));
        assert.equal(next.legs.get('a').loss, 1);
    });

    test('starts over after a gap between polls', () => {
        const tracker = createSrtRecentTracker();
        tracker.update(1, 0, status({ legs: [leg('a', { loss: 5 })] }));
        tracker.update(1, 5 * SECOND, status({ legs: [leg('a', { loss: 6 })] }));
        // The leg was gone for a minute and came back with higher counters from a new session.
        const recent = tracker.update(1, 70 * SECOND, status({ legs: [leg('a', { loss: 9 })] }));
        assert.equal(recent.legs.get('a'), null);
    });

    test('forgets the input when it goes inactive', () => {
        const tracker = createSrtRecentTracker();
        tracker.update(1, 0, status({ drop: 1 }));
        tracker.update(1, 5 * SECOND, status({ drop: 2 }));
        const gone = tracker.update(1, 10 * SECOND, status({ active: false, drop: 2 }));
        assert.equal(gone.input, null);
        tracker.update(1, 15 * SECOND, status({ drop: 2 }));
        const back = tracker.update(1, 20 * SECOND, status({ drop: 4 }));
        assert.equal(back.input.spanMs, 5 * SECOND);
        assert.equal(back.input.drop, 2);
    });

    test('follows a leg by IP across a port change and keeps legs apart', () => {
        const tracker = createSrtRecentTracker();
        const poll = (t, aLoss, bLoss, port) =>
            tracker.update(
                1,
                t,
                status({
                    legs: [{ ...leg('a', { loss: aLoss }), port }, leg('b', { loss: bLoss })],
                }),
            );
        poll(0, 0, 0, 1111);
        const recent = poll(5 * SECOND, 7, 2, 2222);
        assert.equal(recent.legs.get('a').loss, 7);
        assert.equal(recent.legs.get('b').loss, 2);
    });

    test('tracks the output and each pipeline on its own', () => {
        const tracker = createSrtRecentTracker();
        const out = (t, drop) =>
            tracker.update(1, t, status({ output: { connected: true, packets: t, drop } }));
        out(0, 0);
        const recent = out(5 * SECOND, 4);
        assert.equal(recent.output.drop, 4);
        assert.equal(recent.output.packets, 5 * SECOND);
        assert.equal(tracker.update(2, 5 * SECOND, status()).output, null);
    });

    test('forgets deleted pipelines', () => {
        const tracker = createSrtRecentTracker();
        tracker.update(1, 0, status({ drop: 1 }));
        tracker.keepOnly(new Set());
        // The earlier poll is gone, so this one has nothing to compare with.
        assert.equal(tracker.update(1, 5 * SECOND, status({ drop: 9 })).input, null);
    });
});
