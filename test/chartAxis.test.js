'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { formatBitrateAxis } = require('../public/ts/core/utils');

// The ticks drawChart labels: four equal steps from 0 to the chart's peak.
const ticks = (peak) => [0, 1, 2, 3, 4].map((i) => formatBitrateAxis((peak / 4) * i, peak));

describe('formatBitrateAxis', () => {
    test('labels a sub-Mbps chart in kbps', () => {
        assert.deepEqual(ticks(200), ['0', '50k', '100k', '150k', '200k']);
        assert.deepEqual(ticks(10), ['0', '2.5k', '5k', '7.5k', '10k']);
    });

    test('labels a chart from 1 Mbps up in Mbps', () => {
        assert.deepEqual(ticks(1000), ['0', '0.25M', '0.5M', '0.75M', '1M']);
        assert.deepEqual(ticks(5000), ['0', '1.25M', '2.5M', '3.75M', '5M']);
        assert.deepEqual(ticks(20000), ['0', '5M', '10M', '15M', '20M']);
    });

    test('never repeats a label across the nice peaks the chart can pick', () => {
        for (let exp = 1; exp <= 6; exp++) {
            for (const f of [1, 2, 5]) {
                const peak = f * 10 ** exp;
                assert.equal(new Set(ticks(peak)).size, 5, `peak ${peak} kbps: ${ticks(peak)}`);
            }
        }
    });
});
