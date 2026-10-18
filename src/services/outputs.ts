import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { INPUT_TIMEOUT_US, buildFfmpegArgs, validateOutputUrl } from '../utils/ffmpeg.js';
import { readAppConfig, outputMemoryLimitBytes } from '../utils/appConfig.js';
import {
    readProcRssBytes,
    createProcCpuTracker,
    findPidsByExecutable,
} from '../utils/procStats.js';
import { red, yellow, green } from '../utils/ansiColor.js';
import type { Db, Output } from '../types.js';
import type { InputState } from './inputState.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';
import {
    encodeRecipe,
    isRenditionOutput,
    renditionUrl,
    sharedRecipe,
} from '../utils/renditions.js';
import {
    destinationSocketWarning,
    parseTcpSocketSnapshot,
    type TcpSocket,
} from './outputSockets.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
// An output stopped after this many failed attempts in a row keeps showing that
// as an error until it is started again, so the operator can see it was tried
// and stopped for a reason. A run that lasts STABLE_RUN_MS breaks the streak.
const STOPPED_AFTER_FAILURES = 5;
const STABLE_RUN_MS = 60_000;
// Outputs retry indefinitely — an input can be down for hours during a major
// incident and must come back on its own when it returns. While the input/SRS is
// not ready we only re-check (no ffmpeg spawned), so an idle retry is cheap.
const RECHECK_DELAY_MS = 5000;
// A shared output waits for its rendition (a local process a few seconds from
// ready after it starts), so it polls faster than one waiting for an input.
const RENDITION_RECHECK_DELAY_MS = 1000;
const SIGKILL_DELAY_MS = 5000;
const STDERR_TAIL_BYTES = 3000;
const RESTART_STAGGER_MS = 200;
// One line saying how an attempt failed, for the "stopped after N failed attempts"
// record: the last line ffmpeg printed, else the watchdog reason or exit status.
function failureSummary(
    wasWatchdog: boolean,
    watchdogReason: string | null,
    stderrTail: string,
    exit: number | string | null,
): string {
    const last = stderrTail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
    const text = wasWatchdog
        ? `watchdog: ${watchdogReason ?? 'restarted'}`
        : (last ?? `exit=${exit}`);
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
const appConfig = readAppConfig();
const FFMPEG_CMD = appConfig.ffmpegPath;
const OUTPUT_WATCHDOG_WARMUP_MS = appConfig.outputWatchdog.warmupMs;
const OUTPUT_WATCHDOG_STALL_MS = appConfig.outputWatchdog.stallMs;
const OUTPUT_WATCHDOG_INTERVAL_MS = appConfig.outputWatchdog.intervalMs;
const OUTPUT_SOCKET_WARMUP_MS = appConfig.outputWatchdog.socketWarmupMs;
const OUTPUT_SOCKET_GRACE_MS = appConfig.outputWatchdog.socketGraceMs;
const SOCKET_SNAPSHOT_TIMEOUT_MS = 2000;
// Surface a UI warning once RSS crosses this fraction of the memory limit, well
// before the watchdog actually restarts the process at 100% — gives an early
// (yellow) signal that a leak may be building without waiting for the kill.
const MEMORY_WARNING_RATIO = 0.7;

// ffmpeg prints one timestamp/decode warning per affected packet, which during
// an input timing fault is tens of lines per second per output. Warnings are
// grouped into a "burst" per output: the first line of each distinct kind is
// logged immediately, further lines are counted into one summary per interval,
// and the burst ends after a quiet period.
const TIMESTAMP_QUIET_MS = 30_000;
const TIMESTAMP_SUMMARY_MS = 30_000;
const TIMESTAMP_MAX_KINDS = 8;
// Decode errors alone ("non-existing PPS", "decode_slice_header error") are
// normal for a second or two while an output joins the stream mid-GOP, before
// the next keyframe carries SPS/PPS. They only show on the output card once
// they persist past this grace period, and a decode-only burst shorter than
// that is never written to History (it happens on every output start).
const DECODE_WARNING_GRACE_MS = 10_000;
// A finished burst is also recorded in the output's own Error History (capped,
// shared with crashes). Per output, each class of burst (timing, sustained
// decode) is recorded at most once per interval, so a flapping input cannot
// fill the history's warning slots with near-identical records. Diagnostics
// events always record every burst.
const BURST_HISTORY_INTERVAL_MS = 10 * 60_000;
// `timing` marks warnings that point at the input's timestamps (as opposed to
// decode errors, which also appear harmlessly while joining mid-GOP) — decode-only
// bursts are shown on the output card and written to History less eagerly.
const TIMESTAMP_WARNING_PATTERNS: { pattern: RegExp; timing: boolean }[] = [
    { pattern: /timestamp discontinuity/i, timing: true },
    { pattern: /non[- ]monotonous DTS/i, timing: true },
    { pattern: /invalid DTS/i, timing: true },
    { pattern: /corrupt input/i, timing: false },
    { pattern: /non-existing PPS/i, timing: false },
    { pattern: /decode_slice_header error/i, timing: false },
];

// Strips memory addresses and numbers so repeats of the same warning (which
// differ only in offsets/ids) fold into one kind.
function timestampWarningKind(line: string): string {
    return line.replace(/0x[0-9a-f]+/gi, '0x').replace(/-?\d+/g, '#');
}

const WARNING_KINDS = ['memory', 'socket', 'media-clock'] as const;
type WarningKind = (typeof WARNING_KINDS)[number];

function formatDuration(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    return totalSec < 60 ? `${totalSec}s` : `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

function memoryLimitBytesFor(videoEncoding: string, highRes: boolean): number {
    return outputMemoryLimitBytes(appConfig.outputWatchdog, videoEncoding, highRes);
}

interface OutputStats {
    status: 'running' | 'stopped' | 'failed';
    pid: number | null;
    bitrateKbps: number | null;
    startedAtMs: number | null;
    failures: number;
    warningReason: string | null;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
    cpuPercent: number | null;
    lastOutTimeUs: number | null;
    lastTotalSizeBytes: number | null;
    progressAgeMs: number | null;
    outputProgressAgeMs: number | null;
    // 'rendition' for a shared-encode row (see utils/renditions.ts), else 'output'.
    role: 'rendition' | 'output';
    // The rendition a running shared output is currently pulling, else null.
    renditionId: string | null;
    // Renditions only: running and already writing data (null for other outputs).
    ready: boolean | null;
}

interface TimestampBurst {
    startedAtMs: number;
    lastAtMs: number;
    count: number;
    timing: boolean;
    firstLine: string;
    lastLine: string;
    knownKinds: Set<string>;
    lastSummaryAtMs: number;
    pendingCount: number;
    pendingKinds: Map<string, number>;
}

interface OutputProgress {
    lastProgressAtMs: number;
    lastOutputProgressAtMs: number;
    lastOutTimeMs: number | null;
    lastOutTimeWallMs: number | null;
    lastTotalSize: number | null;
    lastBitrateKbps: number | null;
    stderrTail: string;
    monitorMediaClock: boolean;
    fastMediaSinceMs: number | null;
    mediaClockWarning: string | null;
    lastTimestampWarningAtMs: number | null;
    lastTimestampWarning: string | null;
    timestampBurst: TimestampBurst | null;
}

interface SocketWarning {
    reason: string;
    badSinceMs: number;
}

export interface OutputService {
    getStats(outputId: string): OutputStats;
    start(outputId: string): Promise<void>;
    stop(outputId: string): void;
    stopAndWait(outputId: string): Promise<void>;
    // Stops a running output and starts it again, recording the restart in its
    // Error History as a deliberate stop (not a failure). Restarting a rendition
    // also restarts the outputs pulling from it. False when it is not running.
    restart(outputId: string): boolean;
    // How many running outputs are reading this shared encode right now.
    readersOf(renditionId: string): number;
    restartPipelineOutputs(pipelineId: number, staggerBase?: number): number;
    clearRetryState(outputId: string): void;
    // Lets a service that publishes an output outside this service's own
    // process management (the translation mixer) report that output's real
    // status, so getStats() reflects reality instead of always 'stopped'.
    reportExternalStatus(
        outputId: string,
        status: 'running' | 'stopped' | 'failed',
        pid: number | null,
    ): void;
    // Same idea as reportExternalStatus, but for the ffmpeg progress fields
    // (bitrate/out_time/total_size) getStats() otherwise only gets from this
    // service's own startJob(). The translation mixer owns its ffmpeg process
    // directly and calls this from its own '-progress pipe:1' parsing so its
    // outputs show real bitrate instead of null forever.
    reportExternalProgress(
        outputId: string,
        progress: {
            bitrateKbps: number | null;
            lastOutTimeUs: number | null;
            lastTotalSizeBytes: number | null;
        },
    ): void;
    // Same idea again for process usage: the mixer owns its ffmpeg process, so it
    // samples RSS/CPU itself (and enforces the limit) and reports them here so
    // getStats() shows real numbers and the usual high-memory warning instead
    // of null.
    reportExternalUsage(
        outputId: string,
        usage: { rssBytes: number | null; limitBytes: number; cpuPercent: number | null },
    ): void;
    shutdown(): void;
}

// A fresh instance owns no ffmpeg processes yet, so anything already running
// our ffmpeg binary at construction time must be an orphan left behind by a
// previous instance. Give it a chance to exit cleanly; no need to wait or
// escalate to SIGKILL — an orphan that ignores SIGTERM is no worse off than
// before this ran, and the next restart will sweep it again.
function killOrphanedFfmpeg(): void {
    for (const pid of findPidsByExecutable(FFMPEG_CMD, (args) => {
        const progressIdx = args.indexOf('-progress');
        const timeoutIdx = args.indexOf('-rw_timeout');
        return (
            progressIdx >= 0 &&
            args[progressIdx + 1] === 'pipe:1' &&
            timeoutIdx >= 0 &&
            args[timeoutIdx + 1] === String(INPUT_TIMEOUT_US)
        );
    })) {
        console.warn(
            yellow(`[outputs] killing orphaned ffmpeg pid=${pid} left by a previous instance`),
        );
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            /* already gone */
        }
    }
}

export function createOutputService(
    db: Db,
    inputState: InputState,
    diagnostics?: DiagnosticsLogger,
): OutputService {
    const processes = new Map<string, ChildProcess>();
    const statuses = new Map<
        string,
        { status: 'running' | 'stopped' | 'failed'; pid: number | null }
    >();
    const startTimes = new Map<string, number>();
    const progress = new Map<string, OutputProgress>();
    const socketWarnings = new Map<string, SocketWarning>();
    const memoryWarnings = new Map<string, string>();
    const memoryUsage = new Map<string, { rssBytes: number; limitBytes: number }>();
    const cpuUsage = new Map<string, number>();
    const cpuTracker = createProcCpuTracker();
    let tcpSocketsByPid = new Map<number, TcpSocket[]>();
    let tcpSocketSnapshotUsable = false;
    let socketSnapshotInProgress = false;
    const stopRequested = new Set<string>();
    const burstHistoryAtMs = new Map<string, number>();
    // Open episodes of the card-only warnings (see warningStarted).
    const warningEpisodes = new Map<string, { startedAtMs: number; message: string }>();
    const watchdogKills = new Set<string>();
    // Why a watchdog killed a process; explains the failure to a rendition's
    // dependents and goes on the ffmpeg-exited event.
    const watchdogReasons = new Map<string, string>();
    // Shared outputs: the rendition each running one pulls from.
    const renditionOf = new Map<string, string>();
    // Text for the 'stopped' record of a user-requested restart.
    const restartNotes = new Map<string, string>();
    const startLocks = new Set<string>();
    let shuttingDown = false;
    const retryState = new Map<
        string,
        {
            failures: number;
            // Failed attempts in a row that never stayed up for STABLE_RUN_MS, and
            // how the latest one failed.
            quickFailures: number;
            lastFailure: string | null;
            timer: NodeJS.Timeout | null;
        }
    >();
    // For the 'stopped' record of a stop that followed repeated failures.
    const stopFailures = new Map<string, { attempts: number; lastFailure: string | null }>();
    const watchdogTimer = setInterval(checkOutputWatchdog, OUTPUT_WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref?.();
    refreshTcpSocketSnapshot();
    killOrphanedFfmpeg();

    function getStats(outputId: string): OutputStats {
        const s = statuses.get(outputId) ?? { status: 'stopped' as const, pid: null };
        const row = db.getOutput(outputId);
        const role = row && isRenditionOutput(row) ? 'rendition' : 'output';
        const usage = memoryUsage.get(outputId);
        const p = progress.get(outputId);
        const timingWarning = p ? timingWarningFor(p, Date.now()) : null;
        return {
            ...s,
            bitrateKbps: p?.lastBitrateKbps ?? null,
            startedAtMs: startTimes.get(outputId) ?? null,
            failures: retryState.get(outputId)?.failures ?? 0,
            warningReason:
                socketWarnings.get(outputId)?.reason ??
                memoryWarnings.get(outputId) ??
                timingWarning,
            memoryUsageBytes: usage?.rssBytes ?? null,
            memoryLimitBytes: usage?.limitBytes ?? null,
            cpuPercent: cpuUsage.get(outputId) ?? null,
            lastOutTimeUs: p?.lastOutTimeMs ?? null,
            lastTotalSizeBytes: p?.lastTotalSize ?? null,
            progressAgeMs: p ? Date.now() - p.lastProgressAtMs : null,
            outputProgressAgeMs: p ? Date.now() - p.lastOutputProgressAtMs : null,
            role,
            renditionId: renditionOf.get(outputId) ?? null,
            ready: role === 'rendition' ? isRenditionReady(outputId) : null,
        };
    }

    // A rendition is ready once its process runs and has written data, which means
    // SRS accepted its publish. Local on purpose: no waiting for the health poll.
    function isRenditionReady(renditionId: string): boolean {
        return processes.has(renditionId) && (progress.get(renditionId)?.lastTotalSize ?? 0) > 0;
    }

    // Whether this output goes through a shared encode, and which rendition row
    // that is. Decided from the saved configuration each time an output starts: it
    // shares when at least two outputs of its pipeline are configured with its
    // recipe (see sharedRecipe). A running output never switches mid-run; it joins
    // or leaves an encode the next time it starts. `rendition` is null while the
    // reconciler has not created the row yet.
    function resolveShared(output: Output): { rendition: Output | null } | null {
        // Plain outputs (the vast majority) skip the database read.
        if (!encodeRecipe(output)) return null;
        const outputs = db.listOutputsForPipeline(output.pipelineId);
        const recipe = sharedRecipe(output, outputs);
        if (!recipe) return null;
        const url = renditionUrl(output.pipelineId, recipe);
        return { rendition: outputs.find((o) => o.url === url) ?? null };
    }

    // Whether the output's source can be pulled now, and how long to wait before
    // asking again if not: the input for a direct output, the rendition (and the
    // input behind it) for a shared one. Shared outputs also need the input: while
    // it is down the rendition process may still be up but has nothing to give.
    function sourceGate(output: Output): { ready: boolean; recheckMs: number } {
        const shared = resolveShared(output);
        const recheckMs = shared ? RENDITION_RECHECK_DELAY_MS : RECHECK_DELAY_MS;
        if (!inputState.isReady(output.pipelineId)) return { ready: false, recheckMs };
        if (!shared) return { ready: true, recheckMs };
        const ready = shared.rendition !== null && isRenditionReady(shared.rendition.id);
        return { ready, recheckMs };
    }

    function readersOf(renditionId: string): number {
        let n = 0;
        for (const id of renditionOf.values()) if (id === renditionId) n++;
        return n;
    }

    function roleFields(output: Output): { role: string; renditionId?: string } {
        const renditionId = renditionOf.get(output.id);
        return {
            role: isRenditionOutput(output) ? 'rendition' : 'output',
            ...(renditionId ? { renditionId } : {}),
        };
    }

    function noteWatchdogKill(outputId: string, reason: string): void {
        watchdogKills.add(outputId);
        watchdogReasons.set(outputId, reason);
    }

    function setStatus(
        outputId: string,
        status: 'running' | 'stopped' | 'failed',
        pid: number | null,
    ): void {
        statuses.set(outputId, { status, pid });
        if (status === 'running') {
            startTimes.set(outputId, Date.now());
        } else {
            startTimes.delete(outputId);
            renditionOf.delete(outputId);
            endWarningEpisodes(outputId, 'ended with ffmpeg exit');
            progress.delete(outputId);
            socketWarnings.delete(outputId);
            memoryWarnings.delete(outputId);
            memoryUsage.delete(outputId);
            cpuUsage.delete(outputId);
            cpuTracker.delete(outputId);
        }
    }

    function reportExternalProgress(
        outputId: string,
        update: {
            bitrateKbps: number | null;
            lastOutTimeUs: number | null;
            lastTotalSizeBytes: number | null;
        },
    ): void {
        const existing = progress.get(outputId);
        const now = Date.now();
        progress.set(outputId, {
            lastProgressAtMs: now,
            lastOutputProgressAtMs: now,
            lastOutTimeMs: update.lastOutTimeUs,
            lastOutTimeWallMs: existing?.lastOutTimeWallMs ?? null,
            lastTotalSize: update.lastTotalSizeBytes,
            lastBitrateKbps: update.bitrateKbps,
            stderrTail: existing?.stderrTail ?? '',
            monitorMediaClock: false,
            fastMediaSinceMs: null,
            mediaClockWarning: null,
            lastTimestampWarningAtMs: existing?.lastTimestampWarningAtMs ?? null,
            lastTimestampWarning: existing?.lastTimestampWarning ?? null,
            timestampBurst: existing?.timestampBurst ?? null,
        });
    }

    function reportExternalUsage(
        outputId: string,
        usage: { rssBytes: number | null; limitBytes: number; cpuPercent: number | null },
    ): void {
        // A sample that raced with the process exiting must not resurrect the
        // usage entries setStatus() just cleared.
        if (statuses.get(outputId)?.status !== 'running') return;
        if (usage.rssBytes != null) {
            memoryUsage.set(outputId, { rssBytes: usage.rssBytes, limitBytes: usage.limitBytes });
        } else {
            memoryUsage.delete(outputId);
        }
        updateMemoryWarning(outputId, usage.rssBytes, usage.limitBytes);
        if (usage.cpuPercent != null) cpuUsage.set(outputId, usage.cpuPercent);
        else cpuUsage.delete(outputId);
    }

    function getRetry(outputId: string) {
        if (!retryState.has(outputId)) {
            retryState.set(outputId, {
                failures: 0,
                quickFailures: 0,
                lastFailure: null,
                timer: null,
            });
        }
        return retryState.get(outputId)!;
    }

    function clearRetry(outputId: string): void {
        const r = retryState.get(outputId);
        if (r?.timer) {
            clearTimeout(r.timer);
            r.timer = null;
        }
        retryState.delete(outputId);
    }

    // stop() calls this first: it forgets the retry state, but a stop that follows
    // a streak of failed attempts must leave a record saying so. An attempt that
    // has already stayed up for STABLE_RUN_MS ended the streak, even though only
    // its exit would reset the counter.
    function noteStopStreak(outputId: string): void {
        const r = retryState.get(outputId);
        const startedAtMs = startTimes.get(outputId);
        const recovered = startedAtMs !== undefined && Date.now() - startedAtMs >= STABLE_RUN_MS;
        if (r && !recovered && r.quickFailures >= STOPPED_AFTER_FAILURES) {
            stopFailures.set(outputId, { attempts: r.quickFailures, lastFailure: r.lastFailure });
        }
    }

    // Writes the 'stopped' record of a stop. After a streak of failed attempts it
    // carries the count and the last failure, which keeps the stop visible as an
    // error until the output is started again.
    function recordStop(
        output: { id: string; name: string },
        streak: { attempts: number; lastFailure: string | null } | null,
        detail: string,
    ): void {
        if (!streak) {
            db.setOutputLastError(output.id, detail, 'stopped');
            return;
        }
        const message = `Stopped after ${streak.attempts} failed attempts${
            streak.lastFailure ? `. Last error: ${streak.lastFailure}` : ''
        }`;
        console.warn(red(`[outputs] ${output.id} (${output.name}) ${message}`));
        diagnostics?.event('output-stopped-after-failures', {
            outputId: output.id,
            outputName: output.name,
            failedAttempts: streak.attempts,
            threshold: STOPPED_AFTER_FAILURES,
            lastFailure: streak.lastFailure,
        });
        db.setOutputLastError(output.id, message, 'stopped', streak.attempts);
    }

    function scheduleRetry(output: Output): void {
        const r = getRetry(output.id);
        const delayMs = RETRY_DELAYS_MS[Math.min(r.failures - 1, RETRY_DELAYS_MS.length - 1)];
        console.warn(
            yellow(
                `[outputs] ${output.id} (${output.name}) retry ${r.failures} scheduled in ${delayMs}ms`,
            ),
        );
        diagnostics?.event('ffmpeg-retry-scheduled', {
            outputId: output.id,
            outputName: output.name,
            attempt: r.failures,
            delayMs,
        });
        scheduleTryStart(output.id, delayMs);
    }

    // Schedule a tryStart without counting a failure — used when the input/SRS is
    // not yet ready, so we keep checking cheaply until it is.
    function scheduleRecheck(output: Output, delayMs: number): void {
        scheduleTryStart(output.id, delayMs);
    }

    function scheduleTryStart(outputId: string, delayMs: number): void {
        const r = getRetry(outputId);
        if (r.timer) clearTimeout(r.timer);
        r.timer = setTimeout(() => {
            r.timer = null;
            void tryStart(outputId);
        }, delayMs);
        r.timer.unref?.();
    }

    async function tryStart(outputId: string): Promise<void> {
        if (startLocks.has(outputId)) return;
        startLocks.add(outputId);
        try {
            const output = db.getOutput(outputId);
            if (!output || output.desiredState !== 'running') return;
            // Translation outputs are published by the translation mixer, not by this
            // service — see the same check in start(). Without it, a retry/reconnect
            // (e.g. restartPipelineOutputs() after the source comes back online) would
            // spawn a second ffmpeg pushing to the same destination as the mixer.
            if (output.audioEncoding === 'translation') return;
            if (statuses.get(outputId)?.status === 'running') return;
            // Don't spawn a doomed ffmpeg against a dead input; re-check until ready.
            const gate = sourceGate(output);
            if (!gate.ready) {
                scheduleRecheck(output, gate.recheckMs);
                return;
            }
            await startJob(output);
        } catch (err) {
            console.warn(red(`[outputs] ${outputId} auto-start failed:`), err);
        } finally {
            startLocks.delete(outputId);
        }
    }

    function parseBitrateKbps(line: string): number | null {
        const val = line.slice('bitrate='.length).trim();
        if (val === 'N/A' || val === '0.0kbits/s') return null;
        const match = val.match(/^([\d.]+)kbits\/s$/);
        return match ? parseFloat(match[1]) : null;
    }

    function parseProgressNumber(line: string, prefix: string): number | null {
        if (!line.startsWith(prefix)) return null;
        const val = Number(line.slice(prefix.length).trim());
        return Number.isFinite(val) ? val : null;
    }

    function noteOutputProgress(outputId: string, line: string): void {
        const p = progress.get(outputId);
        if (!p) return;
        p.lastProgressAtMs = Date.now();

        const totalSize = parseProgressNumber(line, 'total_size=');
        if (totalSize != null && (p.lastTotalSize == null || totalSize > p.lastTotalSize)) {
            p.lastTotalSize = totalSize;
            p.lastOutputProgressAtMs = p.lastProgressAtMs;
            return;
        }

        // ffmpeg quirk: the '-progress' key is named out_time_ms but its value
        // is MICROSECONDS (same as out_time_us; kept for compatibility). The
        // watchdog only compares it monotonically so the unit doesn't affect
        // behavior, but error messages must label it as µs.
        const outTimeMs = parseProgressNumber(line, 'out_time_ms=');
        if (outTimeMs != null && (p.lastOutTimeMs == null || outTimeMs > p.lastOutTimeMs)) {
            const now = p.lastProgressAtMs;
            if (p.monitorMediaClock && p.lastOutTimeMs != null) {
                const wallDeltaMs = now - (p.lastOutTimeWallMs ?? now);
                const mediaDeltaMs = (outTimeMs - p.lastOutTimeMs) / 1000;
                if (wallDeltaMs >= 500 && mediaDeltaMs >= 0) {
                    const speed = mediaDeltaMs / wallDeltaMs;
                    if (speed > 1.1) {
                        p.fastMediaSinceMs ??= now;
                        if (now - p.fastMediaSinceMs >= 10_000) {
                            const warning = `FFmpeg media clock is running fast (${speed.toFixed(2)}x realtime).`;
                            warningStarted(outputId, 'media-clock', warning);
                            p.mediaClockWarning = warning;
                        }
                    } else {
                        p.fastMediaSinceMs = null;
                        warningEnded(outputId, 'media-clock', 'cleared');
                        p.mediaClockWarning = null;
                    }
                }
            }
            p.lastOutTimeMs = outTimeMs;
            p.lastOutTimeWallMs = now;
            p.lastOutputProgressAtMs = p.lastProgressAtMs;
            return;
        }

        if (line.startsWith('bitrate=')) {
            p.lastBitrateKbps = parseBitrateKbps(line);
        }
    }

    function timingWarningFor(p: OutputProgress, now: number): string | null {
        if (p.mediaClockWarning) return p.mediaClockWarning;
        const burst = p.timestampBurst;
        if (
            p.lastTimestampWarning &&
            p.lastTimestampWarningAtMs !== null &&
            now - p.lastTimestampWarningAtMs <= TIMESTAMP_QUIET_MS &&
            burst &&
            (burst.timing || burst.lastAtMs - burst.startedAtMs >= DECODE_WARNING_GRACE_MS)
        ) {
            return p.lastTimestampWarning;
        }
        if (p.monitorMediaClock && now - p.lastOutputProgressAtMs >= 15_000) {
            return `FFmpeg media progress has stalled for ${Math.round((now - p.lastOutputProgressAtMs) / 1000)}s.`;
        }
        return null;
    }

    function flushTimestampSummary(outputId: string, burst: TimestampBurst, now: number): void {
        if (burst.pendingCount === 0) return;
        diagnostics?.event('ffmpeg-timestamp-warning-summary', {
            outputId,
            windowMs: now - burst.lastSummaryAtMs,
            count: burst.pendingCount,
            kinds: Object.fromEntries(burst.pendingKinds),
            totalCount: burst.count,
            lastLine: burst.lastLine,
        });
        burst.pendingCount = 0;
        burst.pendingKinds.clear();
        burst.lastSummaryAtMs = now;
    }

    // True (and records the claim) if this output's burst class has not been
    // written to its Error History within the interval.
    function claimBurstHistory(outputId: string, cls: string, now: number): boolean {
        const key = `${outputId}:${cls}`;
        const last = burstHistoryAtMs.get(key);
        if (last !== undefined && now - last < BURST_HISTORY_INTERVAL_MS) return false;
        burstHistoryAtMs.set(key, now);
        return true;
    }

    // Writes one 'warning' record to the output's Error History, at most once
    // per interval per output and class (see BURST_HISTORY_INTERVAL_MS).
    function recordWarningHistory(
        outputId: string,
        cls: string,
        startedAtMs: number,
        text: string,
    ) {
        if (!claimBurstHistory(outputId, cls, startedAtMs)) return;
        try {
            db.setOutputLastError(outputId, text, 'warning');
        } catch (err) {
            console.warn(
                red(`[outputs] ${outputId} failed to record warning history:`),
                err instanceof Error ? err.message : err,
            );
        }
    }

    // Warnings that otherwise only show on the output card (high memory,
    // unhealthy destination socket, media clock running fast) are tracked as
    // episodes: one diagnostics event when one starts, and one event plus one
    // Error History record when it ends (it clears, or the process exits).
    function warningStarted(outputId: string, kind: WarningKind, message: string): void {
        const key = `${outputId}:${kind}`;
        if (warningEpisodes.has(key)) return;
        warningEpisodes.set(key, { startedAtMs: Date.now(), message });
        diagnostics?.event('ffmpeg-warning-started', { outputId, kind, message });
    }

    function warningEnded(outputId: string, kind: WarningKind, reason: string): void {
        const key = `${outputId}:${kind}`;
        const episode = warningEpisodes.get(key);
        if (!episode) return;
        warningEpisodes.delete(key);
        const durationMs = Date.now() - episode.startedAtMs;
        diagnostics?.event('ffmpeg-warning-ended', {
            outputId,
            kind,
            durationMs,
            reason,
            message: episode.message,
        });
        recordWarningHistory(
            outputId,
            kind,
            episode.startedAtMs,
            `${episode.message} (lasted ${formatDuration(durationMs)}${reason === 'cleared' ? '' : `, ${reason}`})`,
        );
    }

    function endWarningEpisodes(outputId: string, reason: string): void {
        for (const kind of WARNING_KINDS) warningEnded(outputId, kind, reason);
    }

    function updateMemoryWarning(outputId: string, rssBytes: number | null, limitBytes: number) {
        if (rssBytes != null && rssBytes >= limitBytes * MEMORY_WARNING_RATIO) {
            const message = `High memory usage: ${Math.round(rssBytes / (1024 * 1024))}MB / ${Math.round(
                limitBytes / (1024 * 1024),
            )}MB limit (${Math.round((rssBytes / limitBytes) * 100)}%)`;
            memoryWarnings.set(outputId, message);
            warningStarted(outputId, 'memory', message);
        } else {
            memoryWarnings.delete(outputId);
            warningEnded(outputId, 'memory', 'cleared');
        }
    }

    function recordBurstEnd(outputId: string, burst: TimestampBurst, reason: string): void {
        const durationMs = burst.lastAtMs - burst.startedAtMs;
        // Join noise (a short decode-only burst) is routine, not history.
        if (!burst.timing && durationMs < DECODE_WARNING_GRACE_MS) return;
        const kind = burst.timing ? 'timestamp' : 'decode';
        recordWarningHistory(
            outputId,
            kind,
            burst.startedAtMs,
            `FFmpeg ${kind} warnings ${reason} after ${formatDuration(durationMs)} (${burst.count} warnings). First: ${burst.firstLine}`,
        );
    }

    // Advances a burst's state: quiet period over -> recovered, pending counts
    // -> periodic summary. Called on every new warning and from the watchdog
    // tick (which is what notices the quiet).
    function evaluateTimestampBurst(outputId: string, p: OutputProgress, now: number): void {
        const burst = p.timestampBurst;
        if (!burst) return;
        if (now - burst.lastAtMs >= TIMESTAMP_QUIET_MS) {
            flushTimestampSummary(outputId, burst, burst.lastAtMs);
            const durationMs = burst.lastAtMs - burst.startedAtMs;
            diagnostics?.event('ffmpeg-timestamp-recovered', {
                outputId,
                durationMs,
                count: burst.count,
                quietMs: TIMESTAMP_QUIET_MS,
            });
            recordBurstEnd(outputId, burst, 'stopped');
            console.log(
                green(
                    `[outputs] ${outputId} ffmpeg timestamp warnings stopped after ${formatDuration(durationMs)} (${burst.count} warnings)`,
                ),
            );
            p.timestampBurst = null;
            return;
        }
        if (now - burst.lastSummaryAtMs >= TIMESTAMP_SUMMARY_MS) {
            flushTimestampSummary(outputId, burst, now);
        }
    }

    function noteTimestampWarning(outputId: string, stderr: string): void {
        const p = progress.get(outputId);
        if (!p) return;
        const now = Date.now();
        // Close a burst whose quiet period already elapsed (the watchdog tick
        // may not have run yet) so these lines start a new one.
        if (p.timestampBurst && now - p.timestampBurst.lastAtMs >= TIMESTAMP_QUIET_MS) {
            evaluateTimestampBurst(outputId, p, now);
        }
        for (const raw of stderr.split(/\r?\n/)) {
            const line = raw.trim();
            const match = TIMESTAMP_WARNING_PATTERNS.find(({ pattern }) => pattern.test(line));
            if (!match) continue;
            p.lastTimestampWarningAtMs = now;
            p.lastTimestampWarning = `FFmpeg reported: ${line}`;
            const burst = (p.timestampBurst ??= {
                startedAtMs: now,
                lastAtMs: now,
                count: 0,
                timing: false,
                firstLine: line,
                lastLine: line,
                knownKinds: new Set<string>(),
                lastSummaryAtMs: now,
                pendingCount: 0,
                pendingKinds: new Map<string, number>(),
            });
            burst.count++;
            burst.lastAtMs = now;
            burst.lastLine = line;
            burst.timing ||= match.timing;
            const kind = timestampWarningKind(line);
            if (!burst.knownKinds.has(kind) && burst.knownKinds.size < TIMESTAMP_MAX_KINDS) {
                burst.knownKinds.add(kind);
                diagnostics?.event('ffmpeg-timestamp-warning', { outputId, line });
            } else {
                const key = burst.knownKinds.has(kind) ? kind : 'other';
                burst.pendingCount++;
                burst.pendingKinds.set(key, (burst.pendingKinds.get(key) ?? 0) + 1);
            }
        }
        evaluateTimestampBurst(outputId, p, now);
    }

    function formatNullable(value: number | null): string {
        return value == null ? 'unknown' : String(value);
    }

    function buildWatchdogError(outputId: string, proc: ChildProcess, now: number): string {
        const p = progress.get(outputId);
        const stalledForSec = p
            ? Math.round((now - p.lastOutputProgressAtMs) / 1000)
            : Math.round(OUTPUT_WATCHDOG_STALL_MS / 1000);
        const progressAgeSec = p ? Math.round((now - p.lastProgressAtMs) / 1000) : null;
        const stderr = p?.stderrTail.trim();

        return [
            'watchdog: ffmpeg output stalled; restarting process',
            `pid=${proc.pid ?? 'unknown'}`,
            `no_output_progress_for=${stalledForSec}s`,
            `last_progress_line_age=${progressAgeSec == null ? 'unknown' : `${progressAgeSec}s`}`,
            `last_total_size=${formatNullable(p?.lastTotalSize ?? null)}`,
            `last_out_time_us=${formatNullable(p?.lastOutTimeMs ?? null)}`,
            `last_bitrate_kbps=${formatNullable(p?.lastBitrateKbps ?? null)}`,
            stderr ? `ffmpeg stderr tail:\n${stderr}` : 'ffmpeg stderr tail: <empty>',
            `Restarting output: no ffmpeg output progress for ${stalledForSec}s`,
        ].join('\n');
    }

    function buildSocketWatchdogError(
        outputId: string,
        proc: ChildProcess,
        reason: string,
    ): string {
        const p = progress.get(outputId);
        const sockets = proc.pid == null ? [] : (tcpSocketsByPid.get(proc.pid) ?? []);
        const socketSnapshot =
            sockets.length === 0
                ? 'socket_snapshot: <no sockets for pid>'
                : `socket_snapshot:\n${sockets
                      .map((s) => `  ${s.state} peer=${s.peerAddress}:${s.peerPort}`)
                      .join('\n')}`;
        return [
            'watchdog: ffmpeg destination socket unhealthy; restarting process',
            `pid=${proc.pid ?? 'unknown'}`,
            `socket_warning=${reason}`,
            socketSnapshot,
            `last_total_size=${formatNullable(p?.lastTotalSize ?? null)}`,
            `last_out_time_us=${formatNullable(p?.lastOutTimeMs ?? null)}`,
            `last_bitrate_kbps=${formatNullable(p?.lastBitrateKbps ?? null)}`,
            p?.stderrTail.trim()
                ? `ffmpeg stderr tail:\n${p.stderrTail.trim()}`
                : 'ffmpeg stderr tail: <empty>',
            `Restarting output: ${reason}`,
        ].join('\n');
    }

    function buildMemoryWatchdogError(
        outputId: string,
        proc: ChildProcess,
        rssBytes: number,
        limitBytes: number,
        now: number,
    ): string {
        const p = progress.get(outputId);
        const startedAtMs = startTimes.get(outputId);
        const uptimeSec = startedAtMs ? Math.round((now - startedAtMs) / 1000) : null;
        return [
            'watchdog: ffmpeg RSS exceeded memory limit; restarting process',
            `pid=${proc.pid ?? 'unknown'}`,
            `rss_mb=${Math.round(rssBytes / (1024 * 1024))}`,
            `limit_mb=${Math.round(limitBytes / (1024 * 1024))}`,
            `uptime_s=${uptimeSec == null ? 'unknown' : uptimeSec}`,
            p?.stderrTail.trim()
                ? `ffmpeg stderr tail:\n${p.stderrTail.trim()}`
                : 'ffmpeg stderr tail: <empty>',
            `Restarting output: RSS ${Math.round(rssBytes / (1024 * 1024))}MB exceeded ${Math.round(
                limitBytes / (1024 * 1024),
            )}MB limit`,
        ].join('\n');
    }

    function refreshTcpSocketSnapshot(): void {
        if (socketSnapshotInProgress) return;
        if (![...processes.values()].some((proc) => proc.pid != null)) return;
        socketSnapshotInProgress = true;
        execFile(
            'ss',
            ['-H', '-tanp'],
            { timeout: SOCKET_SNAPSHOT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
            (err, stdout) => {
                socketSnapshotInProgress = false;
                if (err) {
                    tcpSocketsByPid = new Map();
                    tcpSocketSnapshotUsable = false;
                    return;
                }
                tcpSocketsByPid = parseTcpSocketSnapshot(stdout);
                tcpSocketSnapshotUsable = true;
            },
        );
    }

    function recordSocketWarning(outputId: string, reason: string, now: number): SocketWarning {
        const existing = socketWarnings.get(outputId);
        if (existing?.reason === reason) return existing;
        const next = { reason, badSinceMs: existing?.badSinceMs ?? now };
        socketWarnings.set(outputId, next);
        warningStarted(outputId, 'socket', `Destination socket unhealthy: ${reason}`);
        return next;
    }

    function maybeKillForSocketWarning(
        output: Output,
        proc: ChildProcess,
        reason: string,
        now: number,
    ): boolean {
        const outputId = output.id;
        const warning = recordSocketWarning(outputId, reason, now);
        if (now - warning.badSinceMs <= OUTPUT_SOCKET_GRACE_MS) return false;

        try {
            db.setOutputLastError(
                outputId,
                buildSocketWatchdogError(outputId, proc, reason),
                'crash',
            );
        } catch {
            /* non-critical; still restart the stuck process */
        }
        console.warn(
            yellow(
                `[outputs] ${outputId} (${output.name}) socket unhealthy: ${reason}, killing pid=${proc.pid}`,
            ),
        );
        diagnostics?.event('ffmpeg-restart', {
            outputId,
            outputName: output.name,
            ...roleFields(output),
            reason: `socket unhealthy: ${reason}`,
            pid: proc.pid ?? null,
        });
        noteWatchdogKill(outputId, `socket unhealthy: ${reason}`);
        void killProcess(outputId, proc, false);
        return true;
    }

    function checkOutputWatchdog(): void {
        const now = Date.now();
        refreshTcpSocketSnapshot();
        for (const [outputId, p] of progress) evaluateTimestampBurst(outputId, p, now);
        for (const [outputId, proc] of processes) {
            if (watchdogKills.has(outputId)) continue;
            const output = db.getOutput(outputId);
            if (!output || output.desiredState !== 'running') continue;

            const startedAtMs = startTimes.get(outputId);
            const p = progress.get(outputId);
            if (!startedAtMs || !p) continue;
            if (!inputState.isReady(output.pipelineId)) continue;
            // A shared output reads the rendition, not the input: while the
            // rendition is not ready (restarting, or about to be restarted by its
            // own watchdog) a lack of data is not this output's fault.
            const renditionId = renditionOf.get(outputId);
            if (renditionId !== undefined && !isRenditionReady(renditionId)) continue;

            const rssBytes = proc.pid == null ? null : readProcRssBytes(proc.pid);
            // A shared output only copies, whatever preset its recipe names.
            const limitBytes = memoryLimitBytesFor(
                renditionId !== undefined ? 'copy' : output.videoEncoding,
                inputState.isHighRes(output.pipelineId),
            );
            if (rssBytes != null) {
                memoryUsage.set(outputId, { rssBytes, limitBytes });
            } else {
                memoryUsage.delete(outputId);
            }

            const cpuPercent = proc.pid == null ? null : cpuTracker.sample(outputId, proc.pid);
            if (cpuPercent != null) {
                cpuUsage.set(outputId, cpuPercent);
            } else {
                cpuUsage.delete(outputId);
            }

            if (now - startedAtMs >= OUTPUT_SOCKET_WARMUP_MS) {
                const socketWarning = destinationSocketWarning(
                    output,
                    proc.pid ?? null,
                    tcpSocketsByPid,
                    tcpSocketSnapshotUsable,
                );
                if (socketWarning) {
                    if (maybeKillForSocketWarning(output, proc, socketWarning, now)) continue;
                } else {
                    socketWarnings.delete(outputId);
                    warningEnded(outputId, 'socket', 'cleared');
                }
            }

            if (now - startedAtMs >= OUTPUT_WATCHDOG_WARMUP_MS) {
                if (rssBytes != null && rssBytes >= limitBytes) {
                    try {
                        db.setOutputLastError(
                            outputId,
                            buildMemoryWatchdogError(outputId, proc, rssBytes, limitBytes, now),
                            'crash',
                        );
                    } catch {
                        /* non-critical; still restart the runaway process */
                    }
                    console.warn(
                        yellow(
                            `[outputs] ${outputId} (${output.name}) memory limit exceeded: rss=${Math.round(
                                rssBytes / (1024 * 1024),
                            )}MB (limit ${Math.round(
                                limitBytes / (1024 * 1024),
                            )}MB), killing pid=${proc.pid} for retry`,
                        ),
                    );
                    diagnostics?.event('ffmpeg-restart', {
                        outputId,
                        outputName: output.name,
                        ...roleFields(output),
                        reason: 'memory limit exceeded',
                        pid: proc.pid ?? null,
                        rssMb: Math.round(rssBytes / (1024 * 1024)),
                        limitMb: Math.round(limitBytes / (1024 * 1024)),
                    });
                    noteWatchdogKill(outputId, 'memory limit exceeded');
                    void killProcess(outputId, proc, false);
                    continue;
                }
                updateMemoryWarning(outputId, rssBytes, limitBytes);
            }

            if (now - startedAtMs < OUTPUT_WATCHDOG_WARMUP_MS) continue;
            if (now - p.lastOutputProgressAtMs <= OUTPUT_WATCHDOG_STALL_MS) continue;

            try {
                db.setOutputLastError(outputId, buildWatchdogError(outputId, proc, now), 'crash');
            } catch {
                /* non-critical; still restart the stuck process */
            }
            console.warn(
                yellow(
                    `[outputs] ${outputId} (${output.name}) stalled: no output progress for ${Math.round(
                        (now - p.lastOutputProgressAtMs) / 1000,
                    )}s, killing pid=${proc.pid} for retry`,
                ),
            );
            diagnostics?.event('ffmpeg-restart', {
                outputId,
                outputName: output.name,
                ...roleFields(output),
                reason: 'output progress stalled',
                pid: proc.pid ?? null,
                stalledSeconds: Math.round((now - p.lastOutputProgressAtMs) / 1000),
            });
            noteWatchdogKill(outputId, 'output progress stalled');
            void killProcess(outputId, proc, false);
        }
    }

    function killProcess(
        outputId: string,
        proc: ChildProcess,
        requestedStop = true,
    ): Promise<void> {
        if (requestedStop) stopRequested.add(outputId);
        proc.kill('SIGTERM');
        return new Promise<void>((resolve) => {
            const t = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    /* already gone */
                }
            }, SIGKILL_DELAY_MS);
            proc.once('exit', () => {
                clearTimeout(t);
                resolve();
            });
        });
    }

    // The outputs meant to be running that depend on this rendition: those reading
    // it right now (even if the configuration has changed since they started), and
    // those waiting to start that will read it. An output running direct is neither,
    // whatever its recipe: the rendition's failure does not concern it.
    function dependentsOf(rendition: Output): Output[] {
        const outputs = db.listOutputsForPipeline(rendition.pipelineId);
        return outputs.filter((o) => {
            if (isRenditionOutput(o) || o.desiredState !== 'running') return false;
            if (renditionOf.get(o.id) === rendition.id) return true;
            if (processes.has(o.id)) return false;
            const recipe = sharedRecipe(o, outputs);
            return recipe !== null && renditionUrl(o.pipelineId, recipe) === rendition.url;
        });
    }

    function failDependents(rendition: Output, reason: string): void {
        const message = `${rendition.name} failed: ${reason}`;
        const affected: string[] = [];
        const killed: string[] = [];
        for (const dep of dependentsOf(rendition)) {
            affected.push(dep.id);
            try {
                db.setOutputLastError(dep.id, message, 'crash');
            } catch {
                /* non-critical */
            }
            const proc = processes.get(dep.id);
            if (!proc || watchdogKills.has(dep.id) || stopRequested.has(dep.id)) continue;
            // Marked as a watchdog kill so its own exit writes no second crash
            // record; the normal close path then retries it, and the readiness
            // gate makes it wait for the rendition.
            noteWatchdogKill(dep.id, 'shared encode failed');
            killed.push(dep.id);
            console.warn(
                yellow(
                    `[outputs] ${dep.id} (${dep.name}) restarting: ${rendition.name} failed, killing pid=${proc.pid}`,
                ),
            );
            diagnostics?.event('ffmpeg-restart', {
                outputId: dep.id,
                outputName: dep.name,
                ...roleFields(dep),
                reason: 'shared encode failed',
                pid: proc.pid ?? null,
            });
            void killProcess(dep.id, proc, false);
        }
        if (affected.length === 0) return;
        diagnostics?.event('rendition-dependents-restarted', {
            renditionId: rendition.id,
            outputIds: affected,
            killedIds: killed,
            reason,
        });
    }

    async function startJob(output: Output): Promise<void> {
        if (!validateOutputUrl(output.url)) throw new Error('Invalid output URL');

        const pipeline = db.getPipeline(output.pipelineId);
        if (!pipeline) throw new Error('Pipeline not found');
        const sourcePipeline = pipeline;
        // A shared output (see utils/renditions.ts) copies its rendition's internal
        // stream; every other output, including the rendition itself, pulls the
        // input back the same way it was published (default RTMP until known).
        const shared = resolveShared(output);
        const rendition = shared?.rendition ?? null;
        if (shared && !rendition) throw new Error('Shared encode not found');
        const inputUrl = rendition
            ? rendition.url
            : inputState.pullUrl(sourcePipeline.id, sourcePipeline.streamKey);
        const args = rendition
            ? buildFfmpegArgs(inputUrl, output.url, 'copy', 'copy')
            : buildFfmpegArgs(
                  inputUrl,
                  output.url,
                  output.audioEncoding === 'translation' ? 'copy' : output.audioEncoding,
                  output.videoEncoding,
              );

        // stdout and stderr must stay as 'pipe' (not 'ignore' or 'inherit').
        // When Node.js exits for any reason — including SIGKILL or a crash — the OS
        // closes the read ends of these pipes. ffmpeg writes to stdout every ~1s via
        // '-progress pipe:1', so it receives SIGPIPE within a second and exits.
        // Using 'ignore' (i.e. /dev/null) would break this coupling and leave
        // orphaned ffmpeg processes running after the parent dies.
        const child: ChildProcess = spawn(FFMPEG_CMD, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });

        processes.set(output.id, child);
        setStatus(output.id, 'running', child.pid ?? null);
        if (rendition) renditionOf.set(output.id, rendition.id);
        progress.set(output.id, {
            lastProgressAtMs: Date.now(),
            lastOutputProgressAtMs: Date.now(),
            lastOutTimeMs: null,
            lastTotalSize: null,
            lastBitrateKbps: null,
            stderrTail: '',
            monitorMediaClock:
                inputUrl.startsWith('srt://') &&
                (output.url.startsWith('rtmp://') || output.url.startsWith('rtmps://')),
            fastMediaSinceMs: null,
            mediaClockWarning: null,
            lastTimestampWarningAtMs: null,
            lastTimestampWarning: null,
            timestampBurst: null,
            lastOutTimeWallMs: null,
        });
        console.log(green(`[outputs] ${output.id} (${output.name}) started pid=${child.pid}`));
        diagnostics?.event('ffmpeg-started', {
            outputId: output.id,
            outputName: output.name,
            pid: child.pid ?? null,
            ...roleFields(output),
            inputProtocol: inputUrl.split(':', 1)[0],
            outputProtocol: output.url.split(':', 1)[0],
        });

        let buf = '';
        child.stdout?.on('data', (d: Buffer) => {
            buf += d.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                noteOutputProgress(output.id, line);
            }
        });

        let stderrTail = '';
        child.stderr?.on('data', (d: Buffer) => {
            const text = d.toString();
            stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
            const p = progress.get(output.id);
            if (p) {
                p.stderrTail = stderrTail;
                noteTimestampWarning(output.id, text);
            }
        });

        child.on('error', (err) => {
            console.warn(red(`[outputs] ${output.id} error:`), err.message);
        });

        child.on('close', (code, signal) => {
            const wasStop = stopRequested.delete(output.id);
            const wasWatchdog = watchdogKills.delete(output.id);
            const watchdogReason = watchdogReasons.get(output.id) ?? null;
            watchdogReasons.delete(output.id);
            const restartNote = restartNotes.get(output.id) ?? null;
            restartNotes.delete(output.id);
            const stopStreak = stopFailures.get(output.id) ?? null;
            stopFailures.delete(output.id);
            const startedAtMs = startTimes.get(output.id);
            const ranMs = startedAtMs === undefined ? 0 : Date.now() - startedAtMs;
            // setStatus() below forgets which rendition this output was pulling.
            const roles = roleFields(output);
            const status = wasStop ? 'stopped' : 'failed';
            // setStatus() below drops the progress entry, so capture any open
            // timestamp-warning burst now to record it on the exit event.
            const openBurst = progress.get(output.id)?.timestampBurst ?? null;
            if (openBurst) recordBurstEnd(output.id, openBurst, 'ended with ffmpeg exit');
            processes.delete(output.id);
            setStatus(output.id, status, null);
            const exitColor = status === 'failed' ? red : green;
            console.log(
                exitColor(
                    `[outputs] ${output.id} (${output.name}) exited code=${code} signal=${signal} status=${status}`,
                ),
            );
            diagnostics?.event('ffmpeg-exited', {
                outputId: output.id,
                outputName: output.name,
                pid: child.pid ?? null,
                code,
                signal,
                status,
                ...roles,
                watchdog: wasWatchdog,
                reason: watchdogReason,
                stderrTail: stderrTail.trim() || null,
                ...(openBurst
                    ? {
                          timestampBurst: {
                              durationMs: openBurst.lastAtMs - openBurst.startedAtMs,
                              count: openBurst.count,
                          },
                      }
                    : {}),
            });

            if (!wasStop) {
                try {
                    if (!wasWatchdog) {
                        const detail = stderrTail.trim();
                        const exitStr = `exit=${code ?? signal}`;
                        db.setOutputLastError(
                            output.id,
                            detail ? `${exitStr}\n${detail}` : exitStr,
                            'crash',
                        );
                    }
                } catch {
                    /* non-critical */
                }
            } else if (!shuttingDown) {
                // Deliberate stop, not a failure. Always record a 'stopped'
                // marker — even with empty stderr — so it becomes the newest
                // history entry and immediately supersedes any earlier crash
                // (db.rowToOutput only surfaces lastError when the *latest*
                // entry is a crash). When ffmpeg did print something, it's
                // also worth keeping as a diagnostic breadcrumb (e.g. a run
                // that never crashed but also never made progress, and got
                // stopped by hand before any watchdog would have caught it).
                // Skip during app shutdown, which stops every running output
                // at once and would otherwise flood each one's history with
                // routine stop markers on every restart/deploy.
                try {
                    const detail = stderrTail.trim();
                    recordStop(
                        output,
                        stopStreak,
                        restartNote ? (detail ? `${restartNote}\n${detail}` : restartNote) : detail,
                    );
                } catch {
                    /* non-critical */
                }
            }

            // A rendition that dies on its own takes its readers' input with it:
            // restart them (they wait for it to be ready again) and leave each a
            // record saying why, so their cards do not just show a reconnect.
            if (!wasStop && !shuttingDown && isRenditionOutput(output)) {
                const detail = stderrTail.trim();
                const what = wasWatchdog
                    ? `watchdog: ${watchdogReason ?? 'restarted'}`
                    : `exit=${code ?? signal}`;
                failDependents(output, detail ? `${what}\n${detail}` : what);
            }

            if (shuttingDown) return;
            const desiredRunning = db.getOutput(output.id)?.desiredState === 'running';
            if (!wasStop && desiredRunning) {
                const r = getRetry(output.id);
                r.failures++;
                r.quickFailures = ranMs >= STABLE_RUN_MS ? 0 : r.quickFailures + 1;
                r.lastFailure = failureSummary(
                    wasWatchdog,
                    watchdogReason,
                    stderrTail,
                    code ?? signal,
                );
                scheduleRetry(output);
            } else if (wasStop && desiredRunning) {
                // A start arrived while this stop's kill was still in flight:
                // start() saw status 'running' and bailed, and a requested stop
                // schedules no retry — so without this, nothing would ever
                // respawn the process and the output would sit at
                // desired-running/actual-stopped until the next input
                // offline→online edge. Restart promptly; not a failure.
                scheduleTryStart(output.id, 0);
            }
        });
    }

    return {
        getStats,

        reportExternalStatus: setStatus,
        reportExternalProgress,
        reportExternalUsage,

        // Double-start safety here relies on startJob() being synchronous up to and
        // including spawn()+setStatus('running'): there is no await before the process
        // is registered, so a second concurrent start() always observes status
        // 'running' below and bails. If an await is ever introduced before spawn in
        // startJob, this check is no longer sufficient — add an explicit start lock
        // (as tryStart uses) to prevent racing spawns.
        async start(outputId: string): Promise<void> {
            if (startLocks.has(outputId)) return;
            if (statuses.get(outputId)?.status === 'running') return;
            const output = db.getOutput(outputId);
            if (!output) throw new Error('Output not found');
            if (!validateOutputUrl(output.url)) throw new Error('Invalid output URL');
            // Translation outputs are published by the translation mixer
            // directly to this output URL; they do not need a second pull.
            if (output.audioEncoding === 'translation') return;
            clearRetry(outputId);
            getRetry(outputId).failures = 0;
            // Input not live yet — keep the output "running" (desiredState) but
            // don't spawn a doomed ffmpeg. The recheck loop starts it once the
            // input comes online.
            const gate = sourceGate(output);
            if (!gate.ready) {
                scheduleRecheck(output, gate.recheckMs);
                return;
            }
            await startJob(output);
        },

        stop(outputId: string): void {
            noteStopStreak(outputId);
            clearRetry(outputId);
            const proc = processes.get(outputId);
            if (proc) {
                void killProcess(outputId, proc);
            } else {
                setStatus(outputId, 'stopped', null);
                // No live process to kill — e.g. stopped mid retry-backoff,
                // between one crash and the next scheduled attempt. The
                // close handler (which normally records the 'stopped'
                // marker) never fires in that case, so record it here
                // instead — otherwise an earlier crash stays the newest
                // history entry forever and keeps showing as current.
                try {
                    const streak = stopFailures.get(outputId) ?? null;
                    stopFailures.delete(outputId);
                    const row = db.getOutput(outputId);
                    recordStop({ id: outputId, name: row?.name ?? outputId }, streak, '');
                } catch {
                    /* non-critical */
                }
            }
        },

        readersOf,

        restart(outputId: string): boolean {
            const proc = processes.get(outputId);
            const output = db.getOutput(outputId);
            if (
                !proc ||
                !output ||
                statuses.get(outputId)?.status !== 'running' ||
                stopRequested.has(outputId)
            ) {
                return false;
            }
            // Readers first: marked as deliberate stops before the rendition goes, so
            // they never see its end-of-stream as a failure. Each close handler then
            // restarts the output (desired running) and the readiness gate makes it
            // wait for the rendition.
            if (isRenditionOutput(output)) {
                for (const dep of dependentsOf(output)) {
                    const depProc = processes.get(dep.id);
                    if (!depProc || stopRequested.has(dep.id)) continue;
                    restartNotes.set(dep.id, 'Shared encode restarted by user');
                    diagnostics?.event('ffmpeg-restart', {
                        outputId: dep.id,
                        outputName: dep.name,
                        ...roleFields(dep),
                        reason: 'shared encode restarted by user',
                        pid: depProc.pid ?? null,
                    });
                    void killProcess(dep.id, depProc, true);
                }
            }
            restartNotes.set(outputId, 'Restarted by user');
            console.log(yellow(`[outputs] ${outputId} (${output.name}) restarted by user`));
            diagnostics?.event('ffmpeg-restart', {
                outputId,
                outputName: output.name,
                ...roleFields(output),
                reason: 'restarted by user',
                pid: proc.pid ?? null,
            });
            void killProcess(outputId, proc, true);
            return true;
        },

        async stopAndWait(outputId: string): Promise<void> {
            clearRetry(outputId);
            const proc = processes.get(outputId);
            if (!proc) {
                setStatus(outputId, 'stopped', null);
                return;
            }
            await killProcess(outputId, proc);
        },

        restartPipelineOutputs(pipelineId: number, staggerBase = 0): number {
            const outputs = db.listOutputsForPipeline(pipelineId);
            let scheduled = 0;
            for (const output of outputs) {
                if (output.desiredState !== 'running') continue;
                // Translation outputs are restarted by the translation mixer's own
                // reconcile loop, not by this service.
                if (output.audioEncoding === 'translation') continue;
                if (statuses.get(output.id)?.status === 'running') {
                    continue;
                }
                const r = getRetry(output.id);
                r.failures = 0;
                if (r.timer) clearTimeout(r.timer);
                r.timer = setTimeout(
                    () => {
                        r.timer = null;
                        void tryStart(output.id);
                    },
                    (staggerBase + scheduled) * RESTART_STAGGER_MS,
                );
                r.timer.unref?.();
                scheduled++;
            }
            return scheduled;
        },

        clearRetryState: clearRetry,

        shutdown(): void {
            shuttingDown = true;
            clearInterval(watchdogTimer);
            for (const r of retryState.values()) {
                if (r.timer) clearTimeout(r.timer);
            }
            for (const [outputId, proc] of processes) {
                stopRequested.add(outputId);
                try {
                    proc.kill('SIGKILL');
                } catch {
                    /* already gone */
                }
            }
            processes.clear();
        },
    };
}
