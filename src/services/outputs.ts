import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import {
    isOutputFfmpegArgs,
    buildFfmpegArgs,
    ffmpegEnv,
    validateOutputUrl,
} from '../utils/ffmpeg.js';
import { readAppConfig, outputMemoryLimitBytes } from '../utils/appConfig.js';
import {
    formatMb,
    readProcRssBytes,
    createProcCpuTracker,
    findPidsByExecutable,
} from '../utils/procStats.js';
import { red, yellow, green } from '../utils/ansiColor.js';
import type { Db, Output } from '../types.js';
import type { InputState } from './inputState.js';
import {
    createLoopFailureReporter,
    runLogged,
    type DiagnosticsLogger,
} from '../utils/diagnostics.js';
import { formatDuration } from '../utils/duration.js';
import {
    RENDITION_APP,
    encodeRecipe,
    isRenditionOutput,
    renditionUrl,
    sharedRecipe,
} from '../utils/renditions.js';
import {
    destinationSocketWarning,
    isNoInputDataWarning,
    parseTcpSocketSnapshot,
    type TcpSocket,
} from './outputSockets.js';
import {
    fetchSrsClientsForHealth,
    fetchSrsStreams,
    type SrsClient,
    type SrsStream,
} from '../utils/srs.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
// Each retry waits up to this fraction less than its step, at random: when a
// platform ingest blips, every output sending to it fails in the same second,
// and identical delays would respawn them (and their SRS pulls) in lockstep.
const RETRY_JITTER = 0.25;
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
// Watchdog ticks between backstop passes (~30 s at the default 5 s interval).
const BACKSTOP_EVERY_TICKS = 6;
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
// How long a watchdog restart waits for SRS to describe the stream the output was
// reading before it restarts the output without that evidence.
const SOURCE_STATE_TIMEOUT_MS = 2000;
// What SRS said is reused for this long, so many outputs found stuck together (or
// one after another) cost SRS one request pair, however many there are.
const SOURCE_STATE_CACHE_MS = 3000;
// Readers listed per stream in a watchdog record; the rest are counted.
const SOURCE_READERS_LISTED = 10;
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
// A finished burst is also recorded in the output's own History (capped,
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

const WARNING_KINDS = ['memory', 'socket', 'media-clock', 'falling-behind'] as const;
type WarningKind = (typeof WARNING_KINDS)[number];

// `bitrate=3200.0kbits/s` from -progress; null for "N/A" and for FFmpeg's 0.0 before it
// has measured anything.
function parseBitrateKbps(line: string): number | null {
    const val = line.slice('bitrate='.length).trim();
    if (val === 'N/A' || val === '0.0kbits/s') return null;
    const match = val.match(/^([\d.]+)kbits\/s$/);
    return match ? parseFloat(match[1]) : null;
}

// The number after `prefix` on a -progress line; null when the line is another key or
// the value is not a finite number (FFmpeg writes "N/A" until it knows).
function parseProgressNumber(line: string, prefix: string): number | null {
    if (!line.startsWith(prefix)) return null;
    const val = Number(line.slice(prefix.length).trim());
    return Number.isFinite(val) ? val : null;
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
    // When the pending retry after a failure is due (ms since epoch), else null.
    nextRetryAtMs: number | null;
    warningReason: string | null;
    // When the warning in warningReason began (ms since epoch), else null.
    warningSinceMs: number | null;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
    cpuPercent: number | null;
    // Media seconds produced per wall second over the last finished speed window
    // (1 is realtime), else null: not measured yet, progress paused, or not
    // reported by this service.
    speed: number | null;
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

// An output that processes media slower than realtime falls further behind live
// every second (slow encode or destination, or an input delivering slowly). Speed
// is measured over windows of media time against wall time, because FFmpeg's own
// speed= and fps= are averages over the whole run and react far too slowly. It
// takes two slow windows in a row to warn, so a brief input hiccup does not, and a
// gap with no progress at all (a stall, which the progress watchdog handles)
// restarts the measurement.
const SPEED_WINDOW_MS = 30_000;
const SPEED_WARN_BELOW = 0.9;
const SPEED_WARN_WINDOWS = 2;
const SPEED_GAP_RESET_MS = 10_000;

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
    speedWindow: { wallMs: number; outTimeUs: number } | null;
    // The first window after a start is not reported: FFmpeg reads its probe data
    // faster than realtime, so it would read high on every start.
    speedSettled: boolean;
    lastSpeed: number | null;
    slowWindows: number;
    fallingBehindWarning: string | null;
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
    // `byUser`: a person pressed Start; the History gets a 'started' record.
    start(outputId: string, options?: { byUser?: boolean }): Promise<void>;
    stop(outputId: string): void;
    stopAndWait(outputId: string): Promise<void>;
    // Stops a running output and starts it again, recording the restart in its
    // History as a deliberate stop (not a failure). Restarting a rendition
    // also restarts the outputs pulling from it. False when it is not running.
    restart(outputId: string, why?: string): boolean;
    // The input's format changed under running outputs (an encoder reconnected with
    // another codec, resolution or audio track count): restarts, one RESTART_STAGGER_MS
    // apart, the pipeline's outputs that were already running before `startedBeforeMs`
    // (the new publisher's start; later ones already read the new format). Readers of
    // a shared encode restart with it. Returns how many restarts were scheduled.
    restartRunningOutputs(pipelineId: number, why: string, startedBeforeMs: number): number;
    // How many running outputs are reading this shared encode right now.
    readersOf(renditionId: string): number;
    restartPipelineOutputs(pipelineId: number, staggerBase?: number): number;
    // Stops the output for good, ahead of deleting its row: marks it
    // desired-stopped first (or its close handler respawns it), waits for the
    // process to exit, then drops any retry its exit left behind. Safe to call
    // on an output that is not running.
    retire(outputId: string): Promise<void>;
    // Kills every ffmpeg without waiting; returns the ids that were running.
    shutdown(): string[];
}

