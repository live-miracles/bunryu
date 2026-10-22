// Records which bonded legs a pipeline's input has, so the pipeline log and the
// diagnostics show a leg joining or leaving. The relay drops a failed leg from its
// legs[] instead of reporting it broken, so the only way to see a link go is to
// compare the set of legs between polls.
//
// This is a record, not the alert. `bonded-leg-down` counts legs (a cellular leg
// that returns on a new IP would never clear if it tracked addresses); here the
// address is the whole point: it says which link changed.

/** Pipeline-log lines allowed per window. The log keeps only 100 entries per pipeline, so a
 * link that flaps would otherwise push the online/offline history out of it. */
export const LEG_LOG_MAX_PER_WINDOW = 4;
export const LEG_LOG_WINDOW_MS = 60_000;

export interface LegLogState {
    /** `ip:port` of every leg at the last poll. */
    keys: string[];
    windowStartMs: number;
    shown: number;
    suppressed: number;
}

export interface LegChange {
    from: number;
    to: number;
    joined: string[];
    left: string[];
    message: string;
}

export function createLegLogState(keys: string[], now: number): LegLogState {
    return { keys, windowStartMs: now, shown: 0, suppressed: 0 };
}

function list(keys: string[]): string {
    return keys.length > 0 ? keys.join(', ') : 'none';
}

/**
 * What changed between two polls, or null if the same legs are connected. A previous
 * of null means the input just came up, which is reported as the starting set.
 */
export function describeLegChange(previous: string[] | null, current: string[]): LegChange | null {
    if (previous === null) {
        return {
            from: 0,
            to: current.length,
            joined: current,
            left: [],
            message: `Bonded input connected with ${current.length} leg${current.length === 1 ? '' : 's'}: ${list(current)}`,
        };
    }
    const joined = current.filter((key) => !previous.includes(key));
    const left = previous.filter((key) => !current.includes(key));
    if (joined.length === 0 && left.length === 0) return null;
    const head =
        previous.length === current.length
            ? `Bonded legs changed (still ${current.length})`
            : `Bonded legs went from ${previous.length} to ${current.length}`;
    const parts: string[] = [];
    if (left.length > 0) parts.push(`lost ${left.join(', ')}`);
    if (joined.length > 0) parts.push(`joined ${joined.join(', ')}`);
    return {
        from: previous.length,
        to: current.length,
        joined,
        left,
        message: `${head}: ${parts.join('; ')} (now: ${list(current)})`,
    };
}

function rollWindow(state: LegLogState, now: number): void {
    if (now - state.windowStartMs >= LEG_LOG_WINDOW_MS || now < state.windowStartMs) {
        state.windowStartMs = now;
        state.shown = 0;
    }
}

/** Whether one more pipeline-log line fits in this window; counts it as hidden if not. */
export function allowLegLogLine(state: LegLogState, now: number): boolean {
    rollWindow(state, now);
    if (state.shown < LEG_LOG_MAX_PER_WINDOW) {
        state.shown++;
        return true;
    }
    state.suppressed++;
    return false;
}

/**
 * Lines hidden in a window that has ended, once, for a summary line. Call it on every
 * poll, not only when something changed, or the summary of a burst that then goes
 * quiet would never be written.
 */
export function takeSuppressedLegLines(state: LegLogState, now: number): number {
    if (state.suppressed === 0) return 0;
    if (now >= state.windowStartMs && now - state.windowStartMs < LEG_LOG_WINDOW_MS) return 0;
    const n = state.suppressed;
    state.suppressed = 0;
    return n;
}

export function suppressedLegLinesMessage(count: number): string {
    return `${count} more bonded leg change${count === 1 ? '' : 's'} in the last minute not shown here (all are in the diagnostics log)`;
}
