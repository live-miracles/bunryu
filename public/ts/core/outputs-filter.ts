import { matchesName } from './overview-filter.js';

// The Outputs list's filter box, "Problems only" toggle and summary badges. Pure
// functions, so the DOM-bound render code stays thin.

export type OutputSeverity = 'error' | 'warning' | null;

// What the summary counts. Running and stopped are the outputs' own state, so together
// they are every output; errors and warnings count the outputs with one (the card's
// rule, see outputSeverity) whatever their state, so they overlap with those two.
export type OutputCounts = { error: number; warning: number; running: number; stopped: number };

export function countOutputs(
    items: Array<{ severity: OutputSeverity; stopped: boolean }>,
): OutputCounts {
    const counts: OutputCounts = { error: 0, warning: 0, running: 0, stopped: 0 };
    for (const { severity, stopped } of items) {
        if (severity === 'error') counts.error += 1;
        else if (severity === 'warning') counts.warning += 1;
        if (stopped) counts.stopped += 1;
        else counts.running += 1;
    }
    return counts;
}

// The name or the destination contains the query (case-insensitive); with
// "Problems only" the output must also have an error or a warning.
export function matchesOutputFilter(
    output: { name: string; url: string | null },
    severity: OutputSeverity,
    query: string,
    problemsOnly: boolean,
): boolean {
    if (problemsOnly && severity === null) return false;
    return matchesName(query, output.name, output.url ?? '');
}

// Badges for the counts above; the zero ones are left out, and "shown of total"
// is added while a filter hides outputs.
export function outputSummaryHtml(counts: OutputCounts, shown: number, total: number): string {
    const badge = (n: number, cls: string, label: string): string =>
        n > 0 ? `<span class="badge badge-sm ${cls} whitespace-nowrap">${n} ${label}</span>` : '';
    const filtered =
        shown === total
            ? ''
            : `<span class="text-muted whitespace-nowrap" title="Showing ${shown} of ${total} outputs">${shown} of ${total}</span>`;
    return [
        filtered,
        badge(counts.error, 'badge-error', counts.error === 1 ? 'error' : 'errors'),
        badge(counts.warning, 'badge-warning', counts.warning === 1 ? 'warning' : 'warnings'),
        badge(counts.running, 'badge-success badge-soft', 'running'),
        badge(counts.stopped, 'badge-ghost', 'stopped'),
    ].join('');
}

// The empty list left by a filter, saying which filter hid everything.
export function noMatchingOutputsText(query: string, problemsOnly: boolean): string {
    const q = query.trim();
    if (problemsOnly && q) return `No outputs with problems match “${q}”.`;
    if (problemsOnly) return 'No outputs with problems.';
    return `No outputs match “${q}”.`;
}
