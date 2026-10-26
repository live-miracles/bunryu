export function setInnerText(id: string, val: unknown): void {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val ?? '');
}

// Sets a count badge's text and hides it entirely when the count is zero,
// rather than showing an empty "0" pill.
export function setBadgeCount(id: string, count: number): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(count);
    el.classList.toggle('hidden', count === 0);
}

// Escape a string for interpolation into HTML built with template literals.
// Safe for both text content and double-quoted attribute values. Must be
// applied to every user- or publisher-controlled string (pipeline/output
// names, ffprobe track metadata, URLs, error output) before it reaches
// innerHTML.
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function getUrlParam(key: string): string | null {
    return new URLSearchParams(window.location.search).get(key);
}

export function setUrlParam(key: string, value: string | null): void {
    const url = new URL(window.location.href);
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    window.history.replaceState({}, '', url);
}

export const LOW_BITRATE_KBPS = 200;

export const STATUS_COLOR_GOOD = '#22c55e';
export const STATUS_COLOR_WARN = '#facc15';
export const STATUS_COLOR_ERROR = '#ef4444';
export const STATUS_COLOR_OFF = '#6b7280';

// The dashboard's number rule: one decimal under 10, whole numbers from 10 up
// (a value that rounds up to 10.0 counts as 10).
export function fmtUnder10(value: number): string {
    return Math.round(value * 10) / 10 < 10 ? value.toFixed(1) : String(Math.round(value));
}

// ffmpeg CPU as % of one core; copy outputs sit at 0.5-3%.
export function formatCpuPercent(percent: number): string {
    return `${fmtUnder10(percent)}%`;
}

export function formatBitrate(kbps: number | null): string {
    if (kbps === null) return '—';
    if (kbps >= 1_000_000) return `${fmtUnder10(kbps / 1_000_000)} Gbps`;
    if (kbps >= 999.5) return `${fmtUnder10(kbps / 1000)} Mbps`;
    return `${fmtUnder10(kbps)} kbps`;
}