// A fresh instance owns no ffmpeg processes yet, so anything already running
// our ffmpeg binary at construction time must be an orphan left behind by a
// previous instance. Give it a chance to exit cleanly; no need to wait or
// escalate to SIGKILL — an orphan that ignores SIGTERM is no worse off than
// before this ran, and the next restart will sweep it again.
function killOrphanedFfmpeg(): void {
    for (const pid of findPidsByExecutable(FFMPEG_CMD, isOutputFfmpegArgs)) {
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
    fetchStreams: () => Promise<SrsStream[]> = fetchSrsStreams,
    fetchClients: () => Promise<SrsClient[]> = fetchSrsClientsForHealth,
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
    // Outputs whose watchdog restart is waiting for the input source's state.
    const watchdogRestarting = new Set<string>();
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
            // When the pending retry after a failure is due (not set for a
            // re-check while the input is down), shown on the output card.
            retryAtMs: number | null;
            // Which start problems the current episode (since the last spawn)
            // already put in the History, so a start that keeps failing
            // adds one record, not one per attempt.
            startFailureNoted: boolean;
            backstopNoted: boolean;
        }
    >();
    // For the 'stopped' record of a stop that followed repeated failures.
    const stopFailures = new Map<string, { attempts: number; lastFailure: string | null }>();
    // The latest ffmpeg run of each output (kept after it exits, so the retry
    // and stop events that follow still name it). Every diagnostics event about
    // an output carries these, so one grep for a runId gives that run's story.
    const runs = new Map<string, { pipelineId: number; runId: string; pid: number | null }>();
    const runCounts = new Map<string, number>();
    // The stderr tail of each output's previous exit: a retry flood against a
    // dead destination repeats the same text on every attempt.
    const lastExitStderr = new Map<string, string>();

    function logEvent(
        event: string,
        fields: Record<string, unknown> & { outputId?: string },
    ): void {
        const run = fields.outputId === undefined ? undefined : runs.get(fields.outputId);
        diagnostics?.event(event, run ? { outputId: fields.outputId, ...run, ...fields } : fields);
    }
    const watchdogFailures = createLoopFailureReporter('output-watchdog', diagnostics);
    const backstopFailures = createLoopFailureReporter('output-backstop', diagnostics);
    let watchdogTicks = 0;
    const watchdogTimer = setInterval(() => {
        try {
            checkOutputWatchdog();
            watchdogFailures.succeeded();
        } catch (err) {
            watchdogFailures.failed(err);
        }
        if (++watchdogTicks % BACKSTOP_EVERY_TICKS !== 0) return;
        try {
            startOrphanedOutputs();
            backstopFailures.succeeded();
        } catch (err) {
            backstopFailures.failed(err);
        }
    }, OUTPUT_WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref?.();
    refreshTcpSocketSnapshot();
    killOrphanedFfmpeg();

    function getStats(outputId: string): OutputStats {
        const s = statuses.get(outputId) ?? { status: 'stopped' as const, pid: null };
        const row = db.getOutput(outputId);
        const role = row && isRenditionOutput(row) ? 'rendition' : 'output';
        const usage = memoryUsage.get(outputId);
        const p = progress.get(outputId);
        const warning = currentWarning(outputId, p);
        return {
            ...s,
            bitrateKbps: p?.lastBitrateKbps ?? null,
            startedAtMs: startTimes.get(outputId) ?? null,
            failures: retryState.get(outputId)?.failures ?? 0,
            nextRetryAtMs: retryState.get(outputId)?.retryAtMs ?? null,
            warningReason: warning?.reason ?? null,
            warningSinceMs: warning?.sinceMs ?? null,
            memoryUsageBytes: usage?.rssBytes ?? null,
            memoryLimitBytes: usage?.limitBytes ?? null,
            cpuPercent: cpuUsage.get(outputId) ?? null,
            // Stale once progress has paused for as long as a gap resets the window.
            speed:
                p?.lastOutTimeWallMs != null &&
                Date.now() - p.lastOutTimeWallMs <= SPEED_GAP_RESET_MS
                    ? p.lastSpeed
                    : null,
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

    function getRetry(outputId: string) {
        if (!retryState.has(outputId)) {
            retryState.set(outputId, {
                failures: 0,
                quickFailures: 0,
                lastFailure: null,
                timer: null,
                retryAtMs: null,
                startFailureNoted: false,
                backstopNoted: false,
            });
        }
        return retryState.get(outputId)!;
    }

    // A start that fails before spawning, or an output nothing was starting, has
    // no ffmpeg run to leave a history record, so write one here: otherwise the
    // card shows nothing while the output sits stopped.
    function noteStartProblem(
        outputId: string,
        kind: 'startFailure' | 'backstop',
        message: string,
    ): void {
        const r = getRetry(outputId);
        const noted = kind === 'startFailure' ? 'startFailureNoted' : 'backstopNoted';
        if (r[noted]) return;
        r[noted] = true;
        try {
            db.setOutputLastError(outputId, message, kind === 'startFailure' ? 'crash' : 'warning');
        } catch (err) {
            console.warn(red(`[outputs] ${outputId} could not record "${message}":`), err);
        }
    }

    // A person started the output. Written to its History, so a later
    // failure shows who began the run and when, and to the diagnostics. Like a
    // 'stopped' record it ends an earlier crash's claim to be the current error.
    function noteUserStart(output: Output, sourceReady: boolean): void {
        try {
            db.setOutputLastError(
                output.id,
                sourceReady
                    ? 'Started manually'
                    : 'Started manually; waiting for its source to be ready',
                'started',
            );
        } catch (err) {
            console.warn(red(`[outputs] ${output.id} could not record the manual start:`), err);
        }
        logEvent('output-user-start', {
            outputId: output.id,
            outputName: output.name,
            ...roleFields(output),
            sourceReady,
        });
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
        logEvent('output-stopped-after-failures', {
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
        // The step follows the current streak of quick failures, not the
        // lifetime count, so a drop after a run that stayed up retries in ~1 s
        // even late in a long event.
        const step = Math.min(Math.max(r.quickFailures, 1) - 1, RETRY_DELAYS_MS.length - 1);
        const delayMs = Math.round(RETRY_DELAYS_MS[step] * (1 - RETRY_JITTER * Math.random()));
        console.warn(
            yellow(
                `[outputs] ${output.id} (${output.name}) retry ${r.failures} scheduled in ${delayMs}ms`,
            ),
        );
        logEvent('ffmpeg-retry-scheduled', {
            outputId: output.id,
            outputName: output.name,
            attempt: r.failures,
            delayMs,
        });
        scheduleTryStart(output.id, delayMs);
        r.retryAtMs = Date.now() + delayMs;
    }

    // Schedule a tryStart without counting a failure — used when the input/SRS is
    // not yet ready, so we keep checking cheaply until it is.
    function scheduleRecheck(output: Output, delayMs: number): void {
        scheduleTryStart(output.id, delayMs);
    }

    function scheduleTryStart(outputId: string, delayMs: number): void {
        const r = getRetry(outputId);
        if (r.timer) clearTimeout(r.timer);
        r.retryAtMs = null;
        r.timer = setTimeout(() => {
            r.timer = null;
            r.retryAtMs = null;
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
            if (statuses.get(outputId)?.status === 'running') return;
            // Don't spawn a doomed ffmpeg against a dead input; re-check until ready.
            const gate = sourceGate(output);
            if (!gate.ready) {
                scheduleRecheck(output, gate.recheckMs);
                return;
            }
            await startJob(output);
        } catch (err) {
            // Not retried from here: the next input edge or manual start, or
            // else the backstop (startOrphanedOutputs), tries again.
            console.warn(red(`[outputs] ${outputId} auto-start failed:`), err);
            const error = err instanceof Error ? err.message : String(err);
            logEvent('output-start-failed', { outputId, error });
            noteStartProblem(outputId, 'startFailure', `Start failed: ${error}`);
        } finally {
            startLocks.delete(outputId);
        }
    }

    function trackSpeed(outputId: string, p: OutputProgress, now: number, outTimeUs: number): void {
        if (p.lastOutTimeWallMs !== null && now - p.lastOutTimeWallMs > SPEED_GAP_RESET_MS) {
            p.speedWindow = null;
            p.lastSpeed = null;
            p.slowWindows = 0;
            p.fallingBehindWarning = null;
            warningEnded(outputId, 'falling-behind', 'progress paused');
        }
        if (!p.speedWindow) {
            p.speedWindow = { wallMs: now, outTimeUs };
            return;
        }
        const wallMs = now - p.speedWindow.wallMs;
        if (wallMs < SPEED_WINDOW_MS) return;
        const speed = (outTimeUs - p.speedWindow.outTimeUs) / 1000 / wallMs;
        p.speedWindow = { wallMs: now, outTimeUs };
        if (p.speedSettled) p.lastSpeed = speed;
        else p.speedSettled = true;
        if (speed >= SPEED_WARN_BELOW) {
            p.slowWindows = 0;
            p.fallingBehindWarning = null;
            warningEnded(outputId, 'falling-behind', 'cleared');
            return;
        }
        p.slowWindows++;
        if (p.slowWindows < SPEED_WARN_WINDOWS) return;
        const warning = `Output is running at ${speed.toFixed(2)}x realtime and falling behind live (slow encode or destination, or the input is delivering slowly).`;
        p.fallingBehindWarning = warning;
        warningStarted(outputId, 'falling-behind', warning);
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
            trackSpeed(outputId, p, now, outTimeMs);
            p.lastOutTimeMs = outTimeMs;
            p.lastOutTimeWallMs = now;
            p.lastOutputProgressAtMs = p.lastProgressAtMs;
            return;
        }

        if (line.startsWith('bitrate=')) {
            p.lastBitrateKbps = parseBitrateKbps(line);
        }
    }

    // The warning an output's card shows, and when it began. One at a time, in
    // this order of importance.
    function currentWarning(
        outputId: string,
        p: OutputProgress | undefined,
    ): { reason: string; sinceMs: number | null } | null {
        const startedAt = (kind: WarningKind): number | null =>
            warningEpisodes.get(`${outputId}:${kind}`)?.startedAtMs ?? null;
        const socket = socketWarnings.get(outputId);
        if (socket) return { reason: socket.reason, sinceMs: socket.badSinceMs };
        const memory = memoryWarnings.get(outputId);
        if (memory) return { reason: memory, sinceMs: startedAt('memory') };
        if (!p) return null;
        const timing = timingWarningFor(outputId, p, Date.now());
        if (timing) return timing;
        if (p.fallingBehindWarning) {
            return { reason: p.fallingBehindWarning, sinceMs: startedAt('falling-behind') };
        }
        return null;
    }

    function timingWarningFor(
        outputId: string,
        p: OutputProgress,
        now: number,
    ): { reason: string; sinceMs: number | null } | null {
        if (p.mediaClockWarning) {
            return {
                reason: p.mediaClockWarning,
                sinceMs: warningEpisodes.get(`${outputId}:media-clock`)?.startedAtMs ?? null,
            };
        }
        const burst = p.timestampBurst;
        if (
            p.lastTimestampWarning &&
            p.lastTimestampWarningAtMs !== null &&
            now - p.lastTimestampWarningAtMs <= TIMESTAMP_QUIET_MS &&
            burst &&
            (burst.timing || burst.lastAtMs - burst.startedAtMs >= DECODE_WARNING_GRACE_MS)
        ) {
            return { reason: p.lastTimestampWarning, sinceMs: burst.startedAtMs };
        }
        if (p.monitorMediaClock && now - p.lastOutputProgressAtMs >= 15_000) {
            return {
                reason: `FFmpeg media progress has stalled for ${Math.round((now - p.lastOutputProgressAtMs) / 1000)}s.`,
                sinceMs: p.lastOutputProgressAtMs,
            };
        }
        return null;
    }

    function flushTimestampSummary(outputId: string, burst: TimestampBurst, now: number): void {
        if (burst.pendingCount === 0) return;
        logEvent('ffmpeg-timestamp-warning-summary', {
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
    // written to its History within the interval.
    function claimBurstHistory(outputId: string, cls: string, now: number): boolean {
        const key = `${outputId}:${cls}`;
        const last = burstHistoryAtMs.get(key);
        if (last !== undefined && now - last < BURST_HISTORY_INTERVAL_MS) return false;
        burstHistoryAtMs.set(key, now);
        return true;
    }

    // Writes one 'warning' record to the output's History, at most once
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
    // History record when it ends (it clears, or the process exits).
    function warningStarted(outputId: string, kind: WarningKind, message: string): void {
        const key = `${outputId}:${kind}`;
        if (warningEpisodes.has(key)) return;
        warningEpisodes.set(key, { startedAtMs: Date.now(), message });
        logEvent('ffmpeg-warning-started', { outputId, kind, message });
    }

    function warningEnded(outputId: string, kind: WarningKind, reason: string): void {
        const key = `${outputId}:${kind}`;
        const episode = warningEpisodes.get(key);
        if (!episode) return;
        warningEpisodes.delete(key);
        const durationMs = Date.now() - episode.startedAtMs;
        logEvent('ffmpeg-warning-ended', {
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
            const message = `High memory usage: ${formatMb(rssBytes / (1024 * 1024))} / ${formatMb(
                limitBytes / (1024 * 1024),
            )} limit (${Math.round((rssBytes / limitBytes) * 100)}%)`;
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
            logEvent('ffmpeg-timestamp-recovered', {
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
                logEvent('ffmpeg-timestamp-warning', { outputId, line });
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

    function buildWatchdogError(
        outputId: string,
        proc: ChildProcess,
        now: number,
        sourceText: string,
    ): string {
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
            sourceText,
            stderr ? `ffmpeg stderr tail:\n${stderr}` : 'ffmpeg stderr tail: <empty>',
            `Restarting output: no ffmpeg output progress for ${stalledForSec}s`,
        ].join('\n');
    }

    function buildSocketWatchdogError(
        outputId: string,
        proc: ChildProcess,
        reason: string,
        sourceText: string,
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
            isNoInputDataWarning(reason)
                ? 'watchdog: ffmpeg received no input data; restarting process'
                : 'watchdog: ffmpeg destination socket unhealthy; restarting process',
            `pid=${proc.pid ?? 'unknown'}`,
            `socket_warning=${reason}`,
            socketSnapshot,
            `last_total_size=${formatNullable(p?.lastTotalSize ?? null)}`,
            `last_out_time_us=${formatNullable(p?.lastOutTimeMs ?? null)}`,
            `last_bitrate_kbps=${formatNullable(p?.lastBitrateKbps ?? null)}`,
            sourceText,
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
            `Restarting output: RSS ${formatMb(rssBytes / (1024 * 1024))} exceeded ${formatMb(
                limitBytes / (1024 * 1024),
            )} limit`,
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
        warningStarted(
            outputId,
            'socket',
            isNoInputDataWarning(reason) ? reason : `Destination socket unhealthy: ${reason}`,
        );
        return next;
    }

    // What SRS says about its streams and the connections on them, both asked at
    // once and each allowed to fail on its own.
    interface SrsSnapshot {
        streams: PromiseSettledResult<SrsStream[]>;
        clients: PromiseSettledResult<SrsClient[]>;
    }
    let srsSnapshot: { atMs: number; promise: Promise<SrsSnapshot> } | null = null;
    function fetchSrsSnapshot(): Promise<SrsSnapshot> {
        if (srsSnapshot && Date.now() - srsSnapshot.atMs < SOURCE_STATE_CACHE_MS) {
            return srsSnapshot.promise;
        }
        const promise = Promise.allSettled([fetchStreams(), fetchClients()]).then(
            ([streams, clients]) => ({ streams, clients }),
        );
        srsSnapshot = { atMs: Date.now(), promise };
        return promise;
    }

    function formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }

    // What the output was reading when the watchdog found it stuck: the stream in
    // SRS (its publisher, readers, bitrate, codecs) and, for a shared output, the
    // shared encode's own process. This is what tells an input that never
    // delivered from a destination that refused data. Never throws and waits at
    // most SOURCE_STATE_TIMEOUT_MS for SRS.
    async function describeInputSource(
        output: Output,
    ): Promise<{ text: string; fields: Record<string, unknown> }> {
        const renditionId = renditionOf.get(output.id);
        const rendition = renditionId ? db.getOutput(renditionId) : null;
        const app = renditionId ? RENDITION_APP : 'live';
        const name = renditionId
            ? (rendition?.url.slice(rendition.url.lastIndexOf('/') + 1) ?? null)
            : (db.getPipeline(output.pipelineId)?.streamKey ?? null);
        const fields: Record<string, unknown> = { stream: name === null ? null : `${app}/${name}` };
        const lines = [`input_source: ${fields.stream ?? 'unknown'}`];

        let timer: NodeJS.Timeout | undefined;
        let snapshot: SrsSnapshot | null = null;
        let noAnswer: string | null = null;
        try {
            snapshot = await Promise.race([
                fetchSrsSnapshot(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`no answer in ${SOURCE_STATE_TIMEOUT_MS} ms`)),
                        SOURCE_STATE_TIMEOUT_MS,
                    );
                }),
            ]);
        } catch (err) {
            noAnswer = err instanceof Error ? err.message : String(err);
        } finally {
            clearTimeout(timer);
        }
        const failure = (result: PromiseSettledResult<unknown> | undefined): string | null =>
            noAnswer ??
            (result?.status === 'rejected'
                ? result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason)
                : null);

        const streamsError = failure(snapshot?.streams);
        if (streamsError !== null || snapshot?.streams.status !== 'fulfilled') {
            fields.srs = { error: streamsError };
            lines.push(`srs_stream: unavailable (${streamsError})`);
        } else {
            const s = snapshot.streams.value.find((x) => x.app === app && x.name === name);
            if (!s) {
                fields.srs = { found: false };
                lines.push('srs_stream: not found in SRS');
            } else {
                const video = s.video
                    ? `${s.video.codec} ${s.video.width}x${s.video.height}`
                    : null;
                const audio = s.audio ? s.audio.codec : null;
                fields.srs = {
                    found: true,
                    publishing: s.publish.active,
                    clients: s.clients,
                    recvKbps: s.kbps.recv_30s,
                    sendKbps: s.kbps.send_30s,
                    frames: s.frames,
                    video,
                    audio,
                };
                lines.push(
                    `srs_stream: publish=${s.publish.active ? 'active' : 'none'} clients=${s.clients} recv_30s=${s.kbps.recv_30s}kbps send_30s=${s.kbps.send_30s}kbps frames=${s.frames} video=${video ?? 'none'} audio=${audio ?? 'none'}`,
                );
            }
        }

        // Each reader of the stream on its own: the stream's send rate is the sum
        // over all of them, so it cannot say whether SRS sent this reader anything.
        // Readers all connect from this host, so they cannot be told apart by
        // address; the stuck one is usually the youngest or the one with the least sent.
        const clientsError = failure(snapshot?.clients);
        if (clientsError !== null || snapshot?.clients.status !== 'fulfilled') {
            fields.readers = { error: clientsError };
            lines.push(`srs_readers: unavailable (${clientsError})`);
        } else {
            // The ones SRS has sent least come first, so the cap never hides the stuck one.
            const readers = snapshot.clients.value
                .filter(
                    (c) => c.publish !== true && c.name === name && c.tcUrl?.endsWith(`/${app}`),
                )
                .sort((a, b) => (a.send_bytes ?? 0) - (b.send_bytes ?? 0));
            fields.readers = {
                count: readers.length,
                list: readers.slice(0, SOURCE_READERS_LISTED).map((c) => ({
                    aliveSec: Math.round(c.alive ?? 0),
                    sendBytes: c.send_bytes ?? 0,
                    sendKbps: c.kbps?.send_30s ?? 0,
                })),
            };
            lines.push(`srs_readers: ${readers.length} playing`);
            for (const c of readers.slice(0, SOURCE_READERS_LISTED)) {
                lines.push(
                    `  reader alive=${Math.round(c.alive ?? 0)}s sent=${formatBytes(c.send_bytes ?? 0)} send_30s=${c.kbps?.send_30s ?? 0}kbps`,
                );
            }
            if (readers.length > SOURCE_READERS_LISTED) {
                lines.push(`  ... and ${readers.length - SOURCE_READERS_LISTED} more`);
            }
        }

        if (renditionId) {
            const now = Date.now();
            const startedAtMs = startTimes.get(renditionId);
            const rp = progress.get(renditionId);
            const encode = {
                id: renditionId,
                running: processes.has(renditionId),
                ready: isRenditionReady(renditionId),
                uptimeSec:
                    startedAtMs === undefined ? null : Math.round((now - startedAtMs) / 1000),
                bitrateKbps: rp?.lastBitrateKbps ?? null,
                progressAgeSec: rp ? Math.round((now - rp.lastOutputProgressAtMs) / 1000) : null,
            };
            fields.sharedEncode = encode;
            lines.push(
                `shared_encode ${renditionId}: ${encode.running ? 'running' : 'not running'} ready=${encode.ready} uptime=${formatNullable(encode.uptimeSec)}s bitrate=${formatNullable(encode.bitrateKbps)}kbps progress_age=${formatNullable(encode.progressAgeSec)}s`,
            );
        }
        return { text: lines.join('\n'), fields };
    }

    // Restarts an output the watchdog found stuck. The input source is described
    // first (bounded), so the History and the diagnostics say what the
    // output was waiting on; the process is checked again afterwards because it
    // may have exited, been stopped or been replaced in the meantime. One restart
    // per output at a time: the watchdog tick keeps seeing the same fault until
    // the kill lands.
    function restartStuckOutput(
        output: Output,
        proc: ChildProcess,
        reason: string,
        logLine: string,
        buildError: (sourceText: string) => string,
        eventFields: Record<string, unknown> = {},
    ): void {
        const outputId = output.id;
        if (watchdogRestarting.has(outputId)) return;
        watchdogRestarting.add(outputId);
        void (async () => {
            try {
                // The restart must not depend on the evidence: a failure to gather it
                // is recorded in its place.
                const source = await describeInputSource(output).catch((err: unknown) => {
                    const error = err instanceof Error ? err.message : String(err);
                    return {
                        text: `input_source: unavailable (${error})`,
                        fields: { error } as Record<string, unknown>,
                    };
                });
                if (
                    processes.get(outputId) !== proc ||
                    watchdogKills.has(outputId) ||
                    stopRequested.has(outputId)
                ) {
                    return;
                }
                try {
                    db.setOutputLastError(outputId, buildError(source.text), 'crash');
                } catch {
                    /* non-critical; still restart the stuck process */
                }
                console.warn(yellow(logLine));
                logEvent('ffmpeg-restart', {
                    outputId,
                    outputName: output.name,
                    ...roleFields(output),
                    reason,
                    pid: proc.pid ?? null,
                    ...eventFields,
                    inputSource: source.fields,
                });
                noteWatchdogKill(outputId, reason);
                void killProcess(outputId, proc, false);
            } finally {
                watchdogRestarting.delete(outputId);
            }
        })();
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

        const why = isNoInputDataWarning(reason) ? reason : `socket unhealthy: ${reason}`;
        restartStuckOutput(
            output,
            proc,
            why,
            `[outputs] ${outputId} (${output.name}) ${why}, killing pid=${proc.pid}`,
            (sourceText) => buildSocketWatchdogError(outputId, proc, reason, sourceText),
        );
        return true;
    }

    // Outputs that should be running but have no process, no pending retry or
    // re-check and no start in progress. Every normal path leaves one of those
    // behind, so this only catches bugs and unexpected throws (see tryStart).
    // An output must look orphaned on two passes in a row, so outputs about to
    // be started by the health poll's staggered restart are left to it.
    let orphansSeen = new Set<string>();
    function startOrphanedOutputs(): void {
        if (shuttingDown) return;
        const orphans = new Set<string>();
        let kicked = 0;
        for (const output of db.listOutputs()) {
            if (output.desiredState !== 'running') continue;
            if (isRenditionOutput(output)) continue;
            if (processes.has(output.id) || startLocks.has(output.id)) continue;
            if (retryState.get(output.id)?.timer) continue;
            if (!inputState.isReady(output.pipelineId)) continue;
            if (!orphansSeen.has(output.id)) {
                orphans.add(output.id);
                continue;
            }
            console.warn(
                yellow(
                    `[outputs] ${output.id} (${output.name}) should be running but nothing was starting it; starting it`,
                ),
            );
            logEvent('output-restarted-by-backstop', {
                outputId: output.id,
                outputName: output.name,
            });
            noteStartProblem(
                output.id,
                'backstop',
                'Watchdog: nothing was starting this output; starting it',
            );
            scheduleTryStart(output.id, kicked++ * RESTART_STAGGER_MS);
        }
        orphansSeen = orphans;
    }

    // An output with a current crash that has since run for STABLE_RUN_MS and is
    // writing data has recovered: the crash stays in its History, marked
    // recovered, and stops being the current error (the card clears), and the
    // retry count starts over. Costs nothing for an output without a current
    // error, which the output row already says.
    function noteRecovery(
        output: Output,
        startedAtMs: number,
        p: OutputProgress,
        now: number,
    ): void {
        if (output.lastError === null || now - startedAtMs < STABLE_RUN_MS) return;
        if ((p.lastTotalSize ?? 0) <= 0) return;
        // lastError is "<ts of the latest crash>\n<message>": a crash recorded
        // during this run is not one it has recovered from.
        if (!(Number.parseInt(output.lastError, 10) < startedAtMs)) return;
        let crashes: number | null;
        try {
            crashes = db.markOutputRecovered(output.id);
        } catch (err) {
            console.warn(red(`[outputs] ${output.id} could not record its recovery:`), err);
            return;
        }
        if (crashes === null) return;
        const retry = retryState.get(output.id);
        const failures = retry?.failures ?? 0;
        if (retry) retry.failures = 0;
        console.log(
            green(
                `[outputs] ${output.id} (${output.name}) recovered: running for ${formatDuration(now - startedAtMs)} after ${crashes} crash${crashes === 1 ? '' : 'es'}`,
            ),
        );
        logEvent('output-recovered', {
            outputId: output.id,
            outputName: output.name,
            ...roleFields(output),
            crashes,
            failures,
            ranMs: now - startedAtMs,
        });
    }

    function checkOutputWatchdog(): void {
        const now = Date.now();
        refreshTcpSocketSnapshot();
        for (const [outputId, p] of progress) evaluateTimestampBurst(outputId, p, now);
        for (const [outputId, proc] of processes) {
            if (watchdogKills.has(outputId) || watchdogRestarting.has(outputId)) continue;
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
            noteRecovery(output, startedAtMs, p, now);

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
                    (p.lastTotalSize ?? 0) > 0,
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
                            `[outputs] ${outputId} (${output.name}) memory limit exceeded: rss=${formatMb(
                                rssBytes / (1024 * 1024),
                            )} (limit ${formatMb(
                                limitBytes / (1024 * 1024),
                            )}), killing pid=${proc.pid} for retry`,
                        ),
                    );
                    logEvent('ffmpeg-restart', {
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

            const stalledSeconds = Math.round((now - p.lastOutputProgressAtMs) / 1000);
            restartStuckOutput(
                output,
                proc,
                'output progress stalled',
                `[outputs] ${outputId} (${output.name}) stalled: no output progress for ${stalledSeconds}s, killing pid=${proc.pid} for retry`,
                (sourceText) => buildWatchdogError(outputId, proc, Date.now(), sourceText),
                { stalledSeconds },
            );
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
            logEvent('ffmpeg-restart', {
                outputId: dep.id,
                outputName: dep.name,
                ...roleFields(dep),
                reason: 'shared encode failed',
                pid: proc.pid ?? null,
            });
            void killProcess(dep.id, proc, false);
        }
        if (affected.length === 0) return;
        logEvent('rendition-dependents-restarted', {
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
            : buildFfmpegArgs(inputUrl, output.url, output.audioEncoding, output.videoEncoding);

        // The one place that spawns, so the one place that can promise a single
        // ffmpeg per output whichever caller got here (start(), tryStart(), the
        // backstop) and however the checks before it interleave. A second spawn
        // would overwrite the map entry and leave the first process orphaned.
        if (processes.has(output.id)) {
            console.warn(
                yellow(
                    `[outputs] ${output.id} (${output.name}) already has an ffmpeg process; not starting a second one`,
                ),
            );
            logEvent('output-start-skipped', {
                outputId: output.id,
                outputName: output.name,
                reason: 'process already registered',
            });
            return;
        }

        // stdout and stderr must stay as 'pipe' (not 'ignore' or 'inherit').
        // When Node.js exits for any reason — including SIGKILL or a crash — the OS
        // closes the read ends of these pipes. ffmpeg writes to stdout every ~1s via
        // '-progress pipe:1', so it receives SIGPIPE within a second and exits.
        // Using 'ignore' (i.e. /dev/null) would break this coupling and leave
        // orphaned ffmpeg processes running after the parent dies.
        const child: ChildProcess = spawn(FFMPEG_CMD, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: ffmpegEnv(),
        });

        processes.set(output.id, child);
        const retry = retryState.get(output.id);
        if (retry) {
            retry.startFailureNoted = false;
            retry.backstopNoted = false;
        }
        const runNumber = (runCounts.get(output.id) ?? 0) + 1;
        runCounts.set(output.id, runNumber);
        runs.set(output.id, {
            pipelineId: output.pipelineId,
            runId: `${output.id}#${runNumber}`,
            pid: child.pid ?? null,
        });
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
            speedWindow: null,
            speedSettled: false,
            lastSpeed: null,
            slowWindows: 0,
            fallingBehindWarning: null,
            lastTimestampWarningAtMs: null,
            lastTimestampWarning: null,
            timestampBurst: null,
            lastOutTimeWallMs: null,
        });
        console.log(green(`[outputs] ${output.id} (${output.name}) started pid=${child.pid}`));
        logEvent('ffmpeg-started', {
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
        // Warnings are matched per line; a pipe read can end mid-line.
        let stderrPartial = '';
        child.stderr?.on('data', (d: Buffer) => {
            const text = d.toString();
            stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
            const lines = (stderrPartial + text).split(/\r?\n|\r/);
            stderrPartial = (lines.pop() ?? '').slice(-STDERR_TAIL_BYTES);
            const p = progress.get(output.id);
            if (p) {
                p.stderrTail = stderrTail;
                if (lines.length > 0) noteTimestampWarning(output.id, lines.join('\n'));
            }
        });

        child.on('error', (err) => {
            console.warn(red(`[outputs] ${output.id} error:`), err.message);
            logEvent('ffmpeg-process-error', { outputId: output.id, error: err.message });
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
            const exitStderr = stderrTail.trim();
            const stderrTailSameAsPrevious =
                exitStderr !== '' && lastExitStderr.get(output.id) === exitStderr;
            lastExitStderr.set(output.id, exitStderr);
            logEvent('ffmpeg-exited', {
                outputId: output.id,
                outputName: output.name,
                pid: child.pid ?? null,
                code,
                signal,
                status,
                ranMs,
                ...roles,
                watchdog: wasWatchdog,
                reason: watchdogReason,
                stderrTail: stderrTailSameAsPrevious ? null : exitStderr || null,
                ...(stderrTailSameAsPrevious ? { stderrTailSameAsPrevious } : {}),
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

    const service: OutputService = {
        getStats,

        // The status check below is the cheap early exit. What guarantees a single
        // ffmpeg per output is the processes check inside startJob(), right before
        // the spawn, so it holds even if an await is added before it.
        async start(outputId: string, options?: { byUser?: boolean }): Promise<void> {
            if (startLocks.has(outputId)) return;
            if (statuses.get(outputId)?.status === 'running') return;
            const output = db.getOutput(outputId);
            if (!output) throw new Error('Output not found');
            if (!validateOutputUrl(output.url)) throw new Error('Invalid output URL');
            clearRetry(outputId);
            getRetry(outputId).failures = 0;
            // Input not live yet — keep the output "running" (desiredState) but
            // don't spawn a doomed ffmpeg. The recheck loop starts it once the
            // input comes online.
            const gate = sourceGate(output);
            if (options?.byUser) noteUserStart(output, gate.ready);
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

        restart(outputId: string, why?: string): boolean {
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
                    logEvent('ffmpeg-restart', {
                        outputId: dep.id,
                        outputName: dep.name,
                        ...roleFields(dep),
                        reason: 'shared encode restarted by user',
                        pid: depProc.pid ?? null,
                    });
                    void killProcess(dep.id, depProc, true);
                }
            }
            restartNotes.set(outputId, why ? `Restarted: ${why}` : 'Restarted by user');
            console.log(
                yellow(
                    `[outputs] ${outputId} (${output.name}) restarted ${why ? `(${why})` : 'by user'}`,
                ),
            );
            logEvent('ffmpeg-restart', {
                outputId,
                outputName: output.name,
                ...roleFields(output),
                reason: why ?? 'restarted by user',
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

        restartRunningOutputs(pipelineId: number, why: string, startedBeforeMs: number): number {
            let scheduled = 0;
            for (const output of db.listOutputsForPipeline(pipelineId)) {
                if (output.desiredState !== 'running') continue;
                // A reader goes down with its shared encode (see restart()).
                if (renditionOf.has(output.id)) continue;
                if ((startTimes.get(output.id) ?? Infinity) >= startedBeforeMs) continue;
                setTimeout(
                    () =>
                        runLogged(
                            `restart-${output.id}`,
                            () => service.restart(output.id, why),
                            diagnostics,
                        ),
                    scheduled * RESTART_STAGGER_MS,
                );
                scheduled++;
            }
            return scheduled;
        },

        restartPipelineOutputs(pipelineId: number, staggerBase = 0): number {
            const outputs = db.listOutputsForPipeline(pipelineId);
            let scheduled = 0;
            for (const output of outputs) {
                if (output.desiredState !== 'running') continue;
                if (statuses.get(output.id)?.status === 'running') {
                    continue;
                }
                const r = getRetry(output.id);
                r.failures = 0;
                r.retryAtMs = null;
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

        async retire(outputId: string): Promise<void> {
            if (db.getOutput(outputId)?.desiredState === 'running') {
                db.setOutputDesiredState(outputId, 'stopped');
            }
            await service.stopAndWait(outputId);
            // The kill's close handler may have scheduled a retry or a prompt
            // restart before it saw desired-stopped; drop it.
            clearRetry(outputId);
        },

        shutdown(): string[] {
            shuttingDown = true;
            const killed = [...processes.keys()];
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
            return killed;
        },
    };
    return service;
}
