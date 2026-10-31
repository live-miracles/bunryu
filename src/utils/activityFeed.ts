import type { OutputErrorRecord, PipelineLog } from '../types.js';
import type { SrsEvent } from '../services/health.js';

// One line of the dashboard's Events table: what happened, newest first, across every
// pipeline. Built on request from what is already stored (pipeline log lines, output
// History, Server events); nothing is written for it.
export interface ActivityEvent {
    ts: number;
    source: 'input' | 'output' | 'server';
    severity: 'error' | 'warning' | 'ok' | 'info';
    pipelineId: number | null;
    pipelineName: string | null;
    outputName: string | null;
    // Short tag of the event type, shown as a badge ("offline", "crash", "SRS").
    label: string;
    message: string;
}

export interface OutputHistory {
    id: string;
    pipelineId: number;
    name: string;
    history: OutputErrorRecord[];
}

export const DEFAULT_EVENTS_LIMIT = 50;
export const MAX_EVENTS_LIMIT = 200;

// A request's `limit`: a whole number from 1 to MAX_EVENTS_LIMIT, else the default.
export function parseEventsLimit(raw: unknown): number {
    const n = typeof raw === 'string' && /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n < 1) return DEFAULT_EVENTS_LIMIT;
    return Math.min(n, MAX_EVENTS_LIMIT);
}

const PIPELINE_EVENT_SEVERITY: Record<string, ActivityEvent['severity']> = {
    online: 'ok',
    probe_recovered: 'ok',
    offline: 'warning',
    keyframe_interval: 'warning',
    probe_failed: 'error',
    relay_error: 'error',
};

const SERVER_SOURCE_LABEL: Record<SrsEvent['source'], string> = {
    srs: 'SRS',
    relay: 'Goryu',
    host: 'Host',
};

function outputEvents(output: OutputHistory, pipelineName: string): ActivityEvent[] {
    const base = {
        source: 'output' as const,
        pipelineId: output.pipelineId,
        pipelineName,
        outputName: output.name,
    };
    const events: ActivityEvent[] = [];
    for (const record of output.history) {
        // A repeated crash is one record; its time is the latest of them.
        const ts = record.lastTs ?? record.ts;
        if (record.kind === 'crash') {
            const times = record.count && record.count > 1 ? ` (${record.count} times)` : '';
            events.push({
                ...base,
                ts,
                severity: 'error',
                label: 'crash',
                message: `${record.message}${times}`,
            });
            if (record.recoveredTs !== undefined) {
                events.push({
                    ...base,
                    ts: record.recoveredTs,
                    severity: 'ok',
                    label: 'recovered',
                    message: 'Running steadily again',
                });
            }
        } else if (record.kind === 'warning') {
            events.push({
                ...base,
                ts,
                severity: 'warning',
                label: 'warning',
                message: record.message,
            });
        } else if (record.kind === 'started') {
            events.push({
                ...base,
                ts,
                severity: 'info',
                label: 'started',
                message: record.message,
            });
        } else {
            // A stop after repeated failed attempts is a failure; any other stop is a decision.
            events.push({
                ...base,
                ts,
                severity: record.failedAttempts ? 'error' : 'info',
                label: 'stopped',
                message: record.message,
            });
        }
    }
    return events;
}

export function buildActivityFeed(input: {
    pipelines: { id: number; name: string }[];
    pipelineLogs: PipelineLog[];
    outputHistories: OutputHistory[];
    serverEvents: SrsEvent[];
    limit: number;
}): ActivityEvent[] {
    const names = new Map(input.pipelines.map((p) => [p.id, p.name]));
    const events: ActivityEvent[] = [];

    for (const log of input.pipelineLogs) {
        const pipelineName = names.get(log.pipelineId);
        if (pipelineName === undefined) continue;
        events.push({
            ts: log.ts,
            source: 'input',
            severity: PIPELINE_EVENT_SEVERITY[log.event] ?? 'info',
            pipelineId: log.pipelineId,
            pipelineName,
            outputName: null,
            label: log.event,
            message: log.message,
        });
    }

    for (const output of input.outputHistories) {
        const pipelineName = names.get(output.pipelineId);
        if (pipelineName === undefined) continue;
        events.push(...outputEvents(output, pipelineName));
    }

    for (const e of input.serverEvents) {
        events.push({
            ts: e.ts,
            source: 'server',
            severity: e.type === 'recovered' ? 'ok' : 'error',
            pipelineId: null,
            pipelineName: null,
            outputName: null,
            label: SERVER_SOURCE_LABEL[e.source],
            message: e.message,
        });
    }

    // Array.prototype.sort is stable, so events with the same time keep their source order.
    return events.sort((a, b) => b.ts - a.ts).slice(0, input.limit);
}