// Y-axis tick label for a bitrate chart. The unit comes from the chart's peak
// so every tick shares it ("50k" … "200k", or "0.25M" … "1M"), and ticks stay
// distinct however small the traffic is.
export function formatBitrateAxis(kbps: number, peakKbps: number): string {
    if (kbps === 0) return '0';
    const mega = peakKbps >= 1000;
    return `${Number((mega ? kbps / 1000 : kbps).toFixed(2))}${mega ? 'M' : 'k'}`;
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${fmtUnder10(bytes / 1024 ** 3)} GB`;
    if (bytes >= 1024 ** 2) return `${fmtUnder10(bytes / 1024 ** 2)} MB`;
    return `${fmtUnder10(bytes / 1024)} KB`;
}

// Shared formatter for millisecond durations (RTT, negotiated latency,
// receive/send buffer occupancy): the dashboard's number rule.
// What the fmt* helpers show for a value the source did not report.
export const NO_VALUE = '—';

export function fmtMs(ms: number | null | undefined): string {
    return ms != null ? `${fmtUnder10(ms)} ms` : NO_VALUE;
}

// For a value already expressed in Mb/s (relay bandwidth/rate fields), as
// opposed to formatBitrate above which takes raw kb/s.
export function fmtMbpsValue(v: number | null | undefined): string {
    return v != null ? formatBitrate(v * 1000) : NO_VALUE;
}

export function formatLocalTime(ts: number): string {
    return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

// How long before `nowMs` something happened: "just now", "40 s ago", "5 min ago",
// "3 h ago", "2 d ago". A clock time alone does not say whether it is stale; the exact
// time stays in the element's title.
export function formatAgo(ts: number, nowMs: number): string {
    const s = Math.max(0, Math.floor((nowMs - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s} s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

export function formatLocalDateTime(ts: number): string {
    return new Date(ts).toLocaleString();
}

export function formatClockTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function maskStreamKey(key: string | null | undefined): string {
    const k = String(key ?? '');
    const idx = k.indexOf('_');
    if (idx < 0) return k;
    const name = k.slice(0, idx);
    const secret = k.slice(idx + 1);
    if (secret.length <= 4) return `${name}_${secret}`;
    return `${name}_${secret.slice(0, 2)}...${secret.slice(-2)}`;
}

// Replaces el's HTML on a periodic re-render without losing the horizontal
// scroll position of its tables (mobile). Scrollers are matched by index; if
// their number changed (a section appeared or disappeared) nothing is restored.
export function setHtmlKeepScroll(el: HTMLElement, html: string): void {
    const before = Array.from(el.querySelectorAll<HTMLElement>('.overflow-x-auto'));
    const positions = before.map((scroller) => scroller.scrollLeft);
    el.innerHTML = html;
    const after = Array.from(el.querySelectorAll<HTMLElement>('.overflow-x-auto'));
    if (after.length !== positions.length) return;
    after.forEach((scroller, i) => {
        scroller.scrollLeft = positions[i];
    });
}

// Disables a button and shows a spinner while an async action runs, so the
// user gets immediate feedback even when the server takes a moment to respond.
export async function withBusy(
    btn: HTMLButtonElement | null | undefined,
    fn: () => Promise<void>,
): Promise<void> {
    if (!btn) {
        await fn();
        return;
    }
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const original = btn.innerHTML;
    const wasDisabled = btn.disabled;
    btn.disabled = true;
    btn.innerHTML = '<span class="loading loading-spinner loading-xs"></span>';
    try {
        await fn();
    } finally {
        // Only restore if the button is still in the DOM (it may have been
        // re-rendered or removed by the refresh that the action triggered).
        if (btn.isConnected) {
            btn.innerHTML = original;
            btn.disabled = wasDisabled;
            delete btn.dataset.busy;
        }
    }
}

// Briefly reveals a green checkmark next to a Save button as confirmation,
// then hides it again. Safe to call repeatedly in quick succession.
export function flashSaveSuccess(id: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('hidden');
    const existingTimer = Number(el.dataset.flashTimer);
    if (existingTimer) window.clearTimeout(existingTimer);
    el.dataset.flashTimer = String(window.setTimeout(() => el.classList.add('hidden'), 1000));
}

// A modal dialog is in the browser's top layer, above any z-index. The notice is a
// popover, which joins the top layer later and so shows above an open dialog.
let copiedNoticeTimer: number | undefined;
function showCopiedNotice(): void {
    const el = document.getElementById('copied-notification');
    if (!el) return;
    el.classList.remove('hidden');
    try {
        el.showPopover?.();
    } catch {
        /* already showing */
    }
    window.clearTimeout(copiedNoticeTimer);
    copiedNoticeTimer = window.setTimeout(() => {
        try {
            el.hidePopover?.();
        } catch {
            /* already hidden */
        }
        el.classList.add('hidden');
    }, 1500);
}

export async function copyText(text: string): Promise<void> {
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        showCopiedNotice();
    } catch {
        /* ignore */
    }
}

export interface ConfirmOptions {
    title: string;
    message: string;
    confirmLabel?: string;
    // Styles the confirm button as destructive (red) instead of the accent colour.
    danger?: boolean;
}

// Styled replacement for window.confirm(). Resolves true only when the user
// presses the confirm button; Cancel, Escape and a backdrop click all resolve
// false. A call made while a confirmation is already open resolves false.
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
    const dialog = document.getElementById('confirm-modal') as HTMLDialogElement | null;
    const okBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    if (!dialog || !okBtn || !cancelBtn) return Promise.resolve(false);
    if (dialog.open) return Promise.resolve(false);

    setInnerText('confirm-modal-title', opts.title);
    setInnerText('confirm-modal-message', opts.message);
    okBtn.textContent = opts.confirmLabel ?? 'Confirm';
    okBtn.classList.toggle('btn-error', !!opts.danger);
    okBtn.classList.toggle('btn-accent', !opts.danger);

    return new Promise((resolve) => {
        dialog.returnValue = 'cancel';
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {
            once: true,
        });
        dialog.showModal();
        // Destructive confirmations default focus to Cancel so a stray Enter is safe.
        (opts.danger ? cancelBtn : okBtn).focus();
    });
}
