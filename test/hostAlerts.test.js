'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createHostAlertTracker } = require('../src/utils/hostAlerts');

function cpuTracker() {
    return createHostAlertTracker({
        worse: 'higher',
        breached: (v) => v >= 90,
        cleared: (v) => v < 80,
        startPolls: 3,
        endPolls: 2,
    });
}

const feed = (tracker, values) => values.map((v) => tracker.update(v));

describe('createHostAlertTracker', () => {
    test('starts only after the breach holds for startPolls in a row', () => {
        const tracker = cpuTracker();
        const results = feed(tracker, [95, 96, 50, 95, 96, 97]);
        assert.deepEqual(
            results.map((r) => r?.change ?? null),
            [null, null, null, null, null, 'started'],
            'the dip to 50 restarts the count',
        );
        assert.equal(tracker.active, true);
        assert.equal(results[5].worst, 97);
    });

    test('a reading flapping around the start line never opens an alert', () => {
        const tracker = cpuTracker();
        const results = feed(tracker, [89, 91, 89, 91, 89, 91, 89, 91]);
        assert.deepEqual(results.filter(Boolean), []);
        assert.equal(tracker.active, false);
    });

    test('stays open inside the hysteresis band and ends after endPolls below the exit line', () => {
        const tracker = cpuTracker();
        feed(tracker, [95, 95, 95]);
        assert.equal(tracker.active, true);
        // 85 is under the start line but not under the exit line: still open, and it
        // resets the count of low readings.
        assert.deepEqual(feed(tracker, [85, 70, 85, 70, 85]).filter(Boolean), []);
        assert.equal(tracker.active, true);
        assert.equal(tracker.update(70), null, 'one low reading is not enough');
        assert.equal(tracker.update(70)?.change, 'ended');
        assert.equal(tracker.active, false);
    });

    test('the end reports the worst reading and how many polls the alert was open', () => {
        const tracker = cpuTracker();
        feed(tracker, [92, 95, 91]);
        const results = feed(tracker, [99, 60, 60]);
        assert.deepEqual(results.at(-1), { change: 'ended', worst: 99, polls: 3 });
    });

    test('a low-is-bad signal tracks the smallest reading as the worst', () => {
        const tracker = createHostAlertTracker({
            worse: 'lower',
            breached: (v) => v < 0.15,
            cleared: (v) => v >= 0.2,
            startPolls: 1,
            endPolls: 1,
        });
        assert.equal(tracker.update(0.1).change, 'started');
        tracker.update(0.05);
        tracker.update(0.12);
        assert.equal(tracker.update(0.18), null, 'inside the band');
        assert.deepEqual(tracker.update(0.3), { change: 'ended', worst: 0.05, polls: 4 });
    });

    test('can start again after it ended', () => {
        const tracker = createHostAlertTracker({
            worse: 'higher',
            breached: (v) => v >= 90,
            cleared: (v) => v < 80,
            startPolls: 1,
            endPolls: 1,
        });
        assert.equal(tracker.update(95).change, 'started');
        assert.equal(tracker.update(10).change, 'ended');
        assert.equal(tracker.update(96).change, 'started');
    });
});
