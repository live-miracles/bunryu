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
// health poll. The alerts open right now go to the dashboard in /api/health
// (`hostAlerts`), which shows them as banners and colours the top bar's CPU / RAM / Disk
// from them, so the two cannot disagree: the rules live only here.
//
// Every resource has two levels on the same figure the top bar shows (percent used): a
// warning from 70 % and an error from 90 %. The operator keeps production under 65 %, so a
// warning ends only once the figure is back under 65 % and an error once it is under 85 %;
// in between an open alert stays open and a closed one stays closed, so a box hovering near
// a line is one episode, not a stream of them.
const HOST_WARN_PERCENT = 70;
const HOST_ERROR_PERCENT = 90;
const HOST_WARN_RECOVER_PERCENT = 65;
const HOST_ERROR_RECOVER_PERCENT = 85;
// CPU is the machine's busy percent, which is what the top bar shows and what an operator
// sizes against; it must hold for 30 s to start an alert (a brief encode start is not an
// episode) and 60 s to end it. Memory and disk are checked on every poll.
const HOST_CPU_START_POLLS = 6;
const HOST_CPU_END_POLLS = 12;
// CPU pressure (PSI "some", 10 s average: percent of time a runnable task waited for a CPU)
// is the second CPU signal, an error on its own. Busy percent says how much of the machine is
// used; pressure says whether work is being starved, and it stays low until the machine is
// full: measured on an 8-CPU host with busy loops, 8 loops (all CPUs busy, none starved)
// read 25-30, 10 loops 46-53 and 16 loops (2x oversubscribed) only 68-70, so 90 is never
// reached. 50 for 30 s starts it and below 30 for 60 s ends it.
const HOST_CPU_PRESSURE_HIGH = 50;
const HOST_CPU_PRESSURE_RECOVER = 30;

const bytesToMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

export type HostAlertKind = 'cpu' | 'memory' | 'disk';
export type HostAlertSeverity = 'warning' | 'error';

// An alert that is open right now, as /api/health carries it.
export interface HostAlert {
    kind: HostAlertKind;
    severity: HostAlertSeverity;
    // One sentence for the banner, with the latest reading.
    message: string;
    // When it reached this severity (ms since epoch).
    sinceMs: number;
}

// Where the readings come from. The default reads /proc and the filesystem; tests
// pass fixed values instead of patching `fs`.
export interface HostReaders {
    memory: typeof readHostMemory;
    cpuPressure: typeof readCpuPressure;
    // The machine's busy percent, the figure the dashboard's top bar shows; null when it
    // has none yet.
    cpuPercent: () => number | null;
    diskUsage: typeof readDiskUsage;
    topProcessesByRss: typeof topProcessesByRss;
    dataDir: () => string;
}

const procReaders: HostReaders = {
    memory: readHostMemory,
    cpuPressure: readCpuPressure,
    cpuPercent: () => null,
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
    readers?: Partial<HostReaders>;
    now?: () => number;
}

// One resource's two levels over the same figure (percent used): a tracker per level.
interface Meter {
    warning: HostAlertTracker;
    error: HostAlertTracker;
}

interface MeterChange {
    severity: HostAlertSeverity;
    change: 'started' | 'ended';
    worst: number;
    polls: number;
}

function createMeter(startPolls: number, endPolls: number): Meter {
    const level = (high: number, recover: number): HostAlertTracker =>
        createHostAlertTracker({
            worse: 'higher',
            breached: (percent) => percent >= high,
            cleared: (percent) => percent < recover,
            startPolls,
            endPolls,
        });
    return {
        warning: level(HOST_WARN_PERCENT, HOST_WARN_RECOVER_PERCENT),
        error: level(HOST_ERROR_PERCENT, HOST_ERROR_RECOVER_PERCENT),
    };
}

// Feeds a reading to both levels. What comes back is what to report: a reading that opens
// both levels at once is one event (the error), and one that closes both is one recovery
// (the warning's), not two.
function feedMeter(meter: Meter, percent: number): MeterChange[] {
    const changes: MeterChange[] = [];
    const warning = meter.warning.update(percent);
    const error = meter.error.update(percent);
    if (error?.change === 'started') changes.push({ severity: 'error', ...error });
    else if (warning?.change === 'started') changes.push({ severity: 'warning', ...warning });
    if (error?.change === 'ended' && warning?.change !== 'ended') {
        changes.push({ severity: 'error', ...error });
    }
    if (warning?.change === 'ended') changes.push({ severity: 'warning', ...warning });
    return changes;
}

const meterSeverity = (meter: Meter): HostAlertSeverity | null =>
    meter.error.active ? 'error' : meter.warning.active ? 'warning' : null;

const usedPercent = (availableBytes: number, totalBytes: number): number =>
    (1 - availableBytes / totalBytes) * 100;

