import type { LegHistoryData } from '../types.js';

// The SRT details modal's leg history: which 30-minute window of a pipeline's legs to
// show, fetched and kept as little as it takes for paging to feel instant. The modal
// asks for a window and draws what comes back. Everything about requests lives here:
// a slow response that a newer request has replaced is dropped, a window already being
// fetched is not fetched twice, the live window grows by new samples instead of being
// fetched whole, and the next older window is fetched ahead.

export const LEG_HISTORY_WINDOW_MS = 30 * 60 * 1000;
export const LEG_HISTORY_PAGE_STEP_MS = 10 * 60 * 1000;
// Older windows are static apart from their newest edge, so one is reused briefly.
const PAGE_TTL_MS = 60 * 1000;

export interface LegHistoryDeps {
    fetch(
        pipelineId: string,
        from: number,
        to: number,
        // Only the samples after this timestamp (the live window's increment).
        after?: number,
    ): Promise<LegHistoryData | null>;
    now(): number;
    // A hidden tab fetches nothing ahead.
    hidden(): boolean;
}

// 'open' loads the window the pipeline was last on, 'older' and 'newer' move it one step,
// and 'poll' is the dashboard's refresh: it reloads the live window and leaves a paged
// one alone, so a slow historical request is not superseded by every poll.
export type LegHistoryRequest = 'open' | 'older' | 'newer' | 'poll';

export interface LegHistoryView {
    // The legs to draw. At the live edge it is everything gathered so far in the window.
    data: LegHistoryData;
    live: boolean;
    hasOlder: boolean;
    hasNewer: boolean;
}

export type LegHistoryOutcome =
    | { status: 'ok'; view: LegHistoryView }
    | { status: 'failed' }
    // A newer request replaced this one: leave the screen to it.
    | { status: 'superseded' };

export interface LegHistoryLoad {
    // True when the window must come over the network, so a screen can show it is loading.
    waiting: boolean;
    outcome: Promise<LegHistoryOutcome>;
}

export interface LegHistory {
    // null when there is nothing to do: that window is already being fetched, or a poll
    // arrived while the pipeline is paged.
    load(pipelineId: string, request: LegHistoryRequest): LegHistoryLoad | null;
}

