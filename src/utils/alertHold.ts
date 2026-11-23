import type { PipelineAlert } from './srtLinkAlerts.js';

// How long an interval alert stays in the health payload after it was last raised, in polls.
// The SRT interval alerts (dropped packets, loss, latency, ...) are worked out from one 5 s
// poll to the next, so on their own they would be there for one poll and gone: a status that
// turned yellow for 5 s is noise nobody can act on. Held for six polls (30 s) they are a
// status that stays long enough to be seen and does not flicker while the link is still
// bad. The alert's episode in the diagnostics lasts through the hold and then ends after
// its own six quiet polls.
export const SRT_ALERT_HOLD_POLLS = 6;

// Per-pipeline memory of the interval alerts raised lately, keyed by code. `apply` is
// called once per poll with the alerts of that poll and returns every alert still held, the
// latest wording and severity of each. Nothing here is a status: the verdict is read from
// the alerts that come out.
export interface AlertHold {
    apply(alerts: PipelineAlert[]): PipelineAlert[];
    clear(): void;
}

export function createAlertHold(holdPolls: number = SRT_ALERT_HOLD_POLLS): AlertHold {
    const held = new Map<string, { alert: PipelineAlert; quietPolls: number }>();
    return {
        apply(alerts) {
            const raised = new Set<string>();
            for (const alert of alerts) {
                raised.add(alert.code);
                const previous = held.get(alert.code);
                // The episode keeps the time it began, so "since" does not restart on every
                // poll that raises it again.
                held.set(alert.code, {
                    alert: { ...alert, sinceMs: previous?.alert.sinceMs ?? alert.sinceMs },
                    quietPolls: 0,
                });
            }
            const current: PipelineAlert[] = [];
            for (const [code, entry] of held) {
                if (!raised.has(code)) entry.quietPolls += 1;
                if (entry.quietPolls > holdPolls) held.delete(code);
                else current.push(entry.alert);
            }
            return current;
        },
        clear() {
            held.clear();
        },
    };
}
