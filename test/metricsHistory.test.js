'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    mergeMetricSamples,
    METRICS_HISTORY_WINDOW_MS: WINDOW,
} = require('../public/ts/core/metrics-history');

const sample = (ts, cpu = 1) => ({ ts, cpu, ramUsed: 1, ramTotal: 2, rxBps: 0, txBps: 0 });
const stamps = (samples) => samples.map((s) => s.ts);

describe('mergeMetricSamples', () => {
    test('adds the fetched samples after those held', () => {
        const merged = mergeMetricSamples([sample(1000), sample(2000)], [sample(3000)]);
        assert.deepEqual(stamps(merged), [1000, 2000, 3000]);
    });

    test('puts samples in time order whatever order they arrive in', () => {
        const merged = mergeMetricSamples([sample(3000)], [sample(2000), sample(1000)]);
        assert.deepEqual(stamps(merged), [1000, 2000, 3000]);
    });

    test('a sample fetched again replaces the held one, not duplicates it', () => {
        const merged = mergeMetricSamples([sample(1000, 10)], [sample(1000, 20)]);
        assert.deepEqual(merged, [sample(1000, 20)]);
    });

    test('nothing fetched leaves what is held as it is', () => {
        const held = [sample(1000)];
        assert.equal(mergeMetricSamples(held, []), held);
    });

    test('drops samples older than two hours before the newest', () => {
        const newest = 10 * WINDOW;
        const held = [
            sample(newest - WINDOW - 5000),
            sample(newest - WINDOW),
            sample(newest - 5000),
        ];
        const merged = mergeMetricSamples(held, [sample(newest)]);
        // The window is inclusive at its edge.
        assert.deepEqual(stamps(merged), [newest - WINDOW, newest - 5000, newest]);
    });

    test('stays at the window however long the tab is open', () => {
        let held = [];
        for (let i = 0; i < 3 * 24 * 720; i++) {
            held = mergeMetricSamples(held, [sample(i * 5000)]);
        }
        // Two hours at one sample per 5 s, both edges included.
        assert.equal(held.length, 1441);
        assert.equal(held.at(-1).ts, (3 * 24 * 720 - 1) * 5000);
    });
});
