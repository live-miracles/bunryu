import { escapeHtml, formatAgo, formatLocalDateTime, formatUptime } from '../core/utils.js';
import { healthNowMs, state } from '../core/state.js';
import type { InputHealth, OutputView } from '../types.js';
import {
    ICON_EXTERNAL_LINK,
    ICON_HISTORY,
    ICON_ITERATION_CW,
    ICON_PENCIL,
    ICON_PLAY,
    ICON_STOP,
    ICON_TRASH,
    outputMetricsBadge,
} from './output-badges.js';
import { errorHint } from '../core/hints.js';
import type { PendingOutputs } from '../core/pending-outputs.js';
import { outputAdvice, type DupRef } from '../core/output-advice.js';
import { errorTone, lastErrorLine, statusColor, type StatusIssue } from '../core/status.js';
import { issueLinesHtml } from './status-tooltip.js';

type OutputCardDeps = {
    pendingOutputs: PendingOutputs;
    // The outputs that loop back into their own pipeline (restreamLoops).
    loops?: ReadonlyMap<string, string>;
};

const ICON_INFO = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
const ICON_WARN = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;

// The watch link as an icon next to the name. Only an http(s) link becomes one, whatever the
// server stored, so it can never be a `javascript:` link.
function watchLinkHtml(watchUrl: string | undefined): string {
    if (!watchUrl || !/^https?:\/\//i.test(watchUrl)) return '';
    return `<a class="btn btn-xs btn-square btn-ghost shrink-0" href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener noreferrer" title="Watch: ${escapeHtml(watchUrl)}" aria-label="Open the watch link">${ICON_EXTERNAL_LINK}</a>`;
}

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

// Every warning the card shows, whether reported by the running output or one behind the
// status dot (its verdict: a low bitrate, waiting to start). A yellow dot always has a line.
// The advice about how the output is configured (core/output-advice.ts) is not one: it is
// listed apart and changes neither the dot nor the card's tint.
function outputWarnings(output: OutputView): Array<{ message: string; sinceMs?: number | null }> {
    const own = output.warningReason
        ? [{ message: output.warningReason, sinceMs: output.warningSinceMs }]
        : [];
    const fromHealth = output.verdict.issues
        .filter(
            (issue) =>
                issue.severity === 'warning' && !own.some((w) => w.message === issue.message),
        )
        .map((issue) => ({ message: issue.message }));
    return [...own, ...fromHealth];
}

export function renderOutputCard(
    output: OutputView,
    input: InputHealth,
    dupUrls: Map<string, DupRef[]>,
    deps: OutputCardDeps,
): string {
    const isStopped = output.desiredState === 'stopped';
    const status = output.verdict.status;
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
    // The error of a stopped output (a stop after repeated failures) is yellow, like advice:
    // it is old news to look at, not something happening now, so it neither tints the card nor
    // counts as a Problem. While the output runs it is red.
    const tone = errorTone(output);
    const lastErrorTs = output.lastErrorAt
        ? `<span class="text-xs text-${tone} shrink-0" title="${formatLocalDateTime(output.lastErrorAt)}">${formatAgo(output.lastErrorAt, healthNowMs())}</span>`
        : '';
    const retryBadge =
        output.failures > 0
            ? `<span class="badge badge-sm badge-${tone} gap-1 shrink-0" title="${output.failures} retr${output.failures === 1 ? 'y' : 'ies'}">${ICON_ITERATION_CW}${output.failures}</span>`
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
        ? `<div class="flex items-center max-lg:items-start gap-2 pl-2 min-w-0">
                ${retryBadge}
                ${lastErrorTs}
                ${retryInHtml}
                <span class="text-xs text-${tone} truncate max-lg:whitespace-normal max-lg:break-words" title="${escapeHtml(lastErrorLine)}">${escapeHtml(lastErrorLine)}</span>${hintHtml(errorHint(lastErrorLine))}
           </div>`
        : '';
    // Coloured only while the latest record is a crash (red) or a stop after repeated
    // failures (yellow); after a plain stop (or only warnings) the history is there to open
    // but nothing is currently wrong.
    const historyBtn = output.hasErrorHistory
        ? `<button class="btn btn-xs btn-square btn-ghost ${output.lastError !== null ? `text-${tone}` : ''}" data-action="error-info" data-out-id="${output.id}" title="Error history">${ICON_HISTORY}</button>`
        : '';
    const advice = outputAdvice(output, input, dupUrls, deps.loops);
    const warnings = outputWarnings(output);
    // The dot's hover text: the same problems as the lines below, so it never shows
    // a colour without the reason. A healthy output has nothing to say.
    const dotIssues: StatusIssue[] = [
        ...output.verdict.issues.filter((issue) => issue.severity === 'error'),
        ...warnings.map(({ message, sinceMs }) => ({
            severity: 'warning' as const,
            message,
            hint: errorHint(message) ?? undefined,
            sinceMs: sinceMs ?? undefined,
        })),
    ];
    const statusDot = `<div aria-label="status" class="status status-lg mx-1 shrink-0" style="background-color: ${statusHex}"></div>`;
    const statusDotHtml =
        dotIssues.length > 0
            ? `<span class="js-tooltip shrink-0 inline-flex" tabindex="0">${statusDot}<div class="js-tooltip-content hidden">${issueLinesHtml(dotIssues)}</div></span>`
            : statusDot;
    const warningsHtml = warnings
        .map(
            ({
                message,
                sinceMs,
            }) => `<div class="flex items-center max-lg:items-start gap-2 pl-2 min-w-0">
                <span class="text-warning shrink-0">${ICON_WARN}</span>
                <span class="text-xs text-warning truncate max-lg:whitespace-normal max-lg:break-words" title="${escapeHtml(message)}">${escapeHtml(message)}</span>${hintHtml(errorHint(message))}${sinceHtml(sinceMs)}
           </div>`,
        )
        .join('');
    // Advice looks like a warning line but is not one: it never tints the card or the dot.
    const adviceHtml = advice
        .map(
            (message) => `<div class="flex items-center max-lg:items-start gap-2 pl-2 min-w-0">
                <span class="text-warning shrink-0">${ICON_WARN}</span>
                <span class="text-xs text-warning truncate max-lg:whitespace-normal max-lg:break-words" title="${escapeHtml(message)}">${escapeHtml(message)}</span>
           </div>`,
        )
        .join('');
    // The card takes the colour of its most severe current problem: red for an
    // error (a crash being retried), yellow for warnings alone, none otherwise. A stop
    // after repeated failures is neither: its line is yellow and the card stays plain.
    const tintColor =
        status === 'error' || (lastErrorLine && !isStopped)
            ? 'error'
            : warningsHtml
              ? 'warning'
              : null;
    const cardTint = tintColor
        ? `style="background:color-mix(in oklab, var(--${tintColor === 'error' ? 'dot-bad' : 'dot-warn'}) 12%, var(--panel))"`
        : '';
    const isPending = deps.pendingOutputs.has(output.id);

    return `
    <div class="bg-base-100 px-2.5 py-1.5 border border-base-content/10 rounded-lg w-full min-w-0 space-y-0 cursor-grab group/out" draggable="true" data-output-card="${output.id}" ${cardTint}>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div class="flex items-center gap-2 min-w-0 max-w-full font-semibold">
                ${statusDotHtml}
                <button class="btn btn-xs btn-square shrink-0 ${isStopped ? 'btn-accent btn-soft' : 'btn-outline btn-stop'}"
                    data-action="${isStopped ? 'start' : 'stop'}" data-out-id="${output.id}"
                    title="${isStopped ? 'Start' : 'Stop'}" aria-label="${isStopped ? 'Start' : 'Stop'}"${isPending ? ' disabled' : ''}>
                    ${isStopped ? ICON_PLAY : ICON_STOP}
                </button>
                <span class="min-w-0 truncate" title="${escapeHtml(output.name)}">${escapeHtml(formatOutputName(output.name))}</span>
                ${watchLinkHtml(output.watchUrl)}
            </div>
            ${badges.join('')}
            ${inlineSink}
            <div class="flex items-center gap-1 ml-auto shrink-0 [@media(hover:hover)]:hidden group-hover/out:flex group-focus-within/out:flex">
                ${historyBtn}
                <button class="btn btn-xs btn-square btn-ghost" data-action="edit" data-out-id="${output.id}" title="Edit output" aria-label="Edit output">${ICON_PENCIL}</button>
                <button class="btn btn-xs btn-square btn-ghost text-error ${isStopped ? '' : 'btn-disabled opacity-40'}" data-action="delete" data-out-id="${output.id}" title="Delete output" aria-label="Delete output">${ICON_TRASH}</button>
            </div>
        </div>
        ${warningsHtml}
        ${lastErrorHtml}
        ${adviceHtml}
    </div>`;
}
