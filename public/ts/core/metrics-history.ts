import type { MetricSample } from '../types.js';

// The server keeps two hours of samples (HISTORY_MAX in src/services/resourceUsage.ts), so
// the dashboard keeps no more: a tab left open through a multi-day event would otherwise
// grow, and re-sort, an ever longer array on every poll.
export const METRICS_HISTORY_WINDOW_MS = 2 * 60 * 60 * 1000;

// The samples already held plus those just fetched, by timestamp, oldest first, without
// those older than the window before the newest.
export function mergeMetricSamples(held: MetricSample[], fetched: MetricSample[]): MetricSample[] {
    if (fetched.length === 0) return held;
    const byTimestamp = new Map(held.map((sample) => [sample.ts, sample]));
    for (const sample of fetched) byTimestamp.set(sample.ts, sample);
    const merged = [...byTimestamp.values()].sort((a, b) => a.ts - b.ts);
    const cutoff = merged[merged.length - 1].ts - METRICS_HISTORY_WINDOW_MS;
    return merged.filter((sample) => sample.ts >= cutoff);
}
