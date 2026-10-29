import type { ChildProcess } from 'child_process';
import type { Db } from '../types.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';
import { inputPullUrl, type InputProtocol } from './inputState.js';
import {
    isProbeUsable,
    keyframeIntervalTooLong,
    keyframeSummary,
    probeError,
    runFfprobe,
    runKeyframeProbe,
    type KeyframeStats,
    type ProbeFailure,
    type ProbeResult,
} from './mediaProbe.js';

const FFPROBE_FAILED_REFRESH_MS = 30000;
// Stagger concurrent ffprobe launches instead of capping concurrency with a
// semaphore. The real risk is the thundering-herd burst (all N pipelines firing
// at the same millisecond after a mass reconnect), not the sustained overlap —
// probes read different streams so there is no shared bottleneck. Stagger is
// simpler and mirrors the output restart pattern; a semaphore would be needed
// only if memory pressure from simultaneous ffprobe processes became a concern.
const FFPROBE_STAGGER_MS = 200;
// Each keyframe check holds an ffprobe (about 12 MB of private memory) for the
// whole of its ~12 s window, so after a mass reconnect they queue instead of all
// running at once.
const KEYFRAME_MAX_CONCURRENT = 4;
// The check starts this long after the publisher's first successful probe, not
// right away: the first seconds of a publisher (above all one fed by another
// pipeline's output that is still recovering) are not representative, and the
// result is shown until the publisher changes. Measured once, so a bad first
// window cannot be corrected later.
const KEYFRAME_DELAY_MS = 60_000;

export interface ProbeStatus {
    result: ProbeResult | null;
    startedAt: number;
    checkedAt: number;
    ok: boolean;
    error: string | null;
    // Consecutive failed probes for this publisher; reset by a success.
    failedAttempts: number;
}

export type KeyframeResult = KeyframeStats & { checkedAt: number };

export interface ProbeScheduler {
    // Called every poll for a connected input. Probes the publisher once; if that
    // probe fails, retries every FFPROBE_FAILED_REFRESH_MS until it succeeds, then
    // stops (avoids repeated SRT play/teardown cycles once the input is known
    // healthy). `stagger` spaces the launches of one poll apart. A keyframe check
    // is queued once, KEYFRAME_DELAY_MS after the first successful probe.
    ensure(pipelineId: number, streamKey: string, protocol: InputProtocol, stagger: number): void;
    // The publisher changed, the input went away or the pipeline was removed:
    // cancels its timers and kills its ffprobe children, drops its results, and
    // makes anything still in flight discard its result when it lands.
    clear(pipelineId: number): void;
    // Clears every pipeline that is not in the set.
    keepOnly(activePipelineIds: Set<number>): void;
    status(pipelineId: number): ProbeStatus | null;
    keyframes(pipelineId: number): KeyframeResult | null;
    // When the probe running now started, else null.
    inFlightSince(pipelineId: number): number | null;
    // No new probe starts after this; kills the running ones. Results stay readable.
    shutdown(): void;
}

export interface ProbeSchedulerDeps {
    db: Pick<Db, 'appendPipelineLog'>;
    diagnostics?: DiagnosticsLogger;
    // Called with every successful probe, before its outcome is recorded.
    onUsableProbe: (pipelineId: number, result: ProbeResult) => void;
    // The ffprobe runners; tests script them instead of spawning ffprobe.
    runners?: {
        runFfprobe: typeof runFfprobe;
        runKeyframeProbe: typeof runKeyframeProbe;
    };
}

