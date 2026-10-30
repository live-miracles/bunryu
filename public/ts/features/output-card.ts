import { escapeHtml, formatAgo, formatLocalDateTime, formatUptime } from '../core/utils.js';
import { healthNowMs, state } from '../core/state.js';
import type { InputHealth, OutputView } from '../types.js';
import {
    ICON_HISTORY,
    ICON_ITERATION_CW,
    ICON_PLAY,
    ICON_STOP,
    outputMetricsBadge,
} from './output-badges.js';
import { errorHint } from '../core/hints.js';
import { lastErrorLine, outputHealth, statusColor } from '../core/status.js';

// outputId lets an output card leave itself out of its own duplicate list.
export type DupRef = { pipelineName: string; outputName?: string; outputId?: string };

type OutputCardDeps = {
    pendingOutputs: Map<string, 'start' | 'stop'>;
};

const ICON_PENCIL = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-1 2-1h4c1 0 2 1 2 2v1"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;
const ICON_INFO = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
const ICON_WARN = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;

export function formatOutputName(name: string): string {
    return name.length > 30 ? `${name.slice(0, 27)}...` : name;
}

function restreamSinkLabel(url: string): string | null {
    for (const pipeline of state.config.pipelines ?? []) {
        if (url === pipeline.rtmpPublishUrlLocal) return `rtmp:// ${pipeline.name}`;
        if (url === pipeline.srtPublishUrlLocal) return `srt:// ${pipeline.name}`;
    }
    return null;
}

export function dupTooltip(headline: string, refs: DupRef[]): string {
    const lines = refs.map(
        (ref) =>
            `<div class="text-xs leading-snug text-warning">${escapeHtml(ref.outputName ? `${ref.pipelineName} → ${ref.outputName}` : ref.pipelineName)}</div>`,
    );
    return `<div class="text-xs leading-snug font-semibold text-warning mb-0.5">${escapeHtml(headline)}</div>${lines.join('')}`;
}

function outputEncodingWarnings(output: OutputView, input: InputHealth): string[] {
    if (!output.url || !input.connected) return [];
    const warnings: string[] = [];
    const outIsSrt = output.url.startsWith('srt://');

    if (!input.isSrt && output.audioEncoding !== 'copy' && output.audioEncoding !== '0') {
        warnings.push(
            'RTMP input only has one audio track — use copy or Track 1, not a different track selection.',
        );
    }
    if (!input.isSrt && !outIsSrt && output.audioEncoding === '0') {
        warnings.push(
            'Track 1 re-encodes the audio, which costs extra CPU — use copy unless the audio must be re-encoded.',
        );
    }
    if (input.isSrt && !outIsSrt && output.audioEncoding === 'copy') {
        warnings.push(
            'SRT-to-RTMP output should not use copy audio — it can cause audio jitter; select a track instead.',
        );
    }
    if (input.isSrt && input.audioTracks.length > 0) {
        const outOfRange = output.audioEncoding
            .split(',')
            .map((value) => value.trim())
            .filter((value) => /^\d+$/.test(value))
            .map(Number)
            .filter((index) => index >= input.audioTracks.length);
        if (outOfRange.length > 0) {
            const trackLabel = outOfRange.map((index) => index + 1).join(', ');
            const count = input.audioTracks.length;
            warnings.push(
                `Output selects track ${trackLabel}, but the input only has ${count} audio track${count === 1 ? '' : 's'}.`,
            );
        }
    }
    return warnings;
}

// "since 3 min ago" after a warning that is still going on.
function sinceHtml(sinceMs: number | null | undefined): string {
    return sinceMs
        ? `<span class="text-xs text-muted shrink-0" title="${formatLocalDateTime(sinceMs)}">since ${formatAgo(sinceMs, healthNowMs())}</span>`
        : '';
}

// An info icon at the end of an error or warning line; the advice (see
// core/hints.ts) is in its hover/focus tooltip so it does not make the card taller.
function hintHtml(hint: string | null): string {
    return hint
        ? `<span class="js-tooltip inline-flex shrink-0 opacity-50 hover:opacity-100" tabindex="0" aria-label="Hint: ${escapeHtml(hint)}">${ICON_INFO}<div class="js-tooltip-content hidden"><div class="max-w-xs text-xs leading-snug whitespace-normal">Hint: ${escapeHtml(hint)}</div></div></span>`
        : '';
}

