import path from 'path';
import { readAppConfig } from '../utils/appConfig.js';
import { formatDuration } from '../utils/duration.js';
import { createHostAlertTracker, type HostAlertTracker } from '../utils/hostAlerts.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';
import {
    formatMb,
    readCpuPressure,
    readDiskUsage,
    readHostMemory,
    topProcessesByRss,
    watchedFilesystems,
} from '../utils/procStats.js';

// Host resource alerts (memory, CPU, disk). Each transition is a journal line, a
// diagnostics event and a row in the dashboard's Server events table; the table is
// in memory only, the diagnostics events are the durable record. One `check` per
// health poll.

// Host MemAvailable thresholds, as a fraction of total RAM. Enter/exit differ
// so a box hovering near the line doesn't flap; the transition events carry the
// top processes by RSS so an OOM investigation can see who was holding memory.
const HOST_MEMORY_LOW_RATIO = 0.15;
const HOST_MEMORY_RECOVER_RATIO = 0.2;
// Host CPU pressure (PSI "some", 10 s average: percent of time a runnable task waited
// for a CPU). Measured on an 8-CPU host with busy loops: 8 loops (all CPUs busy, none
// starved) read 25-30, 10 loops 46-53 and 16 loops (2x oversubscribed) only 68-70, so
// 90 is never reached. It must stay at 50 or more for 30 s to start an alert and below
// 30 for 60 s to end it, so a brief encode start or a reading near the line is one episode.
const HOST_CPU_PRESSURE_HIGH = 50;
const HOST_CPU_PRESSURE_RECOVER = 30;
const HOST_CPU_START_POLLS = 6;
const HOST_CPU_END_POLLS = 12;
// Free space of the data directory's filesystem (database, diagnostics, HLS previews)
// and of the root filesystem (journald, SRS logs), as a fraction of its size.
const HOST_DISK_LOW_RATIO = 0.1;
const HOST_DISK_RECOVER_RATIO = 0.15;

const bytesToMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

export type HostAlertKind = 'cpu' | 'memory' | 'disk';

// Where the readings come from. The default reads /proc and the filesystem; tests
// pass fixed values instead of patching `fs`.
export interface HostReaders {
    memory: typeof readHostMemory;
    cpuPressure: typeof readCpuPressure;
    diskUsage: typeof readDiskUsage;
    topProcessesByRss: typeof topProcessesByRss;
    dataDir: () => string;
}

const procReaders: HostReaders = {
    memory: readHostMemory,
    cpuPressure: readCpuPressure,
    diskUsage: readDiskUsage,
    topProcessesByRss,
    dataDir: () => path.dirname(readAppConfig().databasePath),
};

export interface HostMonitorOptions {
    pollIntervalMs: number;
    // One row of the Server events table.
    record: (type: 'problem' | 'recovered', message: string) => void;
    // The managed processes using the most CPU, to name suspects when CPU saturates.
    topCpuConsumers: (limit: number) => { name: string; cpuPercent: number }[];
    diagnostics?: DiagnosticsLogger;
    readers?: HostReaders;
}

