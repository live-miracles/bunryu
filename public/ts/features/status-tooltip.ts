import { healthNowMs } from '../core/state.js';
import { escapeHtml, formatAgo, formatLocalDateTime } from '../core/utils.js';
import type { StatusIssue } from '../core/status.js';

export type { StatusIssue };

// The hover text of a two-half status dot, shared by the pipeline list, the SRT Relay
// card and a shared encode row, so all three read the same way: each half has a
// heading, then what is wrong with it, or why nothing is.

export const ICON_INFO = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;

// An info icon at the end of an error or warning line; the advice (see core/hints.ts) is in
// its hover/focus tooltip, so it does not make the card taller.
export function hintIconHtml(hint: string | null | undefined): string {
    return hint
        ? `<span class="js-tooltip inline-flex shrink-0 opacity-50 hover:opacity-100" tabindex="0" aria-label="Hint: ${escapeHtml(hint)}">${ICON_INFO}<div class="js-tooltip-content hidden"><div class="max-w-xs text-xs leading-snug whitespace-normal">Hint: ${escapeHtml(hint)}</div></div></span>`
        : '';
}

// Where an issue's hint goes. The hover text of a status dot has none (it is for what is
// wrong); a card shows it in the info icon, the Overview's Issues cell as a muted line.
export type HintStyle = 'none' | 'icon' | 'inline';

export function issueLinesHtml(issues: StatusIssue[], hints: HintStyle = 'none'): string {
    return issues
        .map((issue) => {
            const cls = issue.severity === 'error' ? 'text-error' : 'text-warning';
            const hint =
                hints === 'inline' && issue.hint
                    ? `<div class="text-xs leading-snug text-muted">Hint: ${escapeHtml(issue.hint)}</div>`
                    : '';
            const icon = hints === 'icon' ? hintIconHtml(issue.hint) : '';
            const since = issue.sinceMs
                ? ` <span class="text-muted" title="${formatLocalDateTime(issue.sinceMs)}">since ${formatAgo(issue.sinceMs, healthNowMs())}</span>`
                : '';
            const line = `${escapeHtml(issue.message)}${since}`;
            return hints === 'icon'
                ? `<div class="${cls} text-xs leading-snug">${line} ${icon}</div>`
                : `<div class="${cls} text-xs leading-snug">${line}</div>${hint}`;
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
