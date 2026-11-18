import { escapeHtml } from './utils.js';

// The Overview's search boxes and the labels on its table headings. What counts as a
// problem is in core/problems.ts. Pure functions, so the DOM-bound render code stays thin.

// Plain case-insensitive text match on any of the names; an empty query matches all.
export function matchesName(query: string, ...names: string[]): boolean {
    const needle = query.trim().toLowerCase();
    return needle === '' || names.some((name) => name.toLowerCase().includes(needle));
}

// Heading badge: the total, or "shown of total" while a filter or search hides rows.
export function countLabel(shown: number, total: number): string {
    return shown === total ? String(total) : `${shown} of ${total}`;
}

// The search box on a table's heading line. `value` is what the user typed.
export function searchBoxHtml(id: string, label: string, value: string): string {
    return `<input id="${id}" type="search" class="input input-sm w-56 max-w-full" placeholder="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" value="${escapeHtml(value)}" autocomplete="off" />`;
}
