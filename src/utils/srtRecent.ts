import type { SrtRelayStreamStatus } from '../services/srtRelay.js';

export const SRT_RECENT_WINDOW_MS = 10 * 60 * 1000;
// Polls come every 5 s. A longer silence means the link was gone, and its
// counters may have restarted from zero without ever visibly decreasing.
const MAX_POLL_GAP_MS = 30_000;
// A window needs two polls to say anything.
const MIN_SPAN_MS = 5_000;

// What an SRT link's cumulative counters grew by over the last `spanMs` (up to
// SRT_RECENT_WINDOW_MS; less right after the link connected). A counter the
// relay does not report for this link is null.
export interface SrtRecent {
    spanMs: number;
    packets: number | null;
    loss: number | null;
    retrans: number | null;
    drop: number | null;
}

type Counters = [
    packets: number | null,
    loss: number | null,
    retrans: number | null,
    drop: number | null,
];

// Cumulative totals polled over time; the difference between the newest and the
// oldest poll inside the window is the window's count.
class CounterWindow {
    private samples: Array<{ ts: number; counters: Counters }> = [];

    push(ts: number, counters: Counters): void {
        const last = this.samples.at(-1);
        if (
            last &&
            (ts - last.ts > MAX_POLL_GAP_MS ||
                counters.some((value, i) => {
                    const before = last.counters[i];
                    return value !== null && before !== null && value < before;
                }))
        ) {
            this.samples = [];
        }
        this.samples.push({ ts, counters });
        // Keep one poll at or before the window's start as the baseline.
        while (this.samples.length > 1 && this.samples[1].ts <= ts - SRT_RECENT_WINDOW_MS) {
            this.samples.shift();
        }
    }

    lastTs(): number {
        return this.samples.at(-1)?.ts ?? 0;
    }

    recent(): SrtRecent | null {
        const first = this.samples[0];
        const last = this.samples.at(-1);
        if (!first || !last || last.ts - first.ts < MIN_SPAN_MS) return null;
        const grew = (i: number): number | null => {
            const from = first.counters[i];
            const to = last.counters[i];
            return from === null || to === null ? null : to - from;
        };
        return {
            spanMs: last.ts - first.ts,
            packets: grew(0),
            loss: grew(1),
            retrans: grew(2),
            drop: grew(3),
        };
    }
}

export interface SrtRecentStats {
    input: SrtRecent | null;
    output: SrtRecent | null;
    // Keyed by leg IP: a leg's port changes when its sender reconnects.
    legs: Map<string, SrtRecent | null>;
}

interface PipelineWindows {
    input: CounterWindow;
    output: CounterWindow;
    legs: Map<string, CounterWindow>;
}

// Rolling counters behind the "last 10 minutes" loss / retransmit / drop figures.
// Totals since the stream connected hide a bad quarter hour inside a long
// session, so the dashboard shows what happened lately instead.
export function createSrtRecentTracker() {
    const pipelines = new Map<number, PipelineWindows>();

    function update(pipelineId: number, now: number, status: SrtRelayStreamStatus): SrtRecentStats {
        let windows = pipelines.get(pipelineId);
        if (!windows) {
            windows = { input: new CounterWindow(), output: new CounterWindow(), legs: new Map() };
            pipelines.set(pipelineId, windows);
        }
        const { input, output } = status;
        if (status.inputActive) {
            windows.input.push(now, [
                input.recvUniquePacketsTotal,
                input.recvLossTotal,
                input.retransTotal,
                input.recvDropTotal,
            ]);
        } else {
            windows.input = new CounterWindow();
        }
        if (status.outputConnected) {
            windows.output.push(now, [
                output.sentPacketsTotal,
                output.sendLossTotal,
                output.retransTotal,
                output.sendDropTotal,
            ]);
        } else {
            windows.output = new CounterWindow();
        }
        const legs = new Map<string, SrtRecent | null>();
        for (const leg of input.legs) {
            let window = windows.legs.get(leg.ip);
            if (!window) {
                window = new CounterWindow();
                windows.legs.set(leg.ip, window);
            }
            window.push(now, [
                leg.recvUniquePacketsTotal ?? leg.recvPacketsTotal,
                leg.recvLossTotal,
                leg.retransTotal,
                leg.recvDropTotal,
            ]);
            legs.set(leg.ip, window.recent());
        }
        // Cellular legs change IP often; one that has been gone longer than the
        // window has nothing left to show.
        for (const [ip, window] of windows.legs) {
            if (now - window.lastTs() > SRT_RECENT_WINDOW_MS) windows.legs.delete(ip);
        }
        return { input: windows.input.recent(), output: windows.output.recent(), legs };
    }

    // Drop the windows of pipelines that no longer exist.
    function keepOnly(pipelineIds: Set<number>): void {
        for (const id of pipelines.keys()) {
            if (!pipelineIds.has(id)) pipelines.delete(id);
        }
    }

    return { update, keepOnly };
}