export function createLegHistory(deps: LegHistoryDeps): LegHistory {
    const offsets = new Map<string, number>();
    // The live window as gathered so far, per pipeline.
    const live = new Map<string, LegHistoryData>();
    const requestIds = new Map<string, number>();
    const inFlight = new Set<string>();
    const pages = new Map<string, { data: LegHistoryData; fetchedAt: number }>();
    const prefetching = new Set<string>();

    const pageKey = (pipelineId: string, offset: number): string => `${pipelineId}:${offset}`;

    function freshPage(pipelineId: string, offset: number): LegHistoryData | undefined {
        if (offset === 0) return undefined;
        const entry = pages.get(pageKey(pipelineId, offset));
        return entry && deps.now() - entry.fetchedAt < PAGE_TTL_MS ? entry.data : undefined;
    }

    // Adds the samples just fetched to the live window and drops those older than it.
    function mergeLive(
        pipelineId: string,
        data: LegHistoryData,
        from: number,
        to: number,
    ): LegHistoryData {
        const cached = live.get(pipelineId);
        if (!cached) {
            live.set(pipelineId, data);
            return data;
        }

        // The relay identifies a leg by source IP. Its port can change when the
        // sender reconnects, so including the port here would split one source
        // into multiple chart series and colors.
        const incomingByKey = new Map(data.legs.map((leg) => [leg.ip, leg]));
        const cachedByKey = new Map(cached.legs.map((leg) => [leg.ip, leg]));
        const keys = new Set([...cachedByKey.keys(), ...incomingByKey.keys()]);
        const legs = [...keys].map((key) => {
            const previous = cachedByKey.get(key);
            const incoming = incomingByKey.get(key);
            const samplesByTimestamp = new Map(
                (previous?.samples ?? []).map((sample) => [sample.ts, sample]),
            );
            for (const sample of incoming?.samples ?? []) samplesByTimestamp.set(sample.ts, sample);
            return {
                ip: incoming?.ip ?? previous!.ip,
                port: incoming?.port ?? previous!.port,
                samples: [...samplesByTimestamp.values()]
                    .filter((sample) => sample.ts >= from && sample.ts <= to)
                    .sort((a, b) => a.ts - b.ts),
            };
        });
        const merged = { ...data, from, to, legs };
        live.set(pipelineId, merged);
        return merged;
    }

    // Best-effort: a failed prefetch is tolerated on purpose. The page simply
    // isn't cached, so the next click does the normal fetch and reports its own
    // failure if that also fails.
    async function prefetch(pipelineId: string, offset: number): Promise<void> {
        const key = pageKey(pipelineId, offset);
        if (deps.hidden() || prefetching.has(key) || freshPage(pipelineId, offset)) return;
        prefetching.add(key);
        try {
            const to = deps.now() - offset;
            const data = await deps.fetch(pipelineId, to - LEG_HISTORY_WINDOW_MS, to);
            if (!data) return;
            const now = deps.now();
            for (const [k, entry] of pages) {
                if (now - entry.fetchedAt >= PAGE_TTL_MS) pages.delete(k);
            }
            pages.set(key, { data, fetchedAt: now });
        } catch {
            // See above: tolerated, falls back to an on-demand fetch.
        } finally {
            prefetching.delete(key);
        }
    }

    function load(pipelineId: string, request: LegHistoryRequest): LegHistoryLoad | null {
        const current = offsets.get(pipelineId) ?? 0;
        if (request === 'poll' && current !== 0) return null;
        const offset =
            request === 'older'
                ? current + LEG_HISTORY_PAGE_STEP_MS
                : request === 'newer'
                  ? Math.max(0, current - LEG_HISTORY_PAGE_STEP_MS)
                  : current;
        offsets.set(pipelineId, offset);

        const requestKey = pageKey(pipelineId, offset);
        if (inFlight.has(requestKey)) return null;
        inFlight.add(requestKey);

        const requestId = (requestIds.get(pipelineId) ?? 0) + 1;
        requestIds.set(pipelineId, requestId);
        const isCurrent = (): boolean => requestIds.get(pipelineId) === requestId;
        const to = deps.now() - offset;
        const from = to - LEG_HISTORY_WINDOW_MS;
        const prefetched = freshPage(pipelineId, offset);
        const cached = offset === 0 ? live.get(pipelineId) : undefined;
        const cachedTimestamps =
            cached?.legs.flatMap((leg) => leg.samples.map((sample) => sample.ts)) ?? [];
        const latestCachedTs =
            cachedTimestamps.length > 0 ? Math.max(...cachedTimestamps) : undefined;

        const outcome = (async (): Promise<LegHistoryOutcome> => {
            try {
                const data = prefetched ?? (await deps.fetch(pipelineId, from, to, latestCachedTs));
                if (!isCurrent()) return { status: 'superseded' };
                if (!data) return { status: 'failed' };
                if (offset > 0 && !prefetched) {
                    pages.set(requestKey, { data, fetchedAt: deps.now() });
                }
                const shown = offset === 0 ? mergeLive(pipelineId, data, from, to) : data;
                const hasOlder = data.oldestTs !== null && data.from > data.oldestTs;
                if (hasOlder) void prefetch(pipelineId, offset + LEG_HISTORY_PAGE_STEP_MS);
                return {
                    status: 'ok',
                    view: { data: shown, live: offset === 0, hasOlder, hasNewer: offset > 0 },
                };
            } catch {
                return { status: isCurrent() ? 'failed' : 'superseded' };
            } finally {
                inFlight.delete(requestKey);
            }
        })();
        return { waiting: prefetched === undefined, outcome };
    }

    return { load };
}
