import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import type { Express } from 'express';
import { readSrsConfigValues } from '../utils/srsConfig.js';
import { readProcRssBytes, createProcCpuTracker, readHostMemory } from '../utils/procStats.js';
import type { SrtRelayService } from '../services/srtRelay.js';

const DISK_STATS_INTERVAL_MS = 30_000;
const NET_STATS_INTERVAL_MS = 3_000;
const SAMPLE_INTERVAL_MS = 5_000;
const PROC_STATS_INTERVAL_MS = 10_000;
const PROC_STATS_FETCH_TIMEOUT_MS = 2000;
const HISTORY_MAX = 1440; // 2 hours at 5 s — client trims to desired window

let prevCpu = os.cpus().map((c) => c.times);

function getCpuPercent(): number {
    const cpus = os.cpus();
    const curr = cpus.map((c) => c.times);
    let totalIdle = 0,
        totalTick = 0;
    for (let i = 0; i < cpus.length; i++) {
        const prev = prevCpu[i];
        const cur = curr[i];
        const idleDelta = cur.idle - prev.idle;
        const totalDelta =
            Object.values(cur).reduce((a, b) => a + b, 0) -
            Object.values(prev).reduce((a, b) => a + b, 0);
        totalIdle += idleDelta;
        totalTick += totalDelta;
    }
    prevCpu = curr;
    return totalTick === 0 ? 0 : Math.round((1 - totalIdle / totalTick) * 100);
}

interface DiskStats {
    totalBytes: number;
    usedBytes: number;
}

let diskStats: DiskStats | null = null;

function updateDiskStats(): void {
    execFile('df', ['-B1', '/'], (_err, stdout) => {
        if (_err) return;
        const parts = stdout.trim().split('\n')[1]?.trim().split(/\s+/);
        if (!parts || parts.length < 3) return;
        const total = parseInt(parts[1], 10);
        const used = parseInt(parts[2], 10);
        if (!isNaN(total) && !isNaN(used)) diskStats = { totalBytes: total, usedBytes: used };
    });
}

interface NetStats {
    rxBytesPerSec: number;
    txBytesPerSec: number;
}

let netStats: NetStats = { rxBytesPerSec: 0, txBytesPerSec: 0 };
let prevNetBytes: { rx: number; tx: number } | null = null;
let prevNetTime = Date.now();

function updateNetStats(): void {
    try {
        const raw = fs.readFileSync('/proc/net/dev', 'utf8');
        let rx = 0,
            tx = 0;
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            const colon = trimmed.indexOf(':');
            if (colon < 0) continue;
            const iface = trimmed.slice(0, colon).trim();
            if (iface === 'lo') continue;
            const fields = trimmed
                .slice(colon + 1)
                .trim()
                .split(/\s+/);
            rx += parseInt(fields[0], 10) || 0;
            tx += parseInt(fields[8], 10) || 0;
        }
        const now = Date.now();
        if (prevNetBytes) {
            const dt = (now - prevNetTime) / 1000;
            if (dt > 0) {
                netStats = {
                    rxBytesPerSec: Math.max(0, (rx - prevNetBytes.rx) / dt),
                    txBytesPerSec: Math.max(0, (tx - prevNetBytes.tx) / dt),
                };
            }
        }
        prevNetBytes = { rx, tx };
        prevNetTime = now;
    } catch {
        // /proc/net/dev not available on this platform
    }
}

export interface ProcUsage {
    cpuPercent: number | null;
    ramBytes: number | null;
}

const relayCpuTracker = createProcCpuTracker();
const nodeCpuTracker = createProcCpuTracker();

let nodeUsage: ProcUsage = { cpuPercent: null, ramBytes: null };
let srsUsage: ProcUsage = { cpuPercent: null, ramBytes: null };
let relayUsage: ProcUsage = { cpuPercent: null, ramBytes: null };

// This app's own Node.js process — same procfs technique as SRS/relay below,
// just pointed at our own pid, so all three "process" columns are measured
// the same way (and match the ps/top single-core-relative convention).
function updateNodeUsage(): void {
    const pid = process.pid;
    nodeUsage = {
        cpuPercent: nodeCpuTracker.sample(pid, pid),
        ramBytes: readProcRssBytes(pid),
    };
}

