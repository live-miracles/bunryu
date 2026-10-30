'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHostMonitor } = require('../src/services/hostMonitor');

const MB = 1024 * 1024;

// A monitor over fixed readings: a test sets `state` and calls `check`.
function setup(t) {
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const state = {
        memory: { availableBytes: 400 * MB, totalBytes: 1000 * MB, swapUsedBytes: 0 },
        cpu: { some10: 1, some60: 1 },
        disks: { '/data': { device: 1, availableBytes: 500 * MB, totalBytes: 1000 * MB } },
    };
    const rows = [];
    const events = [];
    const monitor = createHostMonitor({
        pollIntervalMs: 5000,
        record: (type, message) => rows.push({ type, message }),
        topCpuConsumers: () => [{ name: 'node', cpuPercent: 80 }],
        diagnostics: { event: (event, fields) => events.push({ event, ...fields }) },
        readers: {
            memory: () => state.memory,
            cpuPressure: () => state.cpu,
            diskUsage: (dir) => state.disks[dir] ?? null,
            topProcessesByRss: () => [{ pid: 77, name: 'ffmpeg', rssBytes: 99 * MB }],
            dataDir: () => '/data',
        },
    });
    return { monitor, state, rows, events };
}

describe('host monitor', () => {
    test('healthy readings raise nothing', (t) => {
        const { monitor, rows, events } = setup(t);
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        assert.deepEqual(rows, []);
        assert.deepEqual(events, []);
    });

    test('low memory starts an alert naming the top processes, and ends past the recover line', (t) => {
        const { monitor, state, rows, events } = setup(t);
        state.memory = { ...state.memory, availableBytes: 100 * MB };
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), ['memory']);
        assert.equal(rows[0].type, 'problem');
        assert.match(rows[0].message, /^Memory low: .*ffmpeg\(77\)=/);
        assert.equal(events[0].event, 'host-memory-low');
        assert.equal(events[0].thresholdPercent, 15);

        // 17% is above the 15% start line but below the 20% recover line: still open.
        state.memory = { ...state.memory, availableBytes: 170 * MB };
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), ['memory']);
        assert.equal(rows.length, 1);

        state.memory = { ...state.memory, availableBytes: 300 * MB };
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        assert.equal(rows[1].type, 'recovered');
        assert.equal(events[1].event, 'host-memory-recovered');
        assert.equal(events[1].thresholdPercent, 20);
    });

    test('a missing memory or pressure reading raises nothing', (t) => {
        const { monitor, state, rows } = setup(t);
        state.memory = null;
        state.cpu = null;
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        assert.deepEqual(rows, []);
    });

    test('CPU pressure needs 6 polls to start and 12 below the recover line to end', (t) => {
        const { monitor, state, rows, events } = setup(t);
        state.cpu = { some10: 60, some60: 40 };
        for (let i = 0; i < 5; i++) monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), ['cpu']);
        assert.match(
            rows[0].message,
            /^CPU saturated: pressure 60% \(10 s\) for 30s; top: node=80%/,
        );
        assert.deepEqual(events[0].topConsumers, [{ name: 'node', cpuPercent: 80 }]);

        state.cpu = { some10: 10, some60: 10 };
        for (let i = 0; i < 11; i++) monitor.check();
        assert.deepEqual(monitor.openAlerts(), ['cpu']);
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        assert.equal(rows[1].type, 'recovered');
        assert.equal(events[1].peakPressure10, 60);
    });

    test('a data directory on the root filesystem is checked once', (t) => {
        const { monitor, state, rows } = setup(t);
        const full = { device: 1, availableBytes: 50 * MB, totalBytes: 1000 * MB };
        state.disks = { '/data': full, '/': full };
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), ['disk']);
        assert.equal(rows.length, 1);
        assert.match(rows[0].message, /^Disk space low on \/data:/);
    });

    test('each filesystem has its own alert', (t) => {
        const { monitor, state, rows } = setup(t);
        state.disks = {
            '/data': { device: 1, availableBytes: 500 * MB, totalBytes: 1000 * MB },
            '/': { device: 2, availableBytes: 50 * MB, totalBytes: 1000 * MB },
        };
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), ['disk']);
        assert.match(rows[0].message, /^Disk space low on \/:/);

        state.disks['/'] = { device: 2, availableBytes: 200 * MB, totalBytes: 1000 * MB };
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        assert.match(rows[1].message, /^Disk space recovered on \/:/);
    });
});
