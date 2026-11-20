import { healthNowMs } from '../core/state.js';
import { escapeHtml, formatAgo, formatLocalDateTime } from '../core/utils.js';
import type { StatusIssue } from '../core/status.js';

export type { StatusIssue };

// The hover text of a two-half status dot, shared by the pipeline list, the SRT Relay
// card and a shared encode row, so all three read the same way: each half has a
// heading, then what is wrong with it, or why nothing is.

export function issueLinesHtml(issues: StatusIssue[]): string {
    return issues
        .map((issue) => {
            const cls = issue.severity === 'error' ? 'text-error' : 'text-warning';
            const hint = issue.hint
                ? `<div class="text-xs leading-snug text-muted">Hint: ${escapeHtml(issue.hint)}</div>`
                : '';
            const since = issue.sinceMs
                ? ` <span class="text-muted" title="${formatLocalDateTime(issue.sinceMs)}">since ${formatAgo(issue.sinceMs, healthNowMs())}</span>`
                : '';
            return `<div class="${cls} text-xs leading-snug">${escapeHtml(issue.message)}${since}</div>${hint}`;
        })
        .join('');
}

const DOT_DIVIDER = 'transparent';

// A circle or square split in two with a thin divider: left half, right half.
export function splitDotGradient(leftColor: string, rightColor: string): string {
    return `linear-gradient(90deg, ${leftColor} 0 45%, ${DOT_DIVIDER} 45% 55%, ${rightColor} 55% 100%)`;
}

export interface StatusHalf {
    label: string;
    issues: StatusIssue[];
    // Whether this half has anything to report on; an inactive half with no issues
    // says `off` instead of `ok`.
    active: boolean;
    ok: string;
    off: string;
}

function halfHtml(half: StatusHalf): string {
    const body =
        half.issues.length > 0
            ? issueLinesHtml(half.issues)
            : `<div class="text-xs leading-snug opacity-70">${escapeHtml(half.active ? half.ok : half.off)}</div>`;
    return `<div class="text-xs leading-snug font-semibold mb-0.5">${escapeHtml(half.label)}</div>${body}`;
}

// `idle`: one line instead of the halves, for something that is switched off on
// purpose, where "nothing wrong" is the whole story.
export function renderStatusTooltip(left: StatusHalf, right: StatusHalf, idle?: string): string {
    if (idle) return `<div class="text-xs leading-snug opacity-70">${escapeHtml(idle)}</div>`;
    return `${halfHtml(left)}<div class="mt-1">${halfHtml(right)}</div>`;
}
