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

describe('output badge: only what is abnormal', () => {
    const input = { live: true, recvBitrateKbps: 8900 };
    const MB = 1e6;

    test('a healthy copy output has no badge', () => {
        const healthy = output({
            bitrateKbps: 8200,
            cpuPercent: 2,
            memoryUsageBytes: 35 * MB,
            memoryLimitBytes: 1000 * MB,
            speed: 1,
        });
        assert.equal(outputMetricsBadge(healthy, input), '');
        // Without a baseline there is nothing to judge the bitrate by: still no badge.
        assert.equal(outputMetricsBadge(healthy), '');
    });

    test('shows the bitrate alone when it is off the input', () => {
        const html = outputMetricsBadge(output({ bitrateKbps: 4000, cpuPercent: 2 }), input);
        assert.match(html, />4\.0 Mbps</);
        assert.match(html, /title="bitrate"/);
    });

    test('shows a bitrate below the minimum even without a baseline', () => {
        assert.match(outputMetricsBadge(output({ bitrateKbps: 150 })), /150 kbps/);
    });

    test('shows the CPU alone from 50% of a core on a copy output', () => {
        const html = outputMetricsBadge(output({ bitrateKbps: 8200, cpuPercent: 60 }), input);
        assert.match(html, /title="CPU \(% of a core\)"/);
        assert.ok(!/Mbps/.test(html));
        assert.equal(outputMetricsBadge(output({ bitrateKbps: 8200, cpuPercent: 49 }), input), '');
    });

    test('an output with a video encode is not flagged for its CPU', () => {
        const encoded = output({ videoEncoding: '720p', bitrateKbps: 3000, cpuPercent: 180 });
        assert.equal(outputMetricsBadge(encoded, input), '');
    });

    test('shows the memory alone from the warning level, coloured', () => {
        const base = { bitrateKbps: 8200, memoryLimitBytes: 100 };
        assert.equal(outputMetricsBadge(output({ ...base, memoryUsageBytes: 69 }), input), '');
        const warn = outputMetricsBadge(output({ ...base, memoryUsageBytes: 75 }), input);
        assert.match(warn, /title="memory"/);
        assert.match(warn, /badge-warning/);
        assert.match(
            outputMetricsBadge(output({ ...base, memoryUsageBytes: 95 }), input),
            /badge-error/,
        );
    });

    test('memory without a known limit is not shown', () => {
        assert.equal(
            outputMetricsBadge(output({ bitrateKbps: 8200, memoryUsageBytes: 900 * MB }), input),
            '',
        );
    });

    test('shows the speed alone when off realtime', () => {
        const html = outputMetricsBadge(output({ bitrateKbps: 8200, speed: 0.9 }), input);
        assert.match(html, /title="speed \(x realtime\)"/);
        assert.match(html, /badge-warning/);
    });

    test('each abnormal figure is its own badge with its own tooltip and colour', () => {
        const html = outputMetricsBadge(
            output({
                bitrateKbps: 4000,
                cpuPercent: 70,
                memoryUsageBytes: 95,
                memoryLimitBytes: 100,
                speed: 0.8,
            }),
            input,
        );
        const badges = [...html.matchAll(/<span class="([^"]*)" title="([^"]*)">([^<]*)<\/span>/g)];
        assert.deepEqual(
            badges.map((b) => b[2]),
            ['bitrate', 'CPU (% of a core)', 'memory', 'speed (x realtime)'],
        );
        assert.match(badges[2][1], /badge-error/);
        assert.match(badges[3][1], /badge-warning/);
        assert.ok(!/badge-(error|warning)/.test(badges[0][1] + badges[1][1]));
    });
});
