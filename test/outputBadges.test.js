'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { outputMetricsBadge } = require('../public/ts/features/output-badges');

const output = (over) => ({
    status: 'running',
    bitrateKbps: 3000,
    cpuPercent: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    speed: null,
    ...over,
});

describe('output metrics badge speed', () => {
    test('realtime speed is only in the tooltip', () => {
        for (const speed of [0.95, 1, 1.05]) {
            const html = outputMetricsBadge(output({ speed }));
            assert.ok(!/\dx</.test(html), `${speed} not in the text`);
            assert.match(html, new RegExp(`speed ${speed.toFixed(2)}x realtime`));
            assert.ok(!/badge-warning/.test(html));
        }
    });

    test('no speed, no mention of it', () => {
        assert.ok(!/speed/.test(outputMetricsBadge(output({ speed: null }))));
        assert.ok(!/speed/.test(outputMetricsBadge(output({ speed: undefined }))));
    });

    test('below 0.95 shows in the text in the warning colour', () => {
        const html = outputMetricsBadge(output({ speed: 0.9 }));
        assert.match(html, /Mbps \| 0\.90x</);
        assert.match(html, /badge-warning/);
    });

    test('above 1.05 shows in the text without a warning colour', () => {
        const html = outputMetricsBadge(output({ speed: 1.2 }));
        assert.match(html, /1\.20x</);
        assert.ok(!/badge-warning|badge-error/.test(html));
    });

    test('a memory warning keeps its colour over a slow speed', () => {
        const html = outputMetricsBadge(
            output({ speed: 0.5, memoryUsageBytes: 95, memoryLimitBytes: 100 }),
        );
        assert.match(html, /badge-error/);
        assert.ok(!/badge-warning/.test(html));
    });
});
