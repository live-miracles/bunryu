import os from 'os';
import path from 'path';
import { readAppConfig } from '../utils/appConfig.js';
import { fetchSrsSummaries } from '../utils/srs.js';
import {
    createProcCpuTracker,
    readDiskUsage,
    readHostMemory,
    readNetCounters,
    readProcRssBytes,
    watchedFilesystems,
    type DiskUsage,
    type HostMemory,
    type NetCounters,
    type ProcCpuTracker,
} from '../utils/procStats.js';

// What the host and the three managed processes (this server, SRS, the relay) are using,
// sampled on timers and kept for the dashboard's charts and tables and the diagnostics
// snapshot, so every reader sees the same numbers and nothing samples twice. Where each
// reading comes from is `ResourceUsageReaders`; the default reads /proc, the filesystem and
// SRS's API, and a test passes its own.

const DISK_STATS_INTERVAL_MS = 30_000;
const NET_STATS_INTERVAL_MS = 3_000;
const SAMPLE_INTERVAL_MS = 5_000;
const PROC_STATS_INTERVAL_MS = 10_000;
const HISTORY_MAX = 1440; // 2 hours at 5 s — client trims to desired window

export interface ProcessUsage {
    cpuPercent: number | null;
    ramBytes: number | null;
}

export interface ProcessUsages {
    node: ProcessUsage;
    srs: ProcessUsage;
    relay: ProcessUsage;
}

export interface MetricSample {
    ts: number;
    cpu: number;
    ramUsed: number;
    ramTotal: number;
    rxBps: number;
    txBps: number;
}

// The body of GET /api/metrics/system.
export interface SystemMetrics {
    cpu: { cores: number; percent: number };
    ram: { usedBytes: number; totalBytes: number };
    disk: { totalBytes: number; usedBytes: number } | null;
    net: { rxBytesPerSec: number; txBytesPerSec: number };
    node: ProcessUsage;
    srs: ProcessUsage;
    relay: ProcessUsage;
    uptimeSeconds: number;
}

export interface ResourceUsageReaders {
    now(): number;
    // Cumulative CPU times of every core (os.cpus().map((c) => c.times)).
    cpuTimes(): Record<string, number>[];
    totalMemory(): number;
    freeMemory(): number;
    hostMemory(): HostMemory | null;
    diskUsage(dir: string): DiskUsage | null;
    // null when the config cannot be read: the root filesystem alone is then watched.
    dataDir(): string | null;
    netCounters(): NetCounters | null;
    processRssBytes(pid: number): number | null;
    createCpuTracker(): ProcCpuTracker;
    // SRS's /api/v1/summaries, parsed. Rejects when SRS does not answer well.
    srsSummaries(): Promise<unknown>;
    pid: number;
    uptimeSeconds(): number;
}

const hostReaders: ResourceUsageReaders = {
    now: () => Date.now(),
    cpuTimes: () => os.cpus().map((c) => c.times),
    totalMemory: () => os.totalmem(),
    freeMemory: () => os.freemem(),
    hostMemory: readHostMemory,
    diskUsage: readDiskUsage,
    dataDir: () => {
        try {
            return path.dirname(readAppConfig().databasePath);
        } catch {
            return null;
        }
    },
    netCounters: readNetCounters,
    processRssBytes: readProcRssBytes,
    createCpuTracker: createProcCpuTracker,
    srsSummaries: fetchSrsSummaries,
    pid: process.pid,
    uptimeSeconds: () => process.uptime(),
};

export interface ResourceUsageOptions {
    // The relay's process id, or null while it is not running.
    relayPid: () => number | null;
    readers?: Partial<ResourceUsageReaders>;
}

export interface ResourceUsage {
    // Takes the first samples and starts the timers. A second call does nothing.
    start(): void;
    stop(): void;
    system(): SystemMetrics;
    // Every sample, or only those newer than `after` (a dashboard asking for the increment).
    history(after?: number): MetricSample[];
    // The latest samples, up to 10 s old, for the diagnostics snapshot and the CPU suspects.
    processUsage(): ProcessUsages;
}

const NO_USAGE: ProcessUsage = { cpuPercent: null, ramBytes: null };

