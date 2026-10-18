import {
    STATUS_COLOR_ERROR,
    STATUS_COLOR_GOOD,
    STATUS_COLOR_OFF,
    STATUS_COLOR_WARN,
    escapeHtml,
    formatLocalTime,
} from '../core/utils.js';
import { ICON_HISTORY, ICON_ITERATION_CW, outputMetricsBadge } from './output-badges.js';
import type { InputHealth, OutputView, PipelineView } from '../types.js';

// Shared encodes (renditions): outputs of one pipeline that need the same encode
// share one upstream FFmpeg, a server-managed output row. See
// src/utils/renditions.ts; parsePipelines (core/pipeline.ts) links each output to
// its rendition (`sharedEncode`) and keeps the rows apart in `renditions`.

export const SHARED_ENCODE_RESTART_LOCKOUT_MS = 5000;

type EncodeState = 'idle' | 'failed' | 'running' | 'starting';

function lastErrorLine(output: OutputView): string {
    return (
        (output.lastError ?? '')
            .split('\n')
            .filter((line) => line.trim())
            .slice(-1)[0] ?? ''
    );
}

// Same rule as for an output card (render.ts hasCurrentOutputError): an error
// counts while it belongs to the current run, or while the output waits to retry
// after a real failure.
function hasCurrentError(o: OutputView): boolean {
    if (o.lastError === null || o.lastErrorAt === null) return false;
    if (o.startedAtMs === null) return o.failures > 0;
    return o.lastErrorAt >= o.startedAtMs;
}

function encodeState(rendition: OutputView): EncodeState {
    if (rendition.desiredState === 'stopped') return 'idle';
    if (rendition.status === 'failed') return 'failed';
    if (rendition.status === 'running' && rendition.ready) return 'running';
    return 'starting';
}

// What an output that pulls a shared encode should say while it is not running
// because the encode is not up yet. The output restarts by itself once the
// encode is ready, so this is a warning, not an error.
export function sharedEncodeIssue(
    output: OutputView,
): { severity: 'warning'; message: string } | null {
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
    return { severity: 'warning', message: `Waiting for shared encode ${rendition.name}` };
}