export function createHostMonitor(options: HostMonitorOptions) {
    const { pollIntervalMs, record, topCpuConsumers, diagnostics } = options;
    const readers: HostReaders = { ...procReaders, ...options.readers };
    const now = options.now ?? Date.now;

    const memoryMeter = createMeter(1, 1);
    const cpuMeter = createMeter(HOST_CPU_START_POLLS, HOST_CPU_END_POLLS);
    const cpuPressureAlert = createHostAlertTracker({
        worse: 'higher',
        breached: (pressure) => pressure >= HOST_CPU_PRESSURE_HIGH,
        cleared: (pressure) => pressure < HOST_CPU_PRESSURE_RECOVER,
        startPolls: HOST_CPU_START_POLLS,
        endPolls: HOST_CPU_END_POLLS,
    });
    // One meter per filesystem, keyed by its device so a data directory on the root
    // filesystem is checked once, with the path and percent last read.
    const diskMeters = new Map<number, { meter: Meter; path: string; percent: number }>();
    // The latest readings, for the sentence of an open alert.
    const latest = { memory: 0, cpu: 0, pressure: 0 };

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

    const thresholdOf = (severity: HostAlertSeverity, started: boolean): number =>
        severity === 'error'
            ? started
                ? HOST_ERROR_PERCENT
                : HOST_ERROR_RECOVER_PERCENT
            : started
              ? HOST_WARN_PERCENT
              : HOST_WARN_RECOVER_PERCENT;
    const levelWord = (severity: HostAlertSeverity): string =>
        severity === 'error' ? 'critical' : 'high';

    function checkMemory(): void {
        const host = readers.memory();
        if (!host) return;
        const percent = usedPercent(host.availableBytes, host.totalBytes);
        latest.memory = percent;
        for (const change of feedMeter(memoryMeter, percent)) {
            const started = change.change === 'started';
            const fields = {
                severity: change.severity,
                usedPercent: Math.round(percent),
                availableMb: bytesToMb(host.availableBytes),
                totalMb: bytesToMb(host.totalBytes),
                swapUsedMb: bytesToMb(host.swapUsedBytes),
                thresholdPercent: thresholdOf(change.severity, started),
            };
            if (started) {
                const top = readers.topProcessesByRss(5).map((p) => ({
                    pid: p.pid,
                    name: p.name,
                    rssMb: bytesToMb(p.rssBytes),
                }));
                emit(
                    'problem',
                    `Memory ${levelWord(change.severity)}: ${fields.usedPercent}% used (${formatMb(fields.availableMb)} of ${formatMb(fields.totalMb)} available); top: ${top
                        .map((p) => `${p.name}(${p.pid})=${formatMb(p.rssMb)}`)
                        .join(' ')}`,
                    `host-memory-${levelWord(change.severity)}`,
                    { ...fields, topProcesses: top },
                );
            } else {
                emit(
                    'recovered',
                    `Memory ${change.severity === 'error' ? 'no longer critical' : 'recovered'}: ${fields.usedPercent}% used (${formatMb(fields.availableMb)} available)`,
                    'host-memory-recovered',
                    fields,
                );
            }
        }
    }

    function checkCpu(): void {
        const busy = readers.cpuPercent();
        if (busy !== null) {
            latest.cpu = busy;
            for (const change of feedMeter(cpuMeter, busy)) {
                const started = change.change === 'started';
                const fields = {
                    severity: change.severity,
                    busyPercent: Math.round(busy),
                    thresholdPercent: thresholdOf(change.severity, started),
                };
                if (started) {
                    const top = topCpuConsumers(5);
                    emit(
                        'problem',
                        `CPU ${levelWord(change.severity)}: ${fields.busyPercent}% busy for ${(HOST_CPU_START_POLLS * pollIntervalMs) / 1000}s; top: ${
                            top.map((c) => `${c.name}=${c.cpuPercent}%`).join(' ') || 'unknown'
                        }`,
                        `host-cpu-${levelWord(change.severity)}`,
                        { ...fields, topConsumers: top },
                    );
                } else {
                    emit(
                        'recovered',
                        `CPU ${change.severity === 'error' ? 'no longer critical' : 'recovered'}: ${fields.busyPercent}% busy, peak ${Math.round(change.worst)}% over ${formatDuration(change.polls * pollIntervalMs)}`,
                        'host-cpu-recovered',
                        {
                            ...fields,
                            peakBusyPercent: Math.round(change.worst),
                            durationMs: change.polls * pollIntervalMs,
                        },
                    );
                }
            }
        }
        const pressure = readers.cpuPressure();
        if (!pressure) return; // no PSI: no pressure alert, the snapshot records cpuPressure null
        latest.pressure = pressure.some10;
        const change = cpuPressureAlert.update(pressure.some10);
        if (!change) return;
        if (change.change === 'started') {
            const top = topCpuConsumers(5);
            emit(
                'problem',
                `CPU saturated: pressure ${pressure.some10}% (10 s) for ${(HOST_CPU_START_POLLS * pollIntervalMs) / 1000}s; top: ${
                    top.map((c) => `${c.name}=${c.cpuPercent}%`).join(' ') || 'unknown'
                }`,
                'host-cpu-saturated',
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
                `CPU pressure recovered: ${pressure.some10}% (10 s), peak ${change.worst}% over ${formatDuration(change.polls * pollIntervalMs)}`,
                'host-cpu-pressure-recovered',
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
            const percent = usedPercent(disk.availableBytes, disk.totalBytes);
            let entry = diskMeters.get(disk.device);
            if (!entry) {
                entry = { meter: createMeter(1, 1), path: dir, percent };
                diskMeters.set(disk.device, entry);
            }
            entry.percent = percent;
            for (const change of feedMeter(entry.meter, percent)) {
                const started = change.change === 'started';
                const fields = {
                    severity: change.severity,
                    path: dir,
                    usedPercent: Math.round(percent),
                    availableMb: bytesToMb(disk.availableBytes),
                    totalMb: bytesToMb(disk.totalBytes),
                    thresholdPercent: thresholdOf(change.severity, started),
                };
                emit(
                    started ? 'problem' : 'recovered',
                    started
                        ? `Disk space ${levelWord(change.severity)} on ${dir}: ${fields.usedPercent}% used (${formatMb(fields.availableMb)} of ${formatMb(fields.totalMb)} free)`
                        : `Disk space ${change.severity === 'error' ? 'no longer critical' : 'recovered'} on ${dir}: ${fields.usedPercent}% used (${formatMb(fields.availableMb)} free)`,
                    started ? `host-disk-${levelWord(change.severity)}` : 'host-disk-recovered',
                    fields,
                );
            }
        }
    }

    // When each kind reached its current severity.
    const since = new Map<HostAlertKind, { severity: HostAlertSeverity; sinceMs: number }>();

    function currentAlerts(): Omit<HostAlert, 'sinceMs'>[] {
        const open: Omit<HostAlert, 'sinceMs'>[] = [];
        const busy = Math.round(latest.cpu);
        const cpuSeverity = meterSeverity(cpuMeter);
        if (cpuPressureAlert.active) {
            open.push({
                kind: 'cpu',
                severity: 'error',
                message: `CPU is saturated: tasks waited ${Math.round(latest.pressure)}% of the last 10 s for a CPU.`,
            });
        } else if (cpuSeverity) {
            open.push({
                kind: 'cpu',
                severity: cpuSeverity,
                message: `CPU is at ${busy}% (${cpuSeverity === 'error' ? `critical from ${HOST_ERROR_PERCENT}` : `warning from ${HOST_WARN_PERCENT}`}%).`,
            });
        }
        const memorySeverity = meterSeverity(memoryMeter);
        if (memorySeverity) {
            open.push({
                kind: 'memory',
                severity: memorySeverity,
                message: `Memory is at ${Math.round(latest.memory)}% (${memorySeverity === 'error' ? `critical from ${HOST_ERROR_PERCENT}` : `warning from ${HOST_WARN_PERCENT}`}%).`,
            });
        }
        // The fullest filesystem among those with an open alert speaks for the disk.
        let worstDisk: { severity: HostAlertSeverity; path: string; percent: number } | null = null;
        for (const entry of diskMeters.values()) {
            const severity = meterSeverity(entry.meter);
            if (!severity) continue;
            if (
                !worstDisk ||
                (severity === 'error' && worstDisk.severity === 'warning') ||
                (severity === worstDisk.severity && entry.percent > worstDisk.percent)
            ) {
                worstDisk = { severity, path: entry.path, percent: entry.percent };
            }
        }
        if (worstDisk) {
            open.push({
                kind: 'disk',
                severity: worstDisk.severity,
                message: `Disk ${worstDisk.path} is ${Math.round(worstDisk.percent)}% full (${worstDisk.severity === 'error' ? `critical from ${HOST_ERROR_PERCENT}` : `warning from ${HOST_WARN_PERCENT}`}%).`,
            });
        }
        return open;
    }

    return {
        check(): void {
            checkMemory();
            checkCpu();
            checkDisk();
        },
        // The alerts open right now, one per resource at its worst level.
        openAlerts(): HostAlert[] {
            const at = now();
            const open = currentAlerts();
            const kinds = new Set(open.map((a) => a.kind));
            for (const kind of since.keys()) if (!kinds.has(kind)) since.delete(kind);
            return open.map((alert) => {
                const before = since.get(alert.kind);
                const sinceMs = before?.severity === alert.severity ? before.sinceMs : at;
                since.set(alert.kind, { severity: alert.severity, sinceMs });
                return { ...alert, sinceMs };
            });
        },
    };
}