export function createResourceUsage(options: ResourceUsageOptions): ResourceUsage {
    const readers: ResourceUsageReaders = { ...hostReaders, ...options.readers };

    let prevCpu = readers.cpuTimes();
    function cpuPercent(): number {
        const curr = readers.cpuTimes();
        let totalIdle = 0;
        let totalTick = 0;
        for (let i = 0; i < curr.length; i++) {
            const prev = prevCpu[i] ?? curr[i];
            const cur = curr[i];
            totalIdle += cur.idle - prev.idle;
            totalTick +=
                Object.values(cur).reduce((a, b) => a + b, 0) -
                Object.values(prev).reduce((a, b) => a + b, 0);
        }
        prevCpu = curr;
        return totalTick === 0 ? 0 : Math.round((1 - totalIdle / totalTick) * 100);
    }

    // The same filesystems the host disk alert watches, so the figure on the dashboard and
    // the alert cannot disagree: the fuller of the two, by the free space the alert measures.
    let disk: SystemMetrics['disk'] = null;
    function updateDisk(): void {
        let fullest: DiskUsage | null = null;
        for (const { disk: candidate } of watchedFilesystems(
            readers.dataDir(),
            readers.diskUsage,
        )) {
            if (
                !fullest ||
                candidate.availableBytes / candidate.totalBytes <
                    fullest.availableBytes / fullest.totalBytes
            ) {
                fullest = candidate;
            }
        }
        disk = fullest && {
            totalBytes: fullest.totalBytes,
            usedBytes: fullest.totalBytes - fullest.availableBytes,
        };
    }

    let net = { rxBytesPerSec: 0, txBytesPerSec: 0 };
    let prevNet: (NetCounters & { at: number }) | null = null;
    function updateNet(): void {
        const counters = readers.netCounters();
        if (!counters) return;
        const now = readers.now();
        if (prevNet) {
            const dt = (now - prevNet.at) / 1000;
            if (dt > 0) {
                net = {
                    rxBytesPerSec: Math.max(0, (counters.rx - prevNet.rx) / dt),
                    txBytesPerSec: Math.max(0, (counters.tx - prevNet.tx) / dt),
                };
            }
        }
        prevNet = { ...counters, at: now };
    }

    // This server's own process uses the same procfs technique as SRS's and the relay's, so
    // all three "process" columns are measured the same way (and match the ps/top
    // single-core-relative convention).
    const nodeCpu = readers.createCpuTracker();
    const relayCpu = readers.createCpuTracker();
    let nodeUsage: ProcessUsage = NO_USAGE;
    let srsUsage: ProcessUsage = NO_USAGE;
    let relayUsage: ProcessUsage = NO_USAGE;

    function updateNode(): void {
        const pid = readers.pid;
        nodeUsage = {
            cpuPercent: nodeCpu.sample(pid, pid),
            ramBytes: readers.processRssBytes(pid),
        };
    }

    async function updateSrs(): Promise<void> {
        try {
            const data = (await readers.srsSummaries()) as {
                data?: { self?: { cpu_percent?: number; mem_kbyte?: number } };
            };
            const self = data.data?.self;
            srsUsage = {
                cpuPercent: typeof self?.cpu_percent === 'number' ? self.cpu_percent * 100 : null,
                ramBytes: typeof self?.mem_kbyte === 'number' ? self.mem_kbyte * 1024 : null,
            };
        } catch {
            // SRS did not answer: its figures are unknown, not the last known ones.
            srsUsage = NO_USAGE;
        }
    }

    function updateRelay(): void {
        const pid = options.relayPid();
        relayUsage =
            pid == null
                ? NO_USAGE
                : { cpuPercent: relayCpu.sample(pid, pid), ramBytes: readers.processRssBytes(pid) };
    }

    // Used = total - MemAvailable, like the health poll's low-memory check: page cache the
    // kernel can reclaim is not counted as used (os.freemem() would).
    function ramUsedBytes(totalMem: number): number {
        const host = readers.hostMemory();
        return host ? host.totalBytes - host.availableBytes : totalMem - readers.freeMemory();
    }

    const samples: MetricSample[] = [];
    function sample(): void {
        const totalMem = readers.totalMemory();
        samples.push({
            ts: readers.now(),
            cpu: cpuPercent(),
            ramUsed: ramUsedBytes(totalMem),
            ramTotal: totalMem,
            rxBps: net.rxBytesPerSec,
            txBps: net.txBytesPerSec,
        });
        if (samples.length > HISTORY_MAX) samples.shift();
    }

    function updateProcesses(): void {
        updateNode();
        void updateSrs();
        updateRelay();
    }

    let timers: NodeJS.Timeout[] = [];
    function start(): void {
        if (timers.length > 0) return;
        updateDisk();
        updateNet();
        sample();
        updateProcesses();
        for (const [run, intervalMs] of [
            [updateDisk, DISK_STATS_INTERVAL_MS],
            [updateNet, NET_STATS_INTERVAL_MS],
            [sample, SAMPLE_INTERVAL_MS],
            [updateProcesses, PROC_STATS_INTERVAL_MS],
        ] as const) {
            timers.push(setInterval(run, intervalMs).unref());
        }
    }

    function stop(): void {
        for (const timer of timers) clearInterval(timer);
        timers = [];
    }

    function system(): SystemMetrics {
        const latest = samples[samples.length - 1];
        const totalMem = readers.totalMemory();
        return {
            cpu: { cores: readers.cpuTimes().length, percent: latest?.cpu ?? 0 },
            ram: {
                usedBytes: latest?.ramUsed ?? ramUsedBytes(totalMem),
                totalBytes: latest?.ramTotal ?? totalMem,
            },
            disk,
            net: {
                rxBytesPerSec: latest?.rxBps ?? 0,
                txBytesPerSec: latest?.txBps ?? 0,
            },
            node: nodeUsage,
            srs: srsUsage,
            relay: relayUsage,
            uptimeSeconds: readers.uptimeSeconds(),
        };
    }

    return {
        start,
        stop,
        system,
        history: (after) =>
            after === undefined ? [...samples] : samples.filter((s) => s.ts > after),
        processUsage: () => ({ node: nodeUsage, srs: srsUsage, relay: relayUsage }),
    };
}
