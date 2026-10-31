import { healthNowMs } from '../core/state.js';
import { escapeHtml, formatAgo, formatLocalDateTime, formatUptime } from '../core/utils.js';
import { lastErrorLine, statusColor } from '../core/status.js';
import type { StatusIssue } from '../core/status.js';
import { renderStatusTooltip, splitDotGradient } from './status-tooltip.js';
import {
    ICON_HISTORY,
    ICON_ITERATION_CW,
    ICON_RESTART,
    outputMetricsBadge,
} from './output-badges.js';
import type { InputHealth, OutputView, PipelineView } from '../types.js';

// Shared encodes (renditions): outputs of one pipeline that need the same encode
// share one upstream FFmpeg, a server-managed output row. See
// src/utils/renditions.ts; parsePipelines (core/pipeline.ts) links each output to
// its rendition (`sharedEncode`) and keeps the rows apart in `renditions`.

export const SHARED_ENCODE_RESTART_LOCKOUT_MS = 5000;

export type SharedEncodeStatus = 'good' | 'warn' | 'error' | 'off';

// One side of the status dot: its colour and the problems behind it.
export interface SharedEncodeSide {
    status: SharedEncodeStatus;
    issues: StatusIssue[];
}

export interface SharedEncodeIndicator {
    ffmpeg: SharedEncodeSide;
    input: SharedEncodeSide;
    // True while the encode is stopped because no output uses it: nothing is wrong,
    // so both halves are grey whatever the input is doing.
    idle: boolean;
}