// Badge for an output card that pulls a shared encode, with the encode and its
// state in a tooltip. Empty for outputs that pull the input directly.
export function sharedEncodeBadge(output: OutputView): string {
    const rendition = output.sharedEncode;
    if (!rendition) return '';
    return `<span class="js-tooltip inline-flex shrink-0" tabindex="0"><span class="badge badge-xs badge-info badge-soft whitespace-nowrap">shared</span><div class="js-tooltip-content hidden"><div class="text-xs leading-snug">Pulls <span class="font-semibold">${escapeHtml(rendition.name)}</span> (${encodeState(rendition)}) instead of encoding on its own.</div></div></span>`;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function renderRow(rendition: OutputView, input: InputHealth, deps: SharedEncodeCardDeps): string {
    const isStopped = rendition.desiredState === 'stopped';
    const status = deps.outStatus(rendition, input);
    const statusHex =
        status === 'good'
            ? STATUS_COLOR_GOOD
            : status === 'warn'
              ? STATUS_COLOR_WARN
              : status === 'error'
                ? STATUS_COLOR_ERROR
                : STATUS_COLOR_OFF;
    const uptimeMs = rendition.startedAtMs !== null ? Date.now() - rendition.startedAtMs : null;
    const badges: string[] = [];
    if (uptimeMs !== null) {
        badges.push(
            `<span class="font-mono text-xs opacity-60 whitespace-nowrap">${escapeHtml(deps.formatUptime(uptimeMs))}</span>`,
        );
    }
    badges.push(outputMetricsBadge(rendition));
    const readers = rendition.readers ?? 0;
    badges.push(
        `<span class="badge badge-sm badge-soft whitespace-nowrap" title="Outputs that pull this encode, and clients currently reading it from SRS">${plural(rendition.dependents.length, 'output')} · ${plural(readers, 'reader')}</span>`,
    );
    if (rendition.failures > 0) {
        badges.push(
            `<span class="badge badge-sm badge-error gap-1 shrink-0" title="${rendition.failures} retr${rendition.failures === 1 ? 'y' : 'ies'}">${ICON_ITERATION_CW}${rendition.failures}</span>`,
        );
    }

    const errorLine = lastErrorLine(rendition);
    const errorHtml =
        errorLine && rendition.lastErrorAt !== null && !isStopped
            ? `<div class="flex items-center gap-2 pl-2 mt-0.5 min-w-0">
                <span class="text-xs text-error shrink-0">${formatLocalTime(rendition.lastErrorAt)}</span>
                <span class="text-xs text-error truncate" title="${escapeHtml(errorLine)}">${escapeHtml(errorLine)}</span>
           </div>`
            : '';
    const historyBtn = rendition.hasErrorHistory
        ? `<button class="btn btn-xs btn-ghost text-error" data-action="error-info" data-out-id="${escapeHtml(rendition.id)}" title="Error history">${ICON_HISTORY}</button>`
        : '';
    const canRestart = rendition.status === 'running' && !deps.restartLocked(rendition.id);
    // Same look as the Start/Stop button of an output card.
    const restartBtn = `<button class="btn btn-xs btn-accent btn-outline" data-action="restart-shared" data-out-id="${escapeHtml(rendition.id)}" title="Restart this shared encode; its outputs reconnect"${canRestart ? '' : ' disabled'}>Restart</button>`;
    const dependentLines = rendition.dependents.length
        ? rendition.dependents
              .map((d) => `<div class="text-xs leading-snug">${escapeHtml(d.name)}</div>`)
              .join('')
        : '<div class="text-xs leading-snug opacity-70">No outputs use it.</div>';

    return `
    <div class="bg-base-100 px-3 py-2 border border-base-content/10 rounded-xl w-full min-w-0 space-y-0.5" data-shared-encode="${escapeHtml(rendition.id)}">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div class="flex items-center gap-2 shrink-0 font-semibold">
                <div aria-label="status" class="status status-lg mx-1" style="background-color: ${statusHex}"></div>
                ${restartBtn}
                <span class="js-tooltip inline-flex" tabindex="0">
                    <span class="text-sm">${escapeHtml(rendition.name)}</span>
                    <div class="js-tooltip-content hidden"><div class="text-xs leading-snug font-semibold mb-0.5">Used by:</div>${dependentLines}</div>
                </span>
            </div>
            ${badges.join('')}
            <div class="flex items-center gap-1 ml-auto shrink-0">
                ${historyBtn}
            </div>
        </div>
        ${errorHtml}
    </div>`;
}

export interface SharedEncodeCardDeps {
    outStatus: (output: OutputView, input: InputHealth) => 'good' | 'warn' | 'error' | 'off';
    formatUptime: (ms: number | null) => string;
    restartLocked: (outputId: string) => boolean;
}

// The rows of the "Shared encodes" card; empty when the pipeline has none.
export function renderSharedEncodeRows(pipeline: PipelineView, deps: SharedEncodeCardDeps): string {
    return pipeline.renditions.map((r) => renderRow(r, pipeline.input, deps)).join('');
}

// When each shared encode was last restarted from this page, so the button stays
// disabled for the same 5 s the server refuses a second restart.
const restartedAt = new Map<string, number>();

export function noteSharedEncodeRestart(outputId: string): void {
    restartedAt.set(outputId, Date.now());
}

function restartLocked(outputId: string): boolean {
    const at = restartedAt.get(outputId);
    if (at === undefined) return false;
    if (Date.now() - at >= SHARED_ENCODE_RESTART_LOCKOUT_MS) {
        restartedAt.delete(outputId);
        return false;
    }
    return true;
}

// Fills the card in the pipeline info column and wires its buttons. The card is
// hidden when the pipeline has no shared encodes.
export function renderSharedEncodes(
    pipeline: PipelineView,
    deps: Omit<SharedEncodeCardDeps, 'restartLocked'>,
): void {
    const card = document.getElementById('shared-encodes-card');
    const listEl = document.getElementById('shared-encodes-list');
    if (!card || !listEl) return;
    card.classList.toggle('hidden', pipeline.renditions.length === 0);
    listEl.innerHTML = renderSharedEncodeRows(pipeline, { ...deps, restartLocked });
    listEl.onclick = (e) => {
        const btn = (e.target as Element).closest('[data-action]') as HTMLButtonElement | null;
        if (!btn || btn.disabled) return;
        const action = btn.dataset.action;
        const outId = btn.dataset.outId!;
        void import('./editor.js').then((ed) => {
            if (action === 'error-info') void ed.showOutputError(pipeline.id, outId);
            else if (action === 'restart-shared')
                void ed.confirmRestartSharedEncode(pipeline.id, outId);
        });
    };
}