export function createHostMonitor(options: HostMonitorOptions) {
    const { pollIntervalMs, record, topCpuConsumers, diagnostics } = options;
    const readers = options.readers ?? procReaders;

    const memoryAlert = createHostAlertTracker({
        worse: 'lower',
        breached: (ratio) => ratio < HOST_MEMORY_LOW_RATIO,
        cleared: (ratio) => ratio >= HOST_MEMORY_RECOVER_RATIO,
        startPolls: 1,
        endPolls: 1,
    });
    const cpuAlert = createHostAlertTracker({
        worse: 'higher',
        breached: (pressure) => pressure >= HOST_CPU_PRESSURE_HIGH,
        cleared: (pressure) => pressure < HOST_CPU_PRESSURE_RECOVER,
        startPolls: HOST_CPU_START_POLLS,
        endPolls: HOST_CPU_END_POLLS,
    });
    // One tracker per filesystem, keyed by its device so a data directory on the root
    // filesystem is checked once.
    const diskAlerts = new Map<number, HostAlertTracker>();

    function emit(
        type: 'problem' | 'recovered',
        message: string,
        event: string,
        fields: Record<string, unknown>,
    ): void {
        record(type, message);
        if (type === 'problem') console.warn(`[host] ${message}`);
        else console.log(`[host] ${message}`);
        diagnostics?.event(event, { message, ...fields });
    }

    function checkMemory(): void {
        const host = readers.memory();
        if (!host) return;
        const ratio = host.availableBytes / host.totalBytes;
        const change = memoryAlert.update(ratio);
        if (!change) return;
        const started = change.change === 'started';
        const fields = {
            availableMb: bytesToMb(host.availableBytes),
            totalMb: bytesToMb(host.totalBytes),
            swapUsedMb: bytesToMb(host.swapUsedBytes),
            thresholdPercent: Math.round(
                (started ? HOST_MEMORY_LOW_RATIO : HOST_MEMORY_RECOVER_RATIO) * 100,
            ),
        };
        if (started) {
            const top = readers.topProcessesByRss(5).map((p) => ({
                pid: p.pid,
                name: p.name,
                rssMb: bytesToMb(p.rssBytes),
            }));
            emit(
                'problem',
                `Memory low: ${formatMb(fields.availableMb)} of ${formatMb(fields.totalMb)} available; top: ${top
                    .map((p) => `${p.name}(${p.pid})=${formatMb(p.rssMb)}`)
                    .join(' ')}`,
                'host-memory-low',
                { ...fields, topProcesses: top },
            );
        } else {
            emit(
                'recovered',
                `Memory recovered: ${formatMb(fields.availableMb)} available`,
                'host-memory-recovered',
                fields,
            );
        }
    }

    function checkCpu(): void {
        const pressure = readers.cpuPressure();
        if (!pressure) return; // no PSI: no CPU alert, the snapshot records cpuPressure null
        const change = cpuAlert.update(pressure.some10);
        if (!change) return;
        if (change.change === 'started') {
            const top = topCpuConsumers(5);
            emit(
                'problem',
                `CPU saturated: pressure ${pressure.some10}% (10 s) for ${(HOST_CPU_START_POLLS * pollIntervalMs) / 1000}s; top: ${
                    top.map((c) => `${c.name}=${c.cpuPercent}%`).join(' ') || 'unknown'
                }`,
                'host-cpu-high',
                {
                    pressure10: pressure.some10,
                    pressure60: pressure.some60,
                    thresholdPercent: HOST_CPU_PRESSURE_HIGH,
                    topConsumers: top,
                },
            );
        } else {
            emit(
                'recovered',
                `CPU recovered: pressure ${pressure.some10}% (10 s), peak ${change.worst}% over ${formatDuration(change.polls * pollIntervalMs)}`,
                'host-cpu-recovered',
                {
                    pressure10: pressure.some10,
                    pressure60: pressure.some60,
                    peakPressure10: change.worst,
                    durationMs: change.polls * pollIntervalMs,
                    thresholdPercent: HOST_CPU_PRESSURE_RECOVER,
                },
            );
        }
    }

    function checkDisk(): void {
        for (const { dir, disk } of watchedFilesystems(readers.dataDir(), readers.diskUsage)) {
            let tracker = diskAlerts.get(disk.device);
            if (!tracker) {
                tracker = createHostAlertTracker({
                    worse: 'lower',
                    breached: (ratio) => ratio < HOST_DISK_LOW_RATIO,
                    cleared: (ratio) => ratio >= HOST_DISK_RECOVER_RATIO,
                    startPolls: 1,
                    endPolls: 1,
                });
                diskAlerts.set(disk.device, tracker);
            }
            const change = tracker.update(disk.availableBytes / disk.totalBytes);
            if (!change) continue;
            const started = change.change === 'started';
            const fields = {
                path: dir,
                availableMb: bytesToMb(disk.availableBytes),
                totalMb: bytesToMb(disk.totalBytes),
                thresholdPercent: Math.round(
                    (started ? HOST_DISK_LOW_RATIO : HOST_DISK_RECOVER_RATIO) * 100,
                ),
            };
            emit(
                started ? 'problem' : 'recovered',
                started
                    ? `Disk space low on ${dir}: ${formatMb(fields.availableMb)} of ${formatMb(fields.totalMb)} free`
                    : `Disk space recovered on ${dir}: ${formatMb(fields.availableMb)} free`,
                started ? 'host-disk-low' : 'host-disk-recovered',
                fields,
            );
        }
    }

    return {
        check(): void {
            checkMemory();
            checkCpu();
            checkDisk();
        },
        openAlerts(): HostAlertKind[] {
            const open: HostAlertKind[] = [];
            if (cpuAlert.active) open.push('cpu');
            if (memoryAlert.active) open.push('memory');
            if ([...diskAlerts.values()].some((tracker) => tracker.active)) open.push('disk');
            return open;
        },
    };
}