// The last line of the output's current error, or '' when it has none (a stopped
// output keeps one only when it was stopped after repeated failed attempts).
function currentErrorLine(output: OutputView): string {
    return output.lastErrorAt === null ? '' : lastErrorLine(output);
}

// Every warning the card shows, whether reported by the running output, a
// destination shared with another output or advice about the encoding settings.
function outputWarnings(
    output: OutputView,
    input: InputHealth,
    dupUrls: Map<string, DupRef[]>,
): Array<{ message: string; sinceMs?: number | null }> {
    const otherDupRefs = (output.url ? (dupUrls.get(output.url) ?? []) : []).filter(
        (ref) => ref.outputId !== output.id,
    );
    return [
        ...(output.warningReason
            ? [{ message: output.warningReason, sinceMs: output.warningSinceMs }]
            : []),
        ...(otherDupRefs.length > 0
            ? [
                  {
                      message: `Same destination as ${otherDupRefs
                          .map((ref) =>
                              ref.outputName
                                  ? `${ref.pipelineName} → ${ref.outputName}`
                                  : ref.pipelineName,
                          )
                          .join(', ')}`,
                  },
              ]
            : []),
        ...outputEncodingWarnings(output, input).map((message) => ({ message })),
    ];
}

// What is wrong with the output right now, as the Outputs list's "Problems only"
// filter and summary count it: an error (a crash being retried, or a stop after
// repeated failures), a warning of any kind, or nothing.
export function outputSeverity(
    output: OutputView,
    input: InputHealth,
    dupUrls: Map<string, DupRef[]>,
): 'error' | 'warning' | null {
    const status = outputHealth(output, input).status;
    if (status === 'error' || currentErrorLine(output)) return 'error';
    if (status === 'warn' || outputWarnings(output, input, dupUrls).length > 0) return 'warning';
    return null;
}