function killIfRunning(child: ChildProcess | undefined): void {
    if (child && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
}

export function createProbeScheduler({
    db,
    diagnostics,
    onUsableProbe,
    runners = { runFfprobe, runKeyframeProbe },
}: ProbeSchedulerDeps): ProbeScheduler {
    const results = new Map<number, ProbeStatus>();
    const timers = new Map<number, NodeJS.Timeout>();
    const inFlight = new Set<number>();
    const startedAt = new Map<number, number>();
    const children = new Map<number, ChildProcess>();
    // Bumped by clear(): a probe or queued keyframe check that started under an
    // older generation belongs to a publisher that is gone and drops its result.
    const generations = new Map<number, number>();
    // Keyframe check per pipeline: once per publisher, KEYFRAME_DELAY_MS after its first successful probe.
    const keyframeResults = new Map<number, KeyframeResult>();
    // Pipelines whose current publisher has had its check queued (it runs once, so
    // this stays set after it finishes, or fails, until the publisher changes).
    const keyframeScheduled = new Set<number>();
    const keyframeChildren = new Map<number, ChildProcess>();
    interface KeyframeJob {
        pipelineId: number;
        url: string;
        protocol: InputProtocol;
        generation: number;
    }
    const keyframeQueue: KeyframeJob[] = [];
    let keyframeRunning = 0;
    // Set by shutdown(): a probe still in flight must not start a keyframe check.
    let stopped = false;

    const generationOf = (pipelineId: number): number => generations.get(pipelineId) ?? 0;

    function clear(pipelineId: number): void {
        if (
            !timers.has(pipelineId) &&
            !inFlight.has(pipelineId) &&
            !results.has(pipelineId) &&
            !keyframeScheduled.has(pipelineId) &&
            !keyframeResults.has(pipelineId)
        ) {
            return;
        }
        const timer = timers.get(pipelineId);
        if (timer) clearTimeout(timer);
        timers.delete(pipelineId);
        inFlight.delete(pipelineId);
        startedAt.delete(pipelineId);
        killIfRunning(children.get(pipelineId));
        children.delete(pipelineId);
        results.delete(pipelineId);
        killIfRunning(keyframeChildren.get(pipelineId));
        keyframeChildren.delete(pipelineId);
        keyframeScheduled.delete(pipelineId);
        keyframeResults.delete(pipelineId);
        generations.set(pipelineId, generationOf(pipelineId) + 1);
    }

    // Failed probes leave the dashboard error as the only trace unless they are
    // recorded. Every failure goes to diagnostics (bounded by the 30 s retry
    // cadence and the diagnostics size caps); the pipeline log only gets the
    // first failure and the recovery per publisher so a persistently bad input
    // cannot flood it.
    function recordProbeOutcome(
        pipelineId: number,
        protocol: InputProtocol,
        outcome: {
            ok: boolean;
            previousFailures: number;
            error: string | null;
            failure: ProbeFailure | null;
            elapsedMs: number;
        },
    ): void {
        const { ok, previousFailures, error, failure, elapsedMs } = outcome;
        if (ok && previousFailures === 0) return;
        let pipelineLogEvent: string | null = null;
        let pipelineLogMessage = '';
        if (ok) {
            pipelineLogEvent = 'probe_recovered';
            pipelineLogMessage = `ffprobe validated the input after ${previousFailures} failed ${previousFailures === 1 ? 'attempt' : 'attempts'}`;
            diagnostics?.event('media-probe-recovered', {
                pipelineId,
                protocol,
                failedAttempts: previousFailures,
                elapsedMs,
            });
        } else {
            const reason = failure?.reason ?? 'unusable';
            if (previousFailures === 0) {
                pipelineLogEvent = 'probe_failed';
                pipelineLogMessage =
                    reason === 'timeout'
                        ? `ffprobe timed out after ${Math.round(elapsedMs / 1000)}s without media data`
                        : `ffprobe failed (${reason}): ${error ?? 'no usable video stream'}`;
            }
            diagnostics?.event('media-probe-failed', {
                pipelineId,
                protocol,
                reason,
                attempt: previousFailures + 1,
                elapsedMs,
                exitCode: failure?.exitCode ?? null,
                signal: failure?.signal ?? null,
                error,
                stderrTail: failure?.stderrTail ?? '',
            });
            console.warn(
                `[probe] pipeline ${pipelineId} (${protocol}) attempt ${previousFailures + 1} failed: ${reason} after ${elapsedMs}ms`,
            );
        }
        if (pipelineLogEvent) {
            try {
                db.appendPipelineLog(pipelineId, pipelineLogEvent, pipelineLogMessage);
            } catch {
                /* non-critical */
            }
        }
    }

    // Measures the keyframe gaps once per publisher, KEYFRAME_DELAY_MS after its first successful
    // probe. Reporting only: a failed check is a diagnostics event, not a retry
    // loop and not a media error, and the result is dropped with the publisher.
    function queueKeyframeProbe(job: KeyframeJob): void {
        keyframeScheduled.add(job.pipelineId);
        keyframeQueue.push(job);
        pumpKeyframeQueue();
    }

    function pumpKeyframeQueue(): void {
        while (!stopped && keyframeRunning < KEYFRAME_MAX_CONCURRENT && keyframeQueue.length > 0) {
            const job = keyframeQueue.shift()!;
            // The publisher changed or the pipeline went away while it waited.
            if (generationOf(job.pipelineId) !== job.generation) continue;
            keyframeRunning++;
            void runKeyframeProbeJob(job).finally(() => {
                keyframeRunning--;
                pumpKeyframeQueue();
            });
        }
    }

    async function runKeyframeProbeJob(job: KeyframeJob): Promise<void> {
        const { pipelineId, url, protocol, generation } = job;
        const current = (): boolean => !stopped && generationOf(pipelineId) === generation;
        const jobStartedAt = Date.now();
        try {
            let failure: ProbeFailure | null = null;
            const stats = await runners.runKeyframeProbe(
                url,
                (child) => {
                    keyframeChildren.set(pipelineId, child);
                },
                (info) => {
                    failure = info;
                },
            );
            if (!current()) return;
            const elapsedMs = Date.now() - jobStartedAt;
            if (!stats) {
                const info = failure as ProbeFailure | null;
                diagnostics?.event('keyframe-probe-failed', {
                    pipelineId,
                    protocol,
                    reason: info?.reason ?? 'unknown',
                    elapsedMs,
                    exitCode: info?.exitCode ?? null,
                    signal: info?.signal ?? null,
                    stderrTail: info?.stderrTail ?? '',
                });
                console.warn(
                    `[probe] pipeline ${pipelineId} (${protocol}) keyframe check failed: ${info?.reason ?? 'unknown'} after ${elapsedMs}ms; no keyframe interval for this publisher`,
                );
                return;
            }
            keyframeResults.set(pipelineId, { ...stats, checkedAt: Date.now() });
            const tooLong = keyframeIntervalTooLong(stats);
            diagnostics?.event('keyframe-interval', {
                pipelineId,
                protocol,
                keyframes: stats.keyframes,
                meanGapSec: stats.meanGapSec,
                maxGapSec: stats.maxGapSec,
                spanSec: stats.spanSec,
                windowSec: stats.windowSec,
                tooLong,
                elapsedMs,
            });
            if (tooLong) {
                try {
                    db.appendPipelineLog(
                        pipelineId,
                        'keyframe_interval',
                        `Keyframes are too far apart: ${keyframeSummary(stats)}`,
                    );
                } catch {
                    /* non-critical */
                }
            }
        } catch (err) {
            // This runs detached, so a rejection would have no handler.
            console.error(
                `[probe] pipeline ${pipelineId} (${protocol}) keyframe check handling failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        } finally {
            // Only this publisher's child: a new publisher may already have its own.
            if (current()) keyframeChildren.delete(pipelineId);
        }
    }

    async function runScheduledFfprobe(
        pipelineId: number,
        url: string,
        protocol: InputProtocol,
        generation: number,
    ): Promise<void> {
        timers.delete(pipelineId);
        inFlight.add(pipelineId);
        const probeStartedAt = Date.now();
        startedAt.set(pipelineId, probeStartedAt);
        try {
            let failure: ProbeFailure | null = null;
            const result = await runners.runFfprobe(
                url,
                (child) => {
                    children.set(pipelineId, child);
                },
                (info) => {
                    failure = info;
                },
            );
            if (generationOf(pipelineId) !== generation) return;
            const ok = isProbeUsable(result);
            const checkedAt = Date.now();
            const previousFailures = results.get(pipelineId)?.failedAttempts ?? 0;
            const error = ok ? null : probeError(result, checkedAt);
            results.set(pipelineId, {
                result,
                startedAt: probeStartedAt,
                checkedAt,
                ok,
                error,
                failedAttempts: ok ? 0 : previousFailures + 1,
            });
            if (ok && result) onUsableProbe(pipelineId, result);
            recordProbeOutcome(pipelineId, protocol, {
                ok,
                previousFailures,
                error,
                failure,
                elapsedMs: checkedAt - probeStartedAt,
            });
        } catch (err) {
            // This runs from a timer, so a rejection would have no handler
            // and would crash the process.
            console.error(
                `[probe] pipeline ${pipelineId} (${protocol}) probe handling failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        } finally {
            inFlight.delete(pipelineId);
            startedAt.delete(pipelineId);
            children.delete(pipelineId);
        }
    }

    function scheduleFfprobe(
        pipelineId: number,
        streamKey: string,
        protocol: InputProtocol,
        delayMs: number,
    ): void {
        const url = inputPullUrl(streamKey, protocol);
        const generation = generationOf(pipelineId);
        const timer = setTimeout(
            () => void runScheduledFfprobe(pipelineId, url, protocol, generation),
            delayMs,
        );
        timers.set(pipelineId, timer);
        timer.unref?.();
    }

    return {
        ensure(pipelineId, streamKey, protocol, stagger) {
            const status = results.get(pipelineId);
            if (
                !timers.has(pipelineId) &&
                !inFlight.has(pipelineId) &&
                !status?.ok &&
                !(status && Date.now() - status.checkedAt < FFPROBE_FAILED_REFRESH_MS)
            ) {
                scheduleFfprobe(pipelineId, streamKey, protocol, stagger * FFPROBE_STAGGER_MS);
            }
            // Queues the keyframe check once the first successful probe is old enough.
            if (stopped || keyframeScheduled.has(pipelineId)) return;
            if (!status?.ok || Date.now() - status.checkedAt < KEYFRAME_DELAY_MS) return;
            queueKeyframeProbe({
                pipelineId,
                url: inputPullUrl(streamKey, protocol),
                protocol,
                generation: generationOf(pipelineId),
            });
        },

        clear,

        keepOnly(activePipelineIds) {
            const known = new Set<number>([
                ...results.keys(),
                ...timers.keys(),
                ...inFlight,
                ...keyframeScheduled,
                ...keyframeResults.keys(),
            ]);
            for (const pipelineId of known) {
                if (!activePipelineIds.has(pipelineId)) clear(pipelineId);
            }
        },

        status: (pipelineId) => results.get(pipelineId) ?? null,

        keyframes: (pipelineId) => keyframeResults.get(pipelineId) ?? null,

        inFlightSince: (pipelineId) =>
            inFlight.has(pipelineId) ? (startedAt.get(pipelineId) ?? null) : null,

        shutdown() {
            stopped = true;
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
            inFlight.clear();
            startedAt.clear();
            for (const child of children.values()) killIfRunning(child);
            children.clear();
            for (const child of keyframeChildren.values()) killIfRunning(child);
            keyframeChildren.clear();
            keyframeScheduled.clear();
            keyframeQueue.length = 0;
        },
    };
}
