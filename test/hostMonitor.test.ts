import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHostMonitor, type HostReaders } from '../src/services/hostMonitor';
import type { DiskUsage } from '../src/utils/procStats';

const MB = 1024 * 1024;

const MEMORY = { availableBytes: 400 * MB, totalBytes: 1000 * MB, swapUsedBytes: 0 };

// A monitor over fixed readings: a test sets `state` and calls `check`.
function setup(t: TestContext) {
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const state: {
        memory: ReturnType<HostReaders['memory']>;
        cpu: ReturnType<HostReaders['cpuPressure']>;
        busy: number | null;
        disks: Record<string, DiskUsage>;
        now: number;
    } = {
        memory: { ...MEMORY },
        cpu: { some10: 1, some60: 1 },
        busy: 10,
        disks: { '/data': { device: 1, availableBytes: 500 * MB, totalBytes: 1000 * MB } },
        now: 1_000,
    };
    const rows: { type: string; message: string }[] = [];
    const events: Record<string, unknown>[] = [];
    const monitor = createHostMonitor({
        pollIntervalMs: 5000,
        record: (type, message) => rows.push({ type, message }),
        topCpuConsumers: () => [{ name: 'node', cpuPercent: 80 }],
        diagnostics: {
            event: (event, fields) => void events.push({ event, ...fields }),
            close: () => Promise.resolve(),
        },
        now: () => state.now,
        readers: {
            memory: () => state.memory,
            cpuPressure: () => state.cpu,
            cpuPercent: () => state.busy,
            diskUsage: (dir) => state.disks[dir] ?? null,
            topProcessesByRss: () => [{ pid: 77, name: 'ffmpeg', rssBytes: 99 * MB }],
            dataDir: () => '/data',
        },
    });
    return { monitor, state, rows, events };
}

const kinds = (monitor: ReturnType<typeof setup>['monitor']) =>
    monitor.openAlerts().map((a) => `${a.kind}:${a.severity}`);
const usedMemory = (percent: number) => ({
    ...MEMORY,
    availableBytes: Math.round((1000 - percent * 10) * MB),
});

