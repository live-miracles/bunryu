import type { Output } from '../types.js';
import { encodeRecipe, isRenditionUrl, recipeOfRendition } from './renditions.js';

// What state an output is in and why: the one place these rules live. The verdict they give
// (dot colour, Issues text) goes to the dashboard in /api/health (healthVerdicts.ts), and
// `reportedState` below turns it into what the Key Vault reporter sends. The dashboard has
// no copy; the few values it repeats for display are pinned in test/statusConstants.test.js.

// The dashboard repeats this one (LOW_BITRATE_KBPS in public/ts/core/utils.ts) for badges.
const LOW_BITRATE_KBPS = 200;

export type OutStatus = 'good' | 'warn' | 'error' | 'off';

// The part of a health snapshot's per-output entry (HealthSnapshot) that decides the status.
export interface OutputHealthEntry {
    status: string;
    bitrateKbps: number | null;
    startedAtMs: number | null;
    failures: number;
    warningReason: string | null;
    warningSinceMs: number | null;
    lastError: string | null;
    renditionId: string | null;
    ready: boolean | null;
}

// One output as the dashboard's OutputView sees it (core/pipeline.ts parsePipelines).
export interface OutputStatusView {
    id: string;
    name: string;
    url: string;
    desiredState: 'running' | 'stopped';
    videoEncoding: string;
    audioEncoding: string;
    status: 'running' | 'stopped' | 'failed';
    bitrateKbps: number | null;
    startedAtMs: number | null;
    failures: number;
    warningReason: string | null;
    warningSinceMs: number | null;
    // The message part of the stored "<ts_ms>\n<message>", and its time.
    lastError: string | null;
    lastErrorAt: number | null;
    renditionId: string | null;
    ready: boolean | null;
    // Your outputs: the shared encode (rendition row) this one pulls, if any.
    sharedEncode: OutputStatusView | null;
}

export interface OutputIssue {
    severity: 'warning' | 'error';
    message: string;
}

// last_error is stored as "<ts_ms>\n<message>".
function parseLastError(raw: string | null): { message: string; ts: number } | null {
    if (!raw) return null;
    const nl = raw.indexOf('\n');
    if (nl === -1) return { message: raw, ts: 0 };
    const ts = parseInt(raw.slice(0, nl), 10);
    return { message: raw.slice(nl + 1), ts: isNaN(ts) ? 0 : ts };
}

// The outputs grouped by the pipeline they belong to.
export function outputsByPipeline(outputs: readonly Output[]): Map<number, Output[]> {
    const byPipeline = new Map<number, Output[]>();
    for (const output of outputs) {
        const list = byPipeline.get(output.pipelineId);
        if (list) list.push(output);
        else byPipeline.set(output.pipelineId, [output]);
    }
    return byPipeline;
}

// The outputs of one pipeline as views, each linked to the shared encode it pulls
// (the same rule as parsePipelines). `health` is the pipeline's outputs entry of the
// health snapshot; an output with none is stopped. Rendition rows are included,
// which is how an output finds its encode; use isRenditionUrl to leave them out.
export function buildOutputViews(
    outputs: readonly Output[],
    health: Record<string, OutputHealthEntry> | undefined,
): OutputStatusView[] {
    const views: OutputStatusView[] = outputs.map((o) => {
        const oh = health?.[o.id];
        const err = parseLastError(oh !== undefined ? oh.lastError : o.lastError);
        return {
            id: o.id,
            name: o.name,
            url: o.url,
            desiredState: o.desiredState,
            videoEncoding: o.videoEncoding,
            audioEncoding: o.audioEncoding,
            status: (oh?.status as OutputStatusView['status'] | undefined) ?? 'stopped',
            bitrateKbps: oh?.bitrateKbps ?? null,
            startedAtMs: oh?.startedAtMs ?? null,
            failures: oh?.failures ?? 0,
            warningReason: oh?.warningReason ?? null,
            warningSinceMs: oh?.warningSinceMs ?? null,
            lastError: err?.message ?? null,
            lastErrorAt: err?.ts ?? null,
            renditionId: oh?.renditionId ?? null,
            ready: oh?.ready ?? null,
            sharedEncode: null,
        };
    });
    const renditions = views.filter((o) => isRenditionUrl(o.url));
    const byKey = new Map(renditions.map((r) => [recipeOfRendition(r).key, r]));
    for (const o of views) {
        if (isRenditionUrl(o.url)) continue;
        const key = encodeRecipe(o)?.key;
        const rendition = key ? byKey.get(key) : undefined;
        if (!rendition) continue;
        // An output that started while it was alone with its recipe runs direct
        // until it next starts; it only reads the encode once health says so.
        if (o.status === 'running' && o.renditionId !== rendition.id) continue;
        o.sharedEncode = rendition;
    }
    return views;
}

function lastErrorLine(output: OutputStatusView): string {
    return (
        (output.lastError ?? '')
            .split('\n')
            .filter((line) => line.trim())
            .slice(-1)[0] ?? ''
    );
}

// The last line of the output's current error, or '' when it has none (a stopped
// output keeps one only when it was stopped after repeated failed attempts).
export function currentErrorLine(output: OutputStatusView): string {
    if (!output.lastError || output.lastErrorAt === null) return '';
    return lastErrorLine(output);
}