export function renderOutputCard(
    output: OutputView,
    input: InputHealth,
    dupUrls: Map<string, DupRef[]>,
    deps: OutputCardDeps,
): string {
    const isStopped = output.desiredState === 'stopped';
    const status = outputHealth(output, input).status;
    const statusHex = statusColor(status);
    const uptimeMs = output.startedAtMs !== null ? Date.now() - output.startedAtMs : null;
    const badges: string[] = [];
    if (output.videoEncoding !== 'copy') {
        badges.push(
            `<span class="badge badge-sm badge-accent badge-soft whitespace-nowrap">${output.videoEncoding}</span>`,
        );
    }
    if (output.audioEncoding !== 'copy') {
        const label = output.audioEncoding
            .split(',')
            .map((track) => `T${parseInt(track) + 1}`)
            .join('+');
        badges.push(
            `<span class="badge badge-xs badge-accent badge-soft whitespace-nowrap">${label}</span>`,
        );
    }
    if (uptimeMs !== null) {
        badges.push(
            `<span class="tabular-nums text-xs text-muted whitespace-nowrap">${formatUptime(uptimeMs)}</span>`,
        );
    }
    const metricsBadge = outputMetricsBadge(output, input);
    if (metricsBadge) badges.push(metricsBadge);

    let inlineSink = '';
    if (output.url) {
        const sinkLabel = restreamSinkLabel(output.url);
        const display =
            sinkLabel ??
            (output.url.length > 27
                ? output.url.slice(0, 25) + '...' + output.url.slice(-2)
                : output.url);
        inlineSink = `<code class="text-xs font-normal text-muted min-w-0 flex-1 basis-24 truncate" title="${escapeHtml(output.url)}">${escapeHtml(display)}</code>`;
    }

    const lastErrorLine = currentErrorLine(output);
    const lastErrorTs = output.lastErrorAt
        ? `<span class="text-xs text-error shrink-0" title="${formatLocalDateTime(output.lastErrorAt)}">${formatAgo(output.lastErrorAt, healthNowMs())}</span>`
        : '';
    const retryBadge =
        output.failures > 0
            ? `<span class="badge badge-sm badge-error gap-1 shrink-0" title="${output.failures} retr${output.failures === 1 ? 'y' : 'ies'}">${ICON_ITERATION_CW}${output.failures}</span>`
            : '';
    // When the next retry is due, as of this health snapshot (the poll is every
    // 5 s, so it counts down in steps). Absent while the output waits for its input.
    const retryInSec =
        output.nextRetryAtMs === null
            ? null
            : Math.max(0, Math.ceil((output.nextRetryAtMs - healthNowMs()) / 1000));
    const retryInHtml =
        retryInSec === null
            ? ''
            : `<span class="text-xs text-error shrink-0 opacity-80">${retryInSec > 0 ? `retry in ${retryInSec} s` : 'retrying now'}</span>`;
    // A stopped output only has a lastError when it was stopped after repeated
    // failed attempts (the server clears it when the output starts again).
    const lastErrorHtml = lastErrorLine
        ? `<div class="flex items-center max-lg:items-start gap-2 pl-2 mt-0.5 min-w-0">
                ${retryBadge}
                ${lastErrorTs}
                ${retryInHtml}
                <span class="text-xs text-error truncate max-lg:whitespace-normal max-lg:break-words" title="${escapeHtml(lastErrorLine)}">${escapeHtml(lastErrorLine)}</span>${hintHtml(errorHint(lastErrorLine))}
           </div>`
        : '';
    // Red only while the latest record is a crash or a stop after repeated failures;
    // after a plain stop (or only warnings) the history is there to open but nothing
    // is currently wrong.
    const historyBtn = output.hasErrorHistory
        ? `<button class="btn btn-xs btn-square btn-ghost ${output.lastError !== null ? 'text-error' : ''}" data-action="error-info" data-out-id="${output.id}" title="Error history">${ICON_HISTORY}</button>`
        : '';
    const warnings = outputWarnings(output, input, dupUrls);
    const warningsHtml = warnings
        .map(
            ({
                message,
                sinceMs,
            }) => `<div class="flex items-center max-lg:items-start gap-2 pl-2 mt-0.5 min-w-0">
                <span class="text-warning shrink-0">${ICON_WARN}</span>
                <span class="text-xs text-warning truncate max-lg:whitespace-normal max-lg:break-words" title="${escapeHtml(message)}">${escapeHtml(message)}</span>${hintHtml(errorHint(message))}${sinceHtml(sinceMs)}
           </div>`,
        )
        .join('');
    // The card takes the colour of its most severe current problem: red for an
    // error (a crash being retried, or a stop after repeated failures), yellow
    // for warnings alone, none otherwise.
    const tintColor =
        status === 'error' || lastErrorLine ? 'error' : warningsHtml ? 'warning' : null;
    const cardTint = tintColor
        ? `style="background:color-mix(in oklab, var(--${tintColor === 'error' ? 'dot-bad' : 'dot-warn'}) 12%, var(--panel))"`
        : '';
    const isPending = deps.pendingOutputs.has(output.id);

    return `
    <div class="bg-base-100 px-3 py-2 border border-base-content/10 rounded-xl w-full min-w-0 space-y-0.5" data-output-card="${output.id}" ${cardTint}>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div class="flex items-center gap-2 min-w-0 max-w-full font-semibold">
                <div aria-label="status" class="status status-lg mx-1 shrink-0" style="background-color: ${statusHex}"></div>
                <button class="btn btn-xs btn-square shrink-0 ${isStopped ? 'btn-primary' : 'btn-error btn-outline'}"
                    data-action="${isStopped ? 'start' : 'stop'}" data-out-id="${output.id}"
                    title="${isStopped ? 'Start' : 'Stop'}" aria-label="${isStopped ? 'Start' : 'Stop'}"${isPending ? ' disabled' : ''}>
                    ${isStopped ? ICON_PLAY : ICON_STOP}
                </button>
                <span class="js-output-drag-handle cursor-grab min-w-0 truncate" draggable="true" title="${escapeHtml(output.name)}">${escapeHtml(formatOutputName(output.name))}</span>
            </div>
            ${badges.join('')}
            ${inlineSink}
            <div class="flex items-center gap-1 ml-auto shrink-0">
                ${historyBtn}
                <button class="btn btn-xs btn-square btn-ghost" data-action="edit" data-out-id="${output.id}" title="Edit output" aria-label="Edit output">${ICON_PENCIL}</button>
                <button class="btn btn-xs btn-square btn-ghost text-error ${isStopped ? '' : 'btn-disabled opacity-40'}" data-action="delete" data-out-id="${output.id}" title="Delete output" aria-label="Delete output">${ICON_TRASH}</button>
            </div>
        </div>
        ${warningsHtml}
        ${lastErrorHtml}
    </div>`;
}
