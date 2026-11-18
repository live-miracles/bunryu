import { getKeyVaultStatus } from '../core/api.js';
import { escapeHtml, formatAgo, formatLocalDateTime, getUrlParam } from '../core/utils.js';
import type { KeyVaultStatusData } from '../types.js';

// The line under the Key Vault settings that says whether the reports get through. The server
// words the problem; this only shows it, with the times against the server's clock.

export function statusHtml(data: KeyVaultStatusData): string {
    const { status, nowMs } = data;
    if (!status) return '<span class="opacity-70">Reports are off.</span>';
    const ago = (ts: number) =>
        `<span title="${escapeHtml(formatLocalDateTime(ts))}">${formatAgo(ts, nowMs)}</span>`;
    if (status.state === 'failing' && status.problem) {
        const since = status.failingSinceMs === null ? '' : ` since ${ago(status.failingSinceMs)}`;
        const last =
            status.lastReportAtMs === null
                ? 'No report has gone through yet.'
                : `The last report went through ${ago(status.lastReportAtMs)}.`;
        return `<span class="text-error font-medium">Not reaching Key Vault${since}.</span> ${escapeHtml(status.problem)} <span class="opacity-70">${last}</span>`;
    }
    if (status.state === 'ok' && status.lastReportAtMs !== null) {
        const skipped = status.skipped
            ? ` <span class="text-warning">Key Vault left out ${status.skipped} ${status.skipped === 1 ? 'entry' : 'entries'} it could not use; see its function logs.</span>`
            : '';
        return `<span class="text-success font-medium">Connected.</span> Last report went through ${ago(status.lastReportAtMs)}.${skipped}`;
    }
    return '<span class="opacity-70">Waiting for the first report to go through.</span>';
}

function render(data: KeyVaultStatusData | null): void {
    const el = document.getElementById('settings-key-vault-status');
    if (!el) return;
    // A failed fetch leaves what is shown: the connection banner already says the server is
    // unreachable.
    if (data) el.innerHTML = statusHtml(data);
}

// Fetched when Settings opens and with every dashboard refresh while it is the open view, so
// there is no timer of its own and nothing is asked while another view is showing.
export async function refreshKeyVaultStatus(): Promise<void> {
    if (getUrlParam('view') !== 'settings') return;
    render(await getKeyVaultStatus());
}
