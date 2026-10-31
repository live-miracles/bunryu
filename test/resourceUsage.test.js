'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createResourceUsage } = require('../src/services/resourceUsage');

const flush = () => new Promise((resolve) => setImmediate(resolve));

// One core's cumulative times; `busy` and `idle` are what it has spent so far.
const cores = (...perCore) =>
    perCore.map(([busy, idle]) => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 }));

const disk = (device, total, available) => ({
    device,
    totalBytes: total,
    availableBytes: available,
});

// Readers that answer from `world`, a plain object the test changes between ticks.
function setup(t, world = {}, options = {}) {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
    const w = {
        cpu: cores([0, 0]),
        totalMemory: 8000,
        freeMemory: 1000,
        hostMemory: { totalBytes: 8000, availableBytes: 5000, swapUsedBytes: 0 },
        disks: {},
        dataDir: '/data',
        net: { rx: 0, tx: 0 },
        rss: {},
        cpuByPid: {},
        srs: async () => ({ data: {} }),
        relayPid: null,
        ...world,
    };
    const resourceUsage = createResourceUsage({
        relayPid: () => w.relayPid,
        readers: {
            cpuTimes: () => w.cpu,
            totalMemory: () => w.totalMemory,
            freeMemory: () => w.freeMemory,
            hostMemory: () => w.hostMemory,
            diskUsage: (dir) => w.disks[dir] ?? null,
            dataDir: () => w.dataDir,
            netCounters: () => w.net,
            processRssBytes: (pid) => w.rss[pid] ?? null,
            createCpuTracker: () => ({
                sample: (_key, pid) => w.cpuByPid[pid] ?? null,
                delete() {},
            }),
            srsSummaries: () => w.srs(),
            pid: 42,
            uptimeSeconds: () => 77,
            ...options.readers,
        },
        ...options.resourceUsage,
    });
    t.after(() => resourceUsage.stop());
    // Advances in one-second steps: one big tick would run every due timer with the clock
    // already at the end, giving all the samples one timestamp.
    const tick = (ms) => {
        for (let left = ms; left > 0; left -= 1000) t.mock.timers.tick(Math.min(1000, left));
    };
    return { w, resourceUsage, tick };
}

describe('starting', () => {
    test('takes a sample at once, so the first request has figures', (t) => {
        const { resourceUsage } = setup(t);
        resourceUsage.start();
        const history = resourceUsage.history();
        assert.equal(history.length, 1);
        assert.equal(history[0].ts, 1_000_000);
        assert.equal(resourceUsage.system().cpu.cores, 1);
        assert.equal(resourceUsage.system().uptimeSeconds, 77);
    });

    test('a second start adds no second set of timers', (t) => {
        const { resourceUsage, tick } = setup(t);
        resourceUsage.start();
        resourceUsage.start();
        tick(5000);
        assert.equal(resourceUsage.history().length, 2);
    });

    test('stop ends the sampling', (t) => {
        const { resourceUsage, tick } = setup(t);
        resourceUsage.start();
        resourceUsage.stop();
        tick(60_000);
        assert.equal(resourceUsage.history().length, 1);
    });

    test('before start there is nothing sampled and the system still answers', (t) => {
        const { resourceUsage } = setup(t);
        assert.deepEqual(resourceUsage.history(), []);
        const system = resourceUsage.system();
        assert.equal(system.cpu.percent, 0);
        assert.equal(system.ram.usedBytes, 3000);
        assert.equal(system.disk, null);
    });
});

describe('CPU', () => {
    test('is the busy share of the cores since the last sample', (t) => {
        const { w, resourceUsage, tick } = setup(t, { cpu: cores([0, 0], [0, 0]) });
        resourceUsage.start();
        // Nothing has passed since the baseline taken at creation.
        assert.equal(resourceUsage.system().cpu.percent, 0);
        w.cpu = cores([50, 50], [0, 100]);
        tick(5000);
        assert.equal(resourceUsage.system().cpu.percent, 25);
        assert.equal(resourceUsage.system().cpu.cores, 2);
        w.cpu = cores([150, 50], [100, 100]);
        tick(5000);
        assert.equal(resourceUsage.system().cpu.percent, 100);
    });
});