async function updateSrsUsage(): Promise<void> {
    try {
        const srsApiUrl = readSrsConfigValues().apiUrl;
        const res = await fetch(`${srsApiUrl}/api/v1/summaries`, {
            signal: AbortSignal.timeout(PROC_STATS_FETCH_TIMEOUT_MS),
            headers: { Connection: 'close' },
        });
        if (!res.ok) throw new Error(`SRS summaries HTTP ${res.status}`);
        const data = (await res.json()) as {
            data?: { self?: { cpu_percent?: number; mem_kbyte?: number } };
        };
        const self = data.data?.self;
        srsUsage = {
            cpuPercent: typeof self?.cpu_percent === 'number' ? self.cpu_percent * 100 : null,
            ramBytes: typeof self?.mem_kbyte === 'number' ? self.mem_kbyte * 1024 : null,
        };
    } catch {
        srsUsage = { cpuPercent: null, ramBytes: null };
    }
}

function updateRelayUsage(srtRelayService: SrtRelayService): void {
    const pid = srtRelayService.getStats().pid;
    if (pid == null) {
        relayUsage = { cpuPercent: null, ramBytes: null };
        return;
    }
    relayUsage = {
        cpuPercent: relayCpuTracker.sample(pid, pid),
        ramBytes: readProcRssBytes(pid),
    };
}

// Latest samples for the diagnostics snapshot, so it reports the same numbers
// the dashboard shows instead of sampling the three processes a second time.
export function getProcessUsage(): { node: ProcUsage; srs: ProcUsage; relay: ProcUsage } {
    return { node: nodeUsage, srs: srsUsage, relay: relayUsage };
}

export interface MetricSample {
    ts: number;
    cpu: number;
    ramUsed: number;
    ramTotal: number;
    rxBps: number;
    txBps: number;
}

const metricsHistory: MetricSample[] = [];
let metricsStarted = false;

// Used = total - MemAvailable, like the health poll's low-memory check: page
// cache the kernel can reclaim is not counted as used (os.freemem() would).
function ramUsedBytes(totalMem: number): number {
    const host = readHostMemory();
    return host ? host.totalBytes - host.availableBytes : totalMem - os.freemem();
}

function sampleMetrics(): void {
    const totalMem = os.totalmem();
    metricsHistory.push({
        ts: Date.now(),
        cpu: getCpuPercent(),
        ramUsed: ramUsedBytes(totalMem),
        ramTotal: totalMem,
        rxBps: netStats.rxBytesPerSec,
        txBps: netStats.txBytesPerSec,
    });
    if (metricsHistory.length > HISTORY_MAX) metricsHistory.shift();
}

function startMetricsSampling(srtRelayService: SrtRelayService): void {
    if (metricsStarted) return;
    metricsStarted = true;
    updateDiskStats();
    setInterval(updateDiskStats, DISK_STATS_INTERVAL_MS).unref();
    updateNetStats();
    setInterval(updateNetStats, NET_STATS_INTERVAL_MS).unref();
    sampleMetrics();
    setInterval(sampleMetrics, SAMPLE_INTERVAL_MS).unref();
    updateNodeUsage();
    void updateSrsUsage();
    updateRelayUsage(srtRelayService);
    setInterval(() => {
        updateNodeUsage();
        void updateSrsUsage();
        updateRelayUsage(srtRelayService);
    }, PROC_STATS_INTERVAL_MS).unref();
}

export function registerMetricsApi(app: Express, srtRelayService: SrtRelayService): void {
    startMetricsSampling(srtRelayService);

    app.get('/api/metrics/system', (_req, res) => {
        const s = metricsHistory[metricsHistory.length - 1];
        const totalMem = os.totalmem();
        res.json({
            cpu: { cores: os.cpus().length, percent: s?.cpu ?? 0 },
            ram: {
                usedBytes: s?.ramUsed ?? ramUsedBytes(totalMem),
                totalBytes: s?.ramTotal ?? totalMem,
            },
            disk: diskStats,
            net: {
                rxBytesPerSec: s?.rxBps ?? 0,
                txBytesPerSec: s?.txBps ?? 0,
            },
            node: nodeUsage,
            srs: srsUsage,
            relay: relayUsage,
            uptimeSeconds: process.uptime(),
        });
    });

    app.get('/api/metrics/history', (req, res) => {
        // The dashboard keeps samples it has already received. On regular
        // refreshes it asks only for samples newer than its latest timestamp;
        // omitting/invalidating `after` preserves the initial full-history API.
        const requestedAfter = typeof req.query.after === 'string' ? Number(req.query.after) : NaN;
        const samples = Number.isFinite(requestedAfter)
            ? metricsHistory.filter((sample) => sample.ts > requestedAfter)
            : metricsHistory;
        res.json(samples);
    });
}