// The status dot of a shared encode is split like the SRT Relay's: the left half is
// the encode's own FFmpeg (its process, progress and errors), the right half is the
// pipeline's input as SRS has it (no publisher, a failed probe, input alerts), which
// is what the encode reads. The two have different causes and fixes, so one colour
// would hide which side to look at.
export function sharedEncodeIndicator(
    rendition: OutputView,
    ffmpeg: SharedEncodeSide,
    input: SharedEncodeSide,
): SharedEncodeIndicator {
    if (rendition.desiredState === 'stopped') {
        return {
            ffmpeg: { status: 'off', issues: [] },
            input: { status: 'off', issues: [] },
            idle: true,
        };
    }
    return { ffmpeg, input, idle: false };
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

// The two-half dot and the tooltip that says what each half means.
function renderStatusDot(
    rendition: OutputView,
    input: InputHealth,
    deps: SharedEncodeCardDeps,
): string {
    const indicator = sharedEncodeIndicator(
        rendition,
        deps.ffmpegHealth(rendition),
        deps.inputHealth(input),
    );
    const tooltip = renderStatusTooltip(
        {
            label: 'FFmpeg',
            issues: indicator.ffmpeg.issues,
            active: indicator.ffmpeg.status !== 'off',
            ok: 'Encoding normally.',
            off: 'Not running.',
        },
        {
            label: 'SRS input',
            issues: indicator.input.issues,
            active: indicator.input.status !== 'off',
            ok: 'Input is live.',
            off: 'No input on this stream key.',
        },
        indicator.idle ? 'Idle: it starts with the first output that uses it.' : undefined,
    );
    const gradient = splitDotGradient(
        statusColor(indicator.ffmpeg.status),
        statusColor(indicator.input.status),
    );
    return `<span class="js-tooltip shrink-0 mx-1" tabindex="0">
        <div aria-label="status" class="border-base-content/15 h-5 w-5 overflow-hidden rounded-full border" style="background-image: ${gradient}"></div>
        <div class="js-tooltip-content hidden">${tooltip}</div>
    </span>`;
}

function renderRow(rendition: OutputView, input: InputHealth, deps: SharedEncodeCardDeps): string {
    const isStopped = rendition.desiredState === 'stopped';
    const uptimeMs = rendition.startedAtMs !== null ? Date.now() - rendition.startedAtMs : null;
    // The encoding as badges, like an output card: video unless copy, audio as T<n>.
    const encoding: string[] = [];
    if (rendition.videoEncoding !== 'copy') {
        encoding.push(
            `<span class="badge badge-sm badge-accent badge-soft whitespace-nowrap">${escapeHtml(rendition.videoEncoding)}</span>`,
        );
    }
    if (rendition.audioEncoding !== 'copy') {
        encoding.push(
            `<span class="badge badge-xs badge-accent badge-soft whitespace-nowrap">T${parseInt(rendition.audioEncoding) + 1}</span>`,
        );
    }
    const uptime =
        uptimeMs !== null
            ? `<span class="tabular-nums text-xs text-muted whitespace-nowrap">${escapeHtml(formatUptime(uptimeMs))}</span>`
            : '';
    const badges: string[] = [outputMetricsBadge(rendition, input, true)];
    const readers = rendition.readers ?? 0;
    const counts = `<span class="badge badge-sm badge-soft whitespace-nowrap" title="Outputs that pull this encode, and clients currently reading it from SRS">${plural(rendition.dependents.length, 'out', 'outs')} · ${plural(readers, 'read', 'reads')}</span>`;
    if (rendition.failures > 0) {
        badges.push(
            `<span class="badge badge-sm badge-error gap-1 shrink-0" title="${rendition.failures} retr${rendition.failures === 1 ? 'y' : 'ies'}">${ICON_ITERATION_CW}${rendition.failures}</span>`,
        );
    }

    const errorLine = lastErrorLine(rendition);
    const errorHtml =
        errorLine && rendition.lastErrorAt !== null && !isStopped
            ? `<div class="flex items-center gap-2 pl-2 mt-0.5 min-w-0">
                <span class="text-xs text-error shrink-0" title="${formatLocalDateTime(rendition.lastErrorAt)}">${formatAgo(rendition.lastErrorAt, healthNowMs())}</span>
                <span class="text-xs text-error truncate" title="${escapeHtml(errorLine)}">${escapeHtml(errorLine)}</span>
           </div>`
            : '';
    // Red only while the latest record is a crash (see the output card).
    const historyBtn = rendition.hasErrorHistory
        ? `<button class="btn btn-xs btn-square btn-ghost ${rendition.lastError !== null ? 'text-error' : ''}" data-action="error-info" data-out-id="${escapeHtml(rendition.id)}" title="Error history">${ICON_HISTORY}</button>`
        : '';
    const canRestart = rendition.status === 'running' && !deps.restartLocked(rendition.id);
    // Square icon button like the Start/Stop button of an output card.
    const restartBtn = `<button class="btn btn-xs btn-square btn-warning btn-outline" data-action="restart-shared" data-out-id="${escapeHtml(rendition.id)}" title="Restart this shared encode; its outputs reconnect" aria-label="Restart"${canRestart ? '' : ' disabled'}>${ICON_RESTART}</button>`;
    const dependentLines = rendition.dependents.length
        ? rendition.dependents
              .map((d) => `<div class="text-xs leading-snug">${escapeHtml(d.name)}</div>`)
              .join('')
        : '<div class="text-xs leading-snug opacity-70">No outputs use it.</div>';

    // One wrapping row, like an output card: the status dot and Restart, then every
    // badge, then History pushed to the end. Items only drop to a second line when
    // the card is too narrow for them. The card's own title already says "Shared
    // encodes", so the row shows just the encoding.
    return `
    <div class="bg-base-100 px-2.5 py-1.5 border border-base-content/10 rounded-lg w-full min-w-0 space-y-0" data-shared-encode="${escapeHtml(rendition.id)}">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div class="flex items-center gap-2 shrink-0 font-semibold">
                ${renderStatusDot(rendition, input, deps)}
                ${restartBtn}
            </div>
            <span class="js-tooltip inline-flex items-center gap-2" tabindex="0">
                ${encoding.join('')}
                <div class="js-tooltip-content hidden"><div class="text-xs leading-snug font-semibold mb-0.5">Used by:</div>${dependentLines}</div>
            </span>
            ${uptime}
            ${counts}
            ${badges.join('')}
            <div class="flex items-center gap-1 ml-auto shrink-0">
                ${historyBtn}
            </div>
        </div>
        ${errorHtml}
    </div>`;
}

export interface SharedEncodeCardDeps {
    // The problems on each side of the status dot (see sharedEncodeIndicator).
    ffmpegHealth: (output: OutputView) => SharedEncodeSide;
    inputHealth: (input: InputHealth) => SharedEncodeSide;
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