describe('RAM', () => {
    test('is total less what the kernel can still hand out, so reclaimable cache is free', (t) => {
        const { resourceUsage } = setup(t);
        resourceUsage.start();
        assert.deepEqual(resourceUsage.system().ram, { usedBytes: 3000, totalBytes: 8000 });
    });

    test('falls back to the free memory the OS reports when meminfo is unreadable', (t) => {
        const { resourceUsage } = setup(t, { hostMemory: null });
        resourceUsage.start();
        assert.deepEqual(resourceUsage.system().ram, { usedBytes: 7000, totalBytes: 8000 });
    });
});

describe('network rates', () => {
    test('are the counter change over the time between readings', (t) => {
        const { w, resourceUsage, tick } = setup(t, { net: { rx: 1000, tx: 5000 } });
        resourceUsage.start();
        // The first reading has nothing to compare with.
        assert.deepEqual(resourceUsage.system().net, { rxBytesPerSec: 0, txBytesPerSec: 0 });
        w.net = { rx: 7000, tx: 8000 };
        tick(3000);
        tick(2000); // the 5 s sample picks up the rate measured at 3 s
        assert.deepEqual(resourceUsage.system().net, { rxBytesPerSec: 2000, txBytesPerSec: 1000 });
    });

    test('a counter that went backwards (a reset) reads as zero, not negative', (t) => {
        const { w, resourceUsage, tick } = setup(t, { net: { rx: 9000, tx: 9000 } });
        resourceUsage.start();
        w.net = { rx: 100, tx: 100 };
        tick(3000);
        tick(2000);
        assert.deepEqual(resourceUsage.system().net, { rxBytesPerSec: 0, txBytesPerSec: 0 });
    });

    test('keeps the last rates when the counters cannot be read', (t) => {
        const { w, resourceUsage, tick } = setup(t, { net: { rx: 0, tx: 0 } });
        resourceUsage.start();
        w.net = { rx: 3000, tx: 0 };
        tick(3000);
        tick(2000);
        assert.equal(resourceUsage.system().net.rxBytesPerSec, 1000);
        w.net = null;
        tick(5000);
        assert.equal(resourceUsage.system().net.rxBytesPerSec, 1000);
    });
});

describe('disk', () => {
    test('is the used share of the fuller of the data directory and the root filesystem', (t) => {
        const { resourceUsage } = setup(t, {
            disks: { '/': disk(1, 100_000, 58_000), '/data': disk(2, 50_000, 5_000) },
        });
        resourceUsage.start();
        assert.deepEqual(resourceUsage.system().disk, { totalBytes: 50_000, usedBytes: 45_000 });
    });

    test('is the root when that is the fuller one', (t) => {
        const { resourceUsage } = setup(t, {
            disks: { '/': disk(1, 100_000, 5_000), '/data': disk(2, 50_000, 40_000) },
        });
        resourceUsage.start();
        assert.deepEqual(resourceUsage.system().disk, { totalBytes: 100_000, usedBytes: 95_000 });
    });

    test('an unreadable data directory falls back to the root filesystem', (t) => {
        const { resourceUsage } = setup(t, { disks: { '/': disk(1, 100_000, 58_000) } });
        resourceUsage.start();
        assert.deepEqual(resourceUsage.system().disk, { totalBytes: 100_000, usedBytes: 42_000 });
    });

    test('no readable config means the root filesystem alone', (t) => {
        const { resourceUsage } = setup(t, {
            dataDir: null,
            disks: { '/': disk(1, 100_000, 58_000), '/data': disk(2, 10, 1) },
        });
        resourceUsage.start();
        assert.deepEqual(resourceUsage.system().disk, { totalBytes: 100_000, usedBytes: 42_000 });
    });

    test('no readable filesystem leaves it null instead of failing', (t) => {
        const { resourceUsage } = setup(t);
        resourceUsage.start();
        assert.equal(resourceUsage.system().disk, null);
    });

    test('is read again every 30 seconds', (t) => {
        const { w, resourceUsage, tick } = setup(t, { disks: { '/': disk(1, 1000, 500) } });
        resourceUsage.start();
        w.disks = { '/': disk(1, 1000, 100) };
        tick(29_000);
        assert.equal(resourceUsage.system().disk.usedBytes, 500);
        tick(1000);
        assert.equal(resourceUsage.system().disk.usedBytes, 900);
    });
});

