'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { outputMetricsBadge } = require('../public/ts/features/output-badges');

// A shared encode's badge: every figure, the bitrate only when not as expected.
const all = (o, i) => outputMetricsBadge(o, i, true);

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

describe('shared encode badge bitrate', () => {
    const input = (over) => ({ live: true, recvBitrateKbps: 8900, ...over });
    const withCpu = { cpuPercent: 0.4 };

    test('is hidden while a copy output is close to the input bitrate', () => {
        // FLV out of an SRT input reads 8 to 10% lower: 8.0 and 8.2 Mbps from 8.9.
        for (const bitrateKbps of [8000, 8200, 8900, 11000]) {
            const html = all(output({ bitrateKbps, ...withCpu }), input());
            assert.ok(!/Mbps/.test(html), `${bitrateKbps} hidden`);
            assert.match(html, />0\.4%</);
        }
    });

    test('shows when too low or too high', () => {
        for (const bitrateKbps of [5000, 12600]) {
            const html = all(output({ bitrateKbps, ...withCpu }), input());
            assert.match(html, /Mbps \/ 0\.4%/, `${bitrateKbps} shown`);
        }
    });

    test('below the minimum bitrate always shows, even on a low-bitrate input', () => {
        const html = all(output({ bitrateKbps: 150, ...withCpu }), input({ recvBitrateKbps: 160 }));
        assert.match(html, /150 kbps/);
    });

    test('shows without a baseline: no input given, not live, no rate, or an encoded video', () => {
        const base = output({ bitrateKbps: 8000, ...withCpu });
        assert.match(all(base), /Mbps/);
        assert.match(all(base, input({ live: false })), /Mbps/);
        assert.match(all(base, input({ recvBitrateKbps: null })), /Mbps/);
        assert.match(all(base, input({ recvBitrateKbps: 0 })), /Mbps/);
        assert.match(all({ ...base, videoEncoding: '720p' }, input()), /Mbps/);
    });

    test('a badge left with nothing to show is empty', () => {
        assert.equal(all(output({ bitrateKbps: 8000 }), input()), '');
    });
});

describe('shared encode badge tooltip', () => {
    test('names only the figures the badge shows', () => {
        const html = all(
            output({ cpuPercent: 0.4, memoryUsageBytes: 30e6, memoryLimitBytes: 1e9 }),
        );
        assert.match(html, /title="bitrate \/ CPU \(% of a core\) \/ memory"/);
        assert.match(
            all(output({ bitrateKbps: null, cpuPercent: 0.4 })),
            /title="CPU \(% of a core\)"/,
        );
    });
});

describe('shared encode badge speed', () => {
    test('realtime speed is not shown, not even in the tooltip', () => {
        for (const speed of [0.95, 1, 1.05]) {
            const html = all(output({ speed }));
            assert.ok(!/\dx</.test(html), `${speed} not in the text`);
            assert.ok(!/speed/.test(html), `${speed} not in the tooltip`);
            assert.ok(!/badge-warning/.test(html));
        }
    });

    test('no speed, no mention of it', () => {
        assert.ok(!/speed/.test(all(output({ speed: null }))));
        assert.ok(!/speed/.test(all(output({ speed: undefined }))));
    });

    test('below 0.95 shows in the text in the warning colour', () => {
        const html = all(output({ speed: 0.9 }));
        assert.match(html, /Mbps \/ 0\.90x</);
        assert.match(html, /title="bitrate \/ speed \(x realtime\)"/);
        assert.match(html, /badge-warning/);
    });

    test('above 1.05 shows in the text without a warning colour', () => {
        const html = all(output({ speed: 1.2 }));
        assert.match(html, /1\.20x</);
        assert.ok(!/badge-warning|badge-error/.test(html));
    });

    test('a memory warning keeps its colour over a slow speed', () => {
        const html = all(output({ speed: 0.5, memoryUsageBytes: 95, memoryLimitBytes: 100 }));
        assert.match(html, /badge-error/);
        assert.ok(!/badge-warning/.test(html));
    });
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
