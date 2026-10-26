import { escapeHtml } from './utils.js';

// The Overview's search boxes and the rule that puts an offline input in the
// Issues view. Pure functions, so the DOM-bound render code stays thin.

type RowStatus = 'good' | 'warn' | 'error' | 'off';

const isProblem = (status: RowStatus): boolean => status === 'warn' || status === 'error';

// Plain case-insensitive text match on any of the names; an empty query matches all.
export function matchesName(query: string, ...names: string[]): boolean {
    const needle = query.trim().toLowerCase();
    return needle === '' || names.some((name) => name.toLowerCase().includes(needle));
}

// An input nobody publishes to is "off", not a problem. It becomes one in the Issues
// view when outputs of its pipeline are in trouble, because their cause is this row.
export function affectedOutputCount(inputStatus: RowStatus, outputStatuses: RowStatus[]): number {
    return inputStatus === 'off' ? outputStatuses.filter(isProblem).length : 0;
}

// Heading badge: the total, or "shown of total" while a filter or search hides rows.
export function countLabel(shown: number, total: number): string {
    return shown === total ? String(total) : `${shown} of ${total}`;
}

// The search box on a table's heading line. `value` is what the user typed.
export function searchBoxHtml(id: string, label: string, value: string): string {
    return `<input id="${id}" type="search" class="input input-sm w-56 max-w-full" placeholder="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" value="${escapeHtml(value)}" autocomplete="off" />`;
}

// The single row shown when a search leaves a table empty.
export function noMatchRowHtml(colspan: number, noun: string, query: string): string {
    return `<tr><td colspan="${colspan}" class="py-4 text-center text-muted">No ${noun} match “${escapeHtml(query.trim())}”.</td></tr>`;
}
