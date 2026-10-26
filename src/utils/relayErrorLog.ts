// Records the error Goryu keeps for a stream (`lastError`) in the pipeline log. Goryu
// holds only the latest one and drops it when the session ends, so without this it is
// gone by the time anyone looks.
//
// A stream that cannot publish downstream (say SRS rejects its key) retries forever
// on a 1-16 s backoff and sets the error again each time, with a different "retrying
// in N ms" and, for input errors, a different peer port. Those would fill the log
// (100 entries per pipeline), so a repeat of the same error within
// RELAY_ERROR_MERGE_WINDOW_MS of its last occurrence updates one line with a count.

export const RELAY_ERROR_MERGE_WINDOW_MS = 10 * 60 * 1000;
// An error already held when the dashboard first looks was most likely logged before
// it restarted; only one this fresh is new.
export const RELAY_ERROR_FRESH_MS = 30 * 1000;
// Diagnostics get the first occurrence and then at most one repeat a minute.
export const RELAY_ERROR_DIAGNOSTICS_INTERVAL_MS = 60 * 1000;

/** The error as shown: without the changing retry delay and the stream id, which holds the key. */
export function relayErrorText(message: string): string {
    return message
        .replace(/;?\s*retrying in \d+ ms/g, '')
        .replace(/\s+streamid=\S+?:(?=\s)/g, ':')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Two occurrences of one failure have the same signature: ports (a reconnecting peer's changes every time) are masked. */
export function relayErrorSignature(message: string): string {
    return relayErrorText(message).replace(/:\d{2,5}\b/g, ':*');
}

function spanLabel(ms: number): string {
    return ms >= 90_000
        ? `${Math.round(ms / 60_000)} min`
        : `${Math.max(1, Math.round(ms / 1000))} s`;
}

export interface RelayErrorRecord {
    kind: 'new' | 'repeat';
    /** The pipeline-log line: the error, and once repeated how often and over how long. */
    message: string;
    count: number;
    spanMs: number;
    /** The log row of the first occurrence, to update on a repeat; null if it was never written. */
    logId: number | null;
    /** True when diagnostics should get an event for this occurrence. */
    diagnostics: boolean;
}

interface Episode {
    signature: string;
    count: number;
    firstAt: number;
    lastAt: number;
    logId: number | null;
    diagnosticsAt: number;
}

interface PipelineState {
    seenAt: number | null;
    episode: Episode | null;
}

export function createRelayErrorLog() {
    const pipelines = new Map<number, PipelineState>();

    /** Call every poll with the stream's `lastError` and `lastErrorAt`; returns what to record, if anything. */
    function observe(
        pipelineId: number,
        now: number,
        lastError: string | null,
        lastErrorAt: number | null,
    ): RelayErrorRecord | null {
        const first = !pipelines.has(pipelineId);
        const state = pipelines.get(pipelineId) ?? { seenAt: null, episode: null };
        pipelines.set(pipelineId, state);
        // Goryu clears the error when the session ends; a later occurrence can still merge.
        if (!lastError || !lastErrorAt) {
            state.seenAt = null;
            return null;
        }
        if (lastErrorAt === state.seenAt) return null;
        state.seenAt = lastErrorAt;
        if (first && now - lastErrorAt > RELAY_ERROR_FRESH_MS) return null;

        const text = relayErrorText(lastError);
        const signature = relayErrorSignature(lastError);
        const episode = state.episode;
        if (
            episode &&
            episode.signature === signature &&
            lastErrorAt - episode.lastAt <= RELAY_ERROR_MERGE_WINDOW_MS
        ) {
            episode.count++;
            episode.lastAt = lastErrorAt;
            const spanMs = episode.lastAt - episode.firstAt;
            const diagnostics = now - episode.diagnosticsAt >= RELAY_ERROR_DIAGNOSTICS_INTERVAL_MS;
            if (diagnostics) episode.diagnosticsAt = now;
            return {
                kind: 'repeat',
                message: `${text} (seen ${episode.count} times over ${spanLabel(spanMs)})`,
                count: episode.count,
                spanMs,
                logId: episode.logId,
                diagnostics,
            };
        }
        state.episode = {
            signature,
            count: 1,
            firstAt: lastErrorAt,
            lastAt: lastErrorAt,
            logId: null,
            diagnosticsAt: now,
        };
        return { kind: 'new', message: text, count: 1, spanMs: 0, logId: null, diagnostics: true };
    }

    /** Remember the log row a new record was written to, so repeats can update it. */
    function setLogId(pipelineId: number, logId: number | null): void {
        const episode = pipelines.get(pipelineId)?.episode;
        if (episode) episode.logId = logId;
    }

    function keepOnly(pipelineIds: Set<number>): void {
        for (const id of pipelines.keys()) {
            if (!pipelineIds.has(id)) pipelines.delete(id);
        }
    }

    return { observe, setLogId, keepOnly };
}