// True while the most recent error belongs to what is happening now, not to an
// earlier run (see hasCurrentError in public/ts/core/status.ts for the reasoning).
export function hasCurrentError(o: OutputStatusView): boolean {
    if (o.lastError === null || o.lastErrorAt === null) return false;
    if (o.startedAtMs === null) return o.failures > 0;
    return o.lastErrorAt >= o.startedAtMs;
}

export function summarizeOutputError(error: string | null | undefined, fallback: string): string {
    if (!error) return fallback;

    const lastLine =
        error
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .pop() ?? '';
    if (!lastLine) return fallback;

    const singleLine = lastLine.replace(/\s+/g, ' ');
    return singleLine.length > 160 ? `${singleLine.slice(0, 157)}...` : singleLine;
}

// An output that pulls a shared encode which is not up yet is waiting, not failing.
export function sharedEncodeIssue(output: OutputStatusView): OutputIssue | null {
    const rendition = output.sharedEncode;
    if (!rendition || output.desiredState !== 'running' || output.status === 'running') {
        return null;
    }
    if (rendition.ready) return null;
    if (rendition.status === 'failed' || hasCurrentError(rendition)) {
        const line = lastErrorLine(rendition);
        return {
            severity: 'warning',
            message: line ? `Shared encode failed: ${line}` : 'Shared encode failed.',
        };
    }
    return { severity: 'warning', message: `Waiting for ${rendition.name}` };
}

// `includeInput` false leaves out "the input is not live", which a shared encode's status
// shows on its own side of the dot.
export function outputHealth(
    o: OutputStatusView,
    input: { live: boolean },
    includeInput = true,
): { status: OutStatus; issues: OutputIssue[] } {
    if (o.desiredState === 'stopped') return { status: 'off', issues: [] };

    const sharedIssue = sharedEncodeIssue(o);
    if (sharedIssue) return { status: 'warn', issues: [sharedIssue] };

    const withFailures = (message: string): string =>
        o.failures > 0
            ? `${o.failures} error${o.failures === 1 ? '' : 's'} since last start. ${message}`
            : message;
    const error = (message: string): { status: OutStatus; issues: OutputIssue[] } => ({
        status: 'error',
        issues: [{ severity: 'error', message: withFailures(message) }],
    });
    const warn = (message: string): { status: OutStatus; issues: OutputIssue[] } => ({
        status: 'warn',
        issues: [{ severity: 'warning', message }],
    });

    if (o.status === 'failed') {
        return error(summarizeOutputError(o.lastError, 'Output process failed.'));
    }

    if (o.status === 'running') {
        if (includeInput && !input.live) return warn('Output is running but input is not live.');
        if (o.warningReason !== null) return warn(o.warningReason);
        if (o.bitrateKbps !== null && o.bitrateKbps >= LOW_BITRATE_KBPS) {
            return { status: 'good', issues: [] };
        }
        if (o.bitrateKbps === null && hasCurrentError(o)) {
            return error(
                summarizeOutputError(o.lastError, 'Output has no bitrate after an error.'),
            );
        }
        if (o.bitrateKbps === null)
            return warn('Output is running but no bitrate is reported yet.');
        return warn(`Output bitrate is below ${LOW_BITRATE_KBPS} kb/s.`);
    }

    // status === 'stopped' but desiredState === 'running': between retries
    if (hasCurrentError(o)) {
        return error(summarizeOutputError(o.lastError, 'Output failed and is waiting to retry.'));
    }
    return warn('Output is waiting to start or retry.');
}

export type ReportedStatus = 'running' | 'warning' | 'error' | 'stopped';

export interface ReportedState {
    status: ReportedStatus;
    // Why, in one line, unredacted: it is the output's own error or warning text.
    message: string;
    // A stop after repeated failed attempts: an error that stays until the output is started again.
    stoppedAfterFailures: boolean;
}

// The state the Key Vault reporter sends. The dashboard's "Problems" rule
// (outputProblem in public/ts/core/problems.ts) without its advisory
// warnings (a destination shared with another output, encoding advice): those are
// about the configuration, not about whether the stream is being delivered.
export function reportedState(o: OutputStatusView, input: { live: boolean }): ReportedState {
    if (o.desiredState === 'stopped') {
        // Only a stop after repeated failures keeps its error while stopped.
        return currentErrorLine(o)
            ? {
                  status: 'error',
                  message: summarizeOutputError(o.lastError, 'Stopped after repeated failures.'),
                  stoppedAfterFailures: true,
              }
            : { status: 'stopped', message: '', stoppedAfterFailures: false };
    }
    const health = outputHealth(o, input);
    if (health.status === 'error' || currentErrorLine(o)) {
        return {
            status: 'error',
            message:
                health.status === 'error'
                    ? health.issues[0].message
                    : summarizeOutputError(o.lastError, 'Output has an unresolved error.'),
            stoppedAfterFailures: false,
        };
    }
    if (health.status === 'warn') {
        return {
            status: 'warning',
            message: health.issues[0].message,
            stoppedAfterFailures: false,
        };
    }
    return { status: 'running', message: '', stoppedAfterFailures: false };
}