describe('host monitor', () => {
    test('healthy readings raise nothing', (t) => {
        const { monitor, rows, events } = setup(t);
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        assert.deepEqual(rows, []);
        assert.deepEqual(events, []);
    });

    test('memory is a warning from 70% used and an error from 90%, ended under 65% / 85%', (t) => {
        const { monitor, state, rows, events } = setup(t);
        state.memory = usedMemory(72);
        monitor.check();
        assert.deepEqual(kinds(monitor), ['memory:warning']);
        assert.equal(rows[0].type, 'problem');
        assert.match(rows[0].message, /^Memory high: 72% used .*ffmpeg\(77\)=/);
        assert.equal(events[0].event, 'host-memory-high');
        assert.equal(events[0].thresholdPercent, 70);

        state.memory = usedMemory(92);
        monitor.check();
        assert.deepEqual(kinds(monitor), ['memory:error']);
        assert.match(rows[1].message, /^Memory critical: 92% used/);
        assert.equal(events[1].event, 'host-memory-critical');

        // 87% is under the 90% start line but over the 85% end line: still an error.
        state.memory = usedMemory(87);
        monitor.check();
        assert.deepEqual(kinds(monitor), ['memory:error']);
        assert.equal(rows.length, 2);

        // 80%: the error ends, the warning stays (it ends only under 65%).
        state.memory = usedMemory(80);
        monitor.check();
        assert.deepEqual(kinds(monitor), ['memory:warning']);
        assert.match(rows[2].message, /^Memory no longer critical: 80% used/);

        state.memory = usedMemory(67);
        monitor.check();
        assert.deepEqual(kinds(monitor), ['memory:warning'], 'inside the band');
        assert.equal(rows.length, 3);

        state.memory = usedMemory(60);
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        assert.equal(rows[3].type, 'recovered');
        assert.equal(events[3].event, 'host-memory-recovered');
        assert.equal(events[3].thresholdPercent, 65);
    });

    test('a jump straight to an error is one event, and a fall straight to normal one recovery', (t) => {
        const { monitor, state, rows } = setup(t);
        state.memory = usedMemory(95);
        monitor.check();
        assert.equal(rows.length, 1);
        assert.match(rows[0].message, /^Memory critical/);
        state.memory = usedMemory(40);
        monitor.check();
        assert.equal(rows.length, 2);
        assert.match(rows[1].message, /^Memory recovered/);
    });

    test('an open alert says when it reached its severity and its latest reading', (t) => {
        const { monitor, state } = setup(t);
        state.memory = usedMemory(72);
        monitor.check();
        state.now = 2_000;
        const [warning] = monitor.openAlerts();
        assert.equal(warning.sinceMs, 2_000);
        assert.match(warning.message, /^Memory is at 72% \(warning from 70%\)\.$/);

        state.now = 9_000;
        assert.equal(monitor.openAlerts()[0].sinceMs, 2_000, 'unchanged while it lasts');

        state.memory = usedMemory(93);
        monitor.check();
        state.now = 10_000;
        const [error] = monitor.openAlerts();
        assert.equal(error.sinceMs, 10_000, 'a new severity starts again');
        assert.match(error.message, /critical from 90%/);
    });

    test('a missing memory, busy or pressure reading raises nothing', (t) => {
        const { monitor, state, rows } = setup(t);
        state.memory = null;
        state.cpu = null;
        state.busy = null;
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        assert.deepEqual(rows, []);
    });

    test('CPU busy needs 6 polls at 70% to start and 12 under 65% to end', (t) => {
        const { monitor, state, rows, events } = setup(t);
        state.busy = 75;
        for (let i = 0; i < 5; i++) monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        monitor.check();
        assert.deepEqual(kinds(monitor), ['cpu:warning']);
        assert.match(rows[0].message, /^CPU high: 75% busy for 30s; top: node=80%/);
        assert.equal(events[0].event, 'host-cpu-high');
        assert.deepEqual(events[0].topConsumers, [{ name: 'node', cpuPercent: 80 }]);

        state.busy = 60;
        for (let i = 0; i < 11; i++) monitor.check();
        assert.deepEqual(kinds(monitor), ['cpu:warning']);
        monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        assert.equal(rows[1].type, 'recovered');
        assert.equal(events[1].peakBusyPercent, 75);
    });

    test('CPU busy from 90% is an error', (t) => {
        const { monitor, state, events } = setup(t);
        state.busy = 95;
        for (let i = 0; i < 6; i++) monitor.check();
        assert.deepEqual(kinds(monitor), ['cpu:error']);
        assert.equal(events[0].event, 'host-cpu-critical');
    });

    test('CPU pressure needs 6 polls to start and 12 below the recover line to end, as an error', (t) => {
        const { monitor, state, rows, events } = setup(t);
        state.cpu = { some10: 60, some60: 40 };
        for (let i = 0; i < 5; i++) monitor.check();
        assert.deepEqual(monitor.openAlerts(), []);
        monitor.check();
        assert.deepEqual(kinds(monitor), ['cpu:error']);
        assert.match(
            rows[0].message,
            /^CPU saturated: pressure 60% \(10 s\) for 30s; top: node=80%/,
        );
        assert.match(monitor.openAlerts()[0].message, /saturated: tasks waited 60%/);
        assert.equal(events[0].event, 'host-cpu-saturated');
        assert.deepEqual(events[0].topConsumers, [{ name: 'node', cpuPercent: 80 }]);

        state.cpu = { some10: 10, some60: 10 };
        for (let i = 0; i < 11; i++) monitor.check();
        assert.deepEqual(kinds(monitor), ['cpu:error']);
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
        assert.deepEqual(kinds(monitor), ['disk:error']);
        assert.equal(rows.length, 1);
        assert.match(rows[0].message, /^Disk space critical on \/data: 95% used/);
    });

    test('each filesystem has its own alert, and the fuller one speaks for the disk', (t) => {
        const { monitor, state, rows } = setup(t);
        state.disks = {
            '/data': { device: 1, availableBytes: 250 * MB, totalBytes: 1000 * MB },
            '/': { device: 2, availableBytes: 50 * MB, totalBytes: 1000 * MB },
        };
        monitor.check();
        assert.equal(rows.length, 2, 'one alert per filesystem');
        assert.deepEqual(kinds(monitor), ['disk:error']);
        assert.match(monitor.openAlerts()[0].message, /^Disk \/ is 95% full/);

        state.disks['/'] = { device: 2, availableBytes: 500 * MB, totalBytes: 1000 * MB };
        monitor.check();
        assert.deepEqual(kinds(monitor), ['disk:warning'], 'only /data is left');
        assert.match(monitor.openAlerts()[0].message, /^Disk \/data is 75% full/);
        assert.ok(rows.some((r) => /^Disk space recovered on \/:/.test(r.message)));
    });
});
