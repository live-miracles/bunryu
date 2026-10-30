// "Log the first one, count the rest": for a message that can repeat every second
// (a refused publish the relay retries, a failing reconcile), one log line per key
// per interval, with the held-back attempts counted so totals stay exact.
export interface LogThrottleOptions {
    intervalMs: number;
    // How long an idle key is remembered. Defaults to one interval.
    retentionMs?: number;
    // When a new key arrives with this many tracked, all are forgotten first, so a
    // flood of distinct (attacker-influenced) keys cannot grow the map without bound.
    maxKeys?: number;
}

export interface LogThrottle {
    // Whether to log this attempt now, and how many attempts since the last log line
    // were held back (to put on this one).
    note(key: string, now: number): { shouldLog: boolean; suppressed: number };
    // Counts that no later attempt reported: keys whose interval ended with attempts
    // still held back. Each count is returned once. Also forgets keys idle past the
    // retention. Call it periodically.
    flush(now: number): { key: string; suppressed: number }[];
}

export function createLogThrottle({
    intervalMs,
    retentionMs = intervalMs,
    maxKeys,
}: LogThrottleOptions): LogThrottle {
    const states = new Map<string, { at: number; suppressed: number }>();
    return {
        note(key, now) {
            const state = states.get(key);
            if (state && now - state.at < intervalMs) {
                state.suppressed++;
                return { shouldLog: false, suppressed: state.suppressed };
            }
            if (!state && maxKeys !== undefined && states.size >= maxKeys) states.clear();
            states.set(key, { at: now, suppressed: 0 });
            return { shouldLog: true, suppressed: state?.suppressed ?? 0 };
        },
        flush(now) {
            const unreported: { key: string; suppressed: number }[] = [];
            for (const [key, state] of states) {
                if (state.suppressed > 0 && now - state.at >= intervalMs) {
                    unreported.push({ key, suppressed: state.suppressed });
                    state.suppressed = 0;
                }
                if (now - state.at > retentionMs) states.delete(key);
            }
            return unreported;
        },
    };
}
