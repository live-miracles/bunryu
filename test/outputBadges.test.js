'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { outputMetricsBadge } = require('../public/ts/features/output-badges');

const output = (over) => ({
    status: 'running',
    videoEncoding: 'copy',
    bitrateKbps: 3000,
    cpuPercent: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    speed: null,
    ...over,
});

describe('output metrics badge bitrate', () => {
    const input = (over) => ({ live: true, recvBitrateKbps: 8900, ...over });
    const withCpu = { cpuPercent: 0.4 };

    test('is hidden while a copy output is close to the input bitrate', () => {
        // FLV out of an SRT input reads 8 to 10% lower: 8.0 and 8.2 Mbps from 8.9.
        for (const bitrateKbps of [8000, 8200, 8900, 11000]) {
            const html = outputMetricsBadge(output({ bitrateKbps, ...withCpu }), input());
            assert.ok(!/Mbps/.test(html), `${bitrateKbps} hidden`);
            assert.match(html, />0\.4%</);
        }
    });

    test('shows when too low or too high', () => {
        for (const bitrateKbps of [5000, 12600]) {
            const html = outputMetricsBadge(output({ bitrateKbps, ...withCpu }), input());
            assert.match(html, /Mbps \/ 0\.4%/, `${bitrateKbps} shown`);
        }
    });

    test('below the minimum bitrate always shows, even on a low-bitrate input', () => {
        const html = outputMetricsBadge(
            output({ bitrateKbps: 150, ...withCpu }),
            input({ recvBitrateKbps: 160 }),
        );
        assert.match(html, /150 kbps/);
    });

    test('shows without a baseline: no input given, not live, no rate, or an encoded video', () => {
        const base = output({ bitrateKbps: 8000, ...withCpu });
        assert.match(outputMetricsBadge(base), /Mbps/);
        assert.match(outputMetricsBadge(base, input({ live: false })), /Mbps/);
        assert.match(outputMetricsBadge(base, input({ recvBitrateKbps: null })), /Mbps/);
        assert.match(outputMetricsBadge(base, input({ recvBitrateKbps: 0 })), /Mbps/);
        assert.match(outputMetricsBadge({ ...base, videoEncoding: '720p' }, input()), /Mbps/);
    });

    test('a badge left with nothing to show is empty', () => {
        assert.equal(outputMetricsBadge(output({ bitrateKbps: 8000 }), input()), '');
    });
});

describe('output metrics badge tooltip', () => {
    test('names only the figures the badge shows', () => {
        const html = outputMetricsBadge(
            output({ cpuPercent: 0.4, memoryUsageBytes: 30e6, memoryLimitBytes: 1e9 }),
        );
        assert.match(html, /title="bitrate \/ CPU \(% of a core\) \/ memory"/);
        assert.match(
            outputMetricsBadge(output({ bitrateKbps: null, cpuPercent: 0.4 })),
            /title="CPU \(% of a core\)"/,
        );
    });
});

describe('output metrics badge speed', () => {
    test('realtime speed is not shown, not even in the tooltip', () => {
        for (const speed of [0.95, 1, 1.05]) {
            const html = outputMetricsBadge(output({ speed }));
            assert.ok(!/\dx</.test(html), `${speed} not in the text`);
            assert.ok(!/speed/.test(html), `${speed} not in the tooltip`);
            assert.ok(!/badge-warning/.test(html));
        }
    });

    test('no speed, no mention of it', () => {
        assert.ok(!/speed/.test(outputMetricsBadge(output({ speed: null }))));
        assert.ok(!/speed/.test(outputMetricsBadge(output({ speed: undefined }))));
    });

    test('below 0.95 shows in the text in the warning colour', () => {
        const html = outputMetricsBadge(output({ speed: 0.9 }));
        assert.match(html, /Mbps \/ 0\.90x</);
        assert.match(html, /title="bitrate \/ speed \(x realtime\)"/);
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
