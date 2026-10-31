import { escapeHtml } from './utils.js';

// The Overview's search boxes and the rule that puts an offline input in the
// Issues view. Pure functions, so the DOM-bound render code stays thin.

type RowStatus = 'good' | 'warn' | 'error' | 'off';

export const isProblem = (status: RowStatus): boolean => status === 'warn' || status === 'error';
export const isOffline = (status: RowStatus): boolean => status === 'off';

// How many of a pipeline's (or a group's) outputs are in each status, and the one
// status that stands for them all: an error beats a warning beats a healthy output,
// and no healthy output at all reads as off.
export type StatusTally = Record<RowStatus, number>;

export function tallyStatuses(statuses: RowStatus[]): StatusTally {
    const tally: StatusTally = { good: 0, warn: 0, error: 0, off: 0 };
    for (const status of statuses) tally[status] += 1;
    return tally;
}

export function worstOfTally(tally: StatusTally): RowStatus {
    return tally.error > 0 ? 'error' : tally.warn > 0 ? 'warn' : tally.good > 0 ? 'good' : 'off';
}

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