describe('history', () => {
    test('gets a sample every five seconds', (t) => {
        const { resourceUsage, tick } = setup(t);
        resourceUsage.start();
        tick(15_000);
        assert.deepEqual(
            resourceUsage.history().map((s) => s.ts),
            [1_000_000, 1_005_000, 1_010_000, 1_015_000],
        );
    });

    test('a sample carries CPU, RAM and the network rates', (t) => {
        const { resourceUsage } = setup(t);
        resourceUsage.start();
        assert.deepEqual(resourceUsage.history()[0], {
            ts: 1_000_000,
            cpu: 0,
            ramUsed: 3000,
            ramTotal: 8000,
            rxBps: 0,
            txBps: 0,
        });
    });

    test('`after` gives only the samples newer than it', (t) => {
        const { resourceUsage, tick } = setup(t);
        resourceUsage.start();
        tick(10_000);
        assert.deepEqual(
            resourceUsage.history(1_005_000).map((s) => s.ts),
            [1_010_000],
        );
        assert.deepEqual(resourceUsage.history(1_010_000), []);
        assert.equal(resourceUsage.history(1_000_000 - 1).length, 3);
    });

    test('keeps the last two hours and no more', (t) => {
        const { resourceUsage, tick } = setup(t);
        resourceUsage.start();
        tick(5000 * 1500);
        const history = resourceUsage.history();
        assert.equal(history.length, 1440);
        assert.equal(history.at(-1).ts, 1_000_000 + 5000 * 1500);
        assert.equal(history[0].ts, history.at(-1).ts - 5000 * 1439);
    });

    test('hands out a copy, so a caller cannot change what is kept', (t) => {
        const { resourceUsage } = setup(t);
        resourceUsage.start();
        resourceUsage.history().length = 0;
        assert.equal(resourceUsage.history().length, 1);
    });
});

describe('process usage', () => {
    test('node is this process: its CPU from the tracker and its RSS', (t) => {
        const { w, resourceUsage } = setup(t);
        w.cpuByPid = { 42: 12.5 };
        w.rss = { 42: 123456 };
        resourceUsage.start();
        assert.deepEqual(resourceUsage.system().node, { cpuPercent: 12.5, ramBytes: 123456 });
        assert.deepEqual(resourceUsage.processUsage().node, { cpuPercent: 12.5, ramBytes: 123456 });
    });

    test('the relay is unknown while it has no process', (t) => {
        const { resourceUsage } = setup(t, { relayPid: null });
        resourceUsage.start();
        assert.deepEqual(resourceUsage.system().relay, { cpuPercent: null, ramBytes: null });
    });

    test('the relay is measured by its pid, and again every ten seconds', (t) => {
        const { w, resourceUsage, tick } = setup(t, {
            relayPid: 5555,
            rss: { 5555: 9000 },
            cpuByPid: { 5555: 3 },
        });
        resourceUsage.start();
        assert.deepEqual(resourceUsage.system().relay, { cpuPercent: 3, ramBytes: 9000 });
        w.cpuByPid = { 5555: 8 };
        tick(10_000);
        assert.equal(resourceUsage.system().relay.cpuPercent, 8);
        w.relayPid = null;
        tick(10_000);
        assert.deepEqual(resourceUsage.system().relay, { cpuPercent: null, ramBytes: null });
    });

    test('SRS gives CPU as a 0 to 1 fraction and memory in kilobytes', async (t) => {
        const { resourceUsage } = setup(t, {
            srs: async () => ({ data: { self: { cpu_percent: 0.055, mem_kbyte: 20000 } } }),
        });
        resourceUsage.start();
        await flush();
        const { srs } = resourceUsage.system();
        assert.ok(Math.abs(srs.cpuPercent - 5.5) < 0.001);
        assert.equal(srs.ramBytes, 20000 * 1024);
    });

    test('SRS figures it did not report are unknown, not zero', async (t) => {
        const { resourceUsage } = setup(t, { srs: async () => ({ data: { self: {} } }) });
        resourceUsage.start();
        await flush();
        assert.deepEqual(resourceUsage.system().srs, { cpuPercent: null, ramBytes: null });
    });

    test('SRS not answering makes its figures unknown, not the last ones', async (t) => {
        const { w, resourceUsage, tick } = setup(t, {
            srs: async () => ({ data: { self: { cpu_percent: 0.1, mem_kbyte: 1 } } }),
        });
        resourceUsage.start();
        await flush();
        assert.equal(resourceUsage.system().srs.ramBytes, 1024);
        w.srs = async () => {
            throw new Error('ECONNREFUSED');
        };
        tick(10_000);
        await flush();
        assert.deepEqual(resourceUsage.system().srs, { cpuPercent: null, ramBytes: null });
    });
});
