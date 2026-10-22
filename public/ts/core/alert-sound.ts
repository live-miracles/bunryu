import type { PipelineView } from '../types.js';

// Which changes between two dashboard polls deserve a beep. Only a problem that
// is new since the last poll beeps; one that persists stays silent, so the sound
// marks the moment something went wrong and the dashboard shows the rest.

// A crash this soon after the same output's previous one belongs to the same
// failing episode (the retry loop), so it does not beep again. Same window as
// the server's STABLE_RUN_MS, after which a run counts as recovered.
export const CRASH_EPISODE_MS = 60_000;

// Volume is in percent of a comfortable base level, like live-gallery's alert
// beeps: 100 is the default and the slider goes up to 500.
export const ALERT_VOLUME_DEFAULT = 100;
export const ALERT_VOLUME_MAX = 500;

export interface AttentionSnapshot {
    serverUnreachable: boolean;
    srsReachable: boolean | undefined;
    relayDown: boolean;
    pipelines: PipelineView[];
}

export interface AttentionState {
    // Conditions that held in the previous snapshot.
    conditions: Set<string>;
    // The latest crash record seen per output (its timestamp).
    lastCrashAt: Map<string, number>;
}

// Conditions that need an operator while they last: the server or SRS is
// unreachable, the SRT relay is down, a pipeline has an error-level alert, or an
// input is offline while its outputs are meant to be running.
export function attentionConditions(snapshot: AttentionSnapshot): Set<string> {
    const conditions = new Set<string>();
    if (snapshot.serverUnreachable) conditions.add('server-unreachable');
    if (snapshot.srsReachable === false) conditions.add('srs-unreachable');
    if (snapshot.relayDown) conditions.add('relay-down');
    for (const pipeline of snapshot.pipelines) {
        for (const alert of pipeline.alerts) {
            if (alert.severity === 'error') conditions.add(`alert:${pipeline.id}:${alert.code}`);
        }
        const wanted = pipeline.outs.some((out) => out.desiredState === 'running');
        if (wanted && !pipeline.input.live) conditions.add(`input-offline:${pipeline.id}`);
    }
    return conditions;
}

// Returns what is new since `prev` (empty for the first snapshot, which only
// sets the baseline) and the state to pass next time. An output that crashed,
// whether FFmpeg exited or a watchdog restarted it, counts as new once per
// failing episode; a stop by the operator leaves no current crash record.
export function newAttention(
    prev: AttentionState | null,
    snapshot: AttentionSnapshot,
): { state: AttentionState; fresh: string[] } {
    const conditions = attentionConditions(snapshot);
    const lastCrashAt = new Map<string, number>();
    const fresh: string[] = [];
    for (const condition of conditions) {
        if (prev && !prev.conditions.has(condition)) fresh.push(condition);
    }
    for (const pipeline of snapshot.pipelines) {
        for (const out of pipeline.outs) {
            if (out.desiredState !== 'running' || out.lastError === null) continue;
            if (out.lastErrorAt === null) continue;
            lastCrashAt.set(out.id, out.lastErrorAt);
            if (!prev) continue;
            const before = prev.lastCrashAt.get(out.id);
            if (before === out.lastErrorAt) continue;
            if (before === undefined || out.lastErrorAt - before >= CRASH_EPISODE_MS) {
                fresh.push(`output-crash:${out.id}`);
            }
        }
    }
    return { state: { conditions, lastCrashAt }, fresh };
}

export function clampAlertVolume(value: number): number {
    if (!Number.isFinite(value)) return ALERT_VOLUME_DEFAULT;
    return Math.max(0, Math.min(ALERT_VOLUME_MAX, Math.round(value)));
}
