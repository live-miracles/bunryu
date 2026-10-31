import * as api from '../core/api.js';
import { state } from '../core/state.js';
import {
    escapeHtml,
    formatBitrate,
    formatBitrateAxis,
    formatLocalTime,
    getUrlParam,
} from '../core/utils.js';
import { summarizeEventMessage } from '../core/events.js';
import {
    buildStatusCards,
    groupStatusCards,
    problemEvents,
    statusTotals,
    type StatusCard,
    type StatusDot,
} from '../core/status-grid.js';
import type { ActivityEvent } from '../types.js';
import { CHART_WINDOW_MS, drawChart } from './dashboard-charts.js';

// The Status view: every pipeline as a card with a dot per output, the host graphs and the
// recent problems, on one page. It is drawn on every dashboard poll from the same state as
// the rest of the dashboard; only the problems list is fetched on its own.

const EVENTS_REFRESH_MS = 15_000;
const PROBLEMS_SHOWN = 30;

let issuesOnly = false;
let events: ActivityEvent[] | null = null;
let eventsFetchedAt = 0;
let eventsLoading = false;

const DOT_STYLE: Record<StatusDot['status'], string> = {
    good: 'background-color:var(--dot-ok)',
    warn: 'background-color:var(--dot-warn)',
    // A ring as well as the colour, so a failure also differs by shape.
    error: 'background-color:var(--dot-bad);box-shadow:0 0 0 2px color-mix(in oklab,var(--dot-bad) 35%,transparent)',
    off: 'box-shadow:inset 0 0 0 2px var(--dot-off)',
};
const STATUS_WORD: Record<StatusDot['status'], string> = {
    good: 'running',
    warn: 'warning',
    error: 'failed',
    off: 'stopped',
};

function dotHtml(status: StatusDot['status'], title: string, sizeClass: string): string {
    return `<span class="${sizeClass} inline-block shrink-0 rounded-full" style="${DOT_STYLE[status]}" title="${escapeHtml(title)}"></span>`;
}

function badge(count: number, cls: string, label: string): string {
    return count > 0 ? `<span class="badge badge-sm ${cls}">${count} ${label}</span>` : '';
}

function cardHtml(c: StatusCard): string {
    const edge =
        c.severity === 'error' ? 'var(--dot-bad)' : c.severity === 'warn' ? 'var(--dot-warn)' : '';
    const style = edge ? ` style="border-color:color-mix(in oklab,${edge} 70%,transparent)"` : '';
    const inputTitle = `Input: ${c.inputStatus === 'good' ? 'live' : c.inputStatus === 'off' ? 'offline' : c.inputMessage || c.inputStatus}`;
    const dots = c.dots
        .map((d) =>
            dotHtml(
                d.status,
                `${d.name}: ${STATUS_WORD[d.status]}${d.message ? ` (${d.message})` : ''}`,
                'h-2.5 w-2.5',
            ),
        )
        .join('');
    // A few outputs sit on the name's line; many wrap into a block under it.
    const inline = c.dots.length <= 6;
    const summary = inline
        ? ''
        : `<span class="text-muted shrink-0 text-xs">${c.dots.length} outputs</span>${badge(c.tally.error, 'badge-error', 'failed')}${badge(c.tally.warn, 'badge-warning', 'warn')}`;
    const typeBadge = c.type
        ? `<span class="badge badge-xs badge-outline shrink-0">${escapeHtml(c.type)}</span>`
        : '';
    const body = inline
        ? `<span class="ml-auto flex shrink-0 flex-wrap items-center gap-1">${dots || '<span class="text-muted text-xs">no outputs</span>'}</span>`
        : '';
    return `<a href="/?p=${encodeURIComponent(c.id)}" data-pipeline-id="${escapeHtml(c.id)}" class="border-base-content/10 bg-base-100/50 hover:border-primary mb-2 block break-inside-avoid rounded-xl border px-3 py-2"${style}>
        <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
            ${dotHtml(c.inputStatus, inputTitle, 'h-3.5 w-3.5')}
            <span class="min-w-0 truncate font-semibold">${escapeHtml(c.name)}</span>
            ${summary}${inline ? typeBadge : ''}${body}
        </span>
        ${inline ? '' : `<span class="mt-1.5 flex flex-wrap gap-1">${dots}</span>`}
    </a>`;
}

function sideChart(id: string, label: string): string {
    return `<div class="border-base-content/10 bg-base-100/50 rounded-lg border p-2">
        <div class="mb-1 flex items-center justify-between text-xs">
            <span class="text-muted font-semibold">${label}</span>
            <span id="${id}-value" class="font-semibold tabular-nums">—</span>
        </div>
        <canvas id="${id}" style="width:100%;height:90px;display:block"></canvas>
    </div>`;
}

function problemsHtml(): string {
    if (events === null) return '<p class="text-muted py-2">Loading…</p>';
    const rows = problemEvents(events, PROBLEMS_SHOWN);
    if (rows.length === 0) {
        return '<p class="text-muted py-2">No recent warnings or errors.</p>';
    }
    return rows
        .map((e) => {
            const where =
                e.pipelineId === null
                    ? ''
                    : `<a class="link shrink-0 font-semibold" href="/?p=${e.pipelineId}" data-pipeline-id="${e.pipelineId}">${escapeHtml(e.pipelineName ?? '')}${e.outputName ? ` · ${escapeHtml(e.outputName)}` : ''}</a>`;
            const { summary } = summarizeEventMessage(e.message);
            return `<div class="border-base-200 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b py-1 last:border-0">
                <span class="badge badge-xs shrink-0 uppercase leading-none ${e.severity === 'error' ? 'badge-error' : 'badge-warning'}">${escapeHtml(e.label)}</span>
                <span class="text-muted shrink-0" title="${escapeHtml(new Date(e.ts).toLocaleString())}">${formatLocalTime(e.ts)}</span>
                ${where}
                <span class="min-w-0 basis-full break-words opacity-80" title="${escapeHtml(e.message)}">${escapeHtml(summary)}</span>
            </div>`;
        })
        .join('');
}

function refreshEventsIfStale(): void {
    if (eventsLoading || Date.now() - eventsFetchedAt < EVENTS_REFRESH_MS) return;
    eventsLoading = true;
    void api
        .getEvents()
        .then((list) => {
            if (list) events = list;
        })
        .finally(() => {
            eventsLoading = false;
            // A failed fetch waits as long as a good one before the next try.
            eventsFetchedAt = Date.now();
            if (getUrlParam('view') === 'status') renderStatusView();
        });
}

// The HTML last put into each part of the page. A part is replaced only when its HTML
// changed, so a poll that finds nothing new leaves the page alone: a dot's tooltip stays
// open, a selection survives, and the 500 dots are not rebuilt every 5 s.
const lastHtml = new Map<string, string>();

function setPart(id: string, html: string): HTMLElement | null {
    const part = document.getElementById(id);
    if (!part || lastHtml.get(id) === html) return null;
    part.innerHTML = html;
    lastHtml.set(id, html);
    return part;
}

const SKELETON = `
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2" id="status-head"></div>
    <div class="grid gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div id="status-cards" class="xl:min-h-0 xl:overflow-y-auto xl:pr-1"></div>
        <div class="flex flex-col gap-3 xl:min-h-0">
            <div class="grid grid-cols-2 gap-2">
                ${sideChart('status-chart-cpu', 'CPU')}
                ${sideChart('status-chart-ram', 'RAM')}
                ${sideChart('status-chart-rx', 'Downlink')}
                ${sideChart('status-chart-tx', 'Uplink')}
            </div>
            <div class="border-base-content/10 bg-base-100/50 flex flex-col rounded-lg border max-xl:max-h-72 xl:min-h-0 xl:flex-1">
                <div class="flex items-center justify-between px-3 pt-2 text-xs">
                    <span class="text-muted font-semibold">Recent problems</span>
                    <a class="link" data-open-logs href="/?view=logs">All events</a>
                </div>
                <div id="status-events" class="min-h-0 flex-1 overflow-y-auto px-3 pb-2 text-xs"></div>
            </div>
        </div>
    </div>`;

function wireStatusView(el: HTMLElement): void {
    // Assignment, not addEventListener: the panel persists across polls.
    el.onclick = (e) => {
        const target = e.target as Element;
        const filter = target.closest<HTMLElement>('[data-status-filter]');
        if (filter) {
            issuesOnly = filter.dataset.statusFilter === 'issues';
            renderStatusView();
            return;
        }
        const plain = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
        // A plain click opens it in this tab without a reload; Ctrl-click and middle-click
        // fall through to the browser's own new-tab handling of the link.
        if (!plain) return;
        if (target.closest('[data-open-logs]')) {
            e.preventDefault();
            void window.openSrsLogsBtn();
            return;
        }
        const link = target.closest<HTMLElement>('[data-pipeline-id]');
        if (link?.dataset.pipelineId) {
            e.preventDefault();
            window.selectPipeline(link.dataset.pipelineId);
        }
    };
}

export function renderStatusView(): void {
    const el = document.getElementById('status-col');
    if (!el) return;
    if (!document.getElementById('status-cards')) {
        el.innerHTML = SKELETON;
        lastHtml.clear();
        wireStatusView(el);
    }

    const cards = buildStatusCards(state.pipelines);
    const totals = statusTotals(cards);
    const groups = groupStatusCards(cards, state.config.groups ?? [], issuesOnly);

    const tab = (key: 'all' | 'issues', label: string, count: number): string => {
        const active = (key === 'issues') === issuesOnly;
        return `<a role="tab" data-status-filter="${key}" aria-selected="${active}" class="tab gap-1 ${active ? 'tab-active' : ''}">${label} <span class="badge badge-xs badge-ghost">${count}</span></a>`;
    };
    setPart(
        'status-head',
        `<div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div class="flex flex-wrap items-center gap-2"><span class="font-semibold">Inputs</span>
                ${badge(totals.inputs.good, 'badge-success', 'live')}${badge(totals.inputs.problem, 'badge-warning', 'with issues')}${badge(totals.inputs.off, 'badge-neutral', 'offline')}
            </div>
            <div class="flex flex-wrap items-center gap-2"><span class="font-semibold">Outputs</span>
                ${badge(totals.outputs.good, 'badge-success', 'running')}${badge(totals.outputs.warn, 'badge-warning', 'warning')}${badge(totals.outputs.error, 'badge-error', 'failed')}${badge(totals.outputs.off, 'badge-neutral', 'stopped')}
            </div>
        </div>
        <div role="tablist" class="tabs tabs-lift">
            ${tab('all', 'All pipelines', cards.length)}${tab('issues', 'Issues', totals.pipelinesWithIssues)}
        </div>`,
    );

    setPart(
        'status-cards',
        groups.length === 0
            ? `<p class="text-muted py-4">${issuesOnly ? 'No pipeline has a warning or an error.' : 'No pipelines yet.'}</p>`
            : groups
                  .map(
                      (g) =>
                          `${g.name ? `<h3 class="text-muted mt-3 mb-1.5 text-xs font-semibold tracking-wide uppercase first:mt-0">${escapeHtml(g.name)}</h3>` : ''}<div class="columns-[19rem] gap-2">${g.cards.map(cardHtml).join('')}</div>`,
                  )
                  .join(''),
    );

    // The problems list stays pinned to its newest line unless someone scrolled up.
    const eventsEl = document.getElementById('status-events');
    const eventsTop = eventsEl?.scrollTop ?? 0;
    const eventsPinned =
        !eventsEl || eventsEl.scrollTop + eventsEl.clientHeight >= eventsEl.scrollHeight - 4;
    const changed = setPart('status-events', problemsHtml());
    if (changed) changed.scrollTop = eventsPinned ? changed.scrollHeight : eventsTop;

    // The graphs change with every poll: update the values and draw again.
    const windowStart = Date.now() - CHART_WINDOW_MS;
    const samples = state.metricsHistory.filter((s) => s.ts >= windowStart);
    const last = samples[samples.length - 1];
    const fmtBps = (bps: number) => formatBitrate((bps * 8) / 1000);
    const setValue = (id: string, value: string): void => {
        const span = document.getElementById(`${id}-value`);
        if (span) span.textContent = value;
    };
    setValue('status-chart-cpu', last ? `${last.cpu}%` : '—');
    setValue(
        'status-chart-ram',
        last ? `${Math.round((last.ramUsed / last.ramTotal) * 100)}%` : '—',
    );
    setValue('status-chart-rx', last ? fmtBps(last.rxBps) : '—');
    setValue('status-chart-tx', last ? fmtBps(last.txBps) : '—');

    const fmtPct = (v: number) => `${Math.round(v)}%`;
    drawChart('status-chart-cpu', samples, (s) => s.cpu, 100, 'var(--chart-cpu)', fmtPct);
    drawChart(
        'status-chart-ram',
        samples,
        (s) => (s.ramUsed / s.ramTotal) * 100,
        100,
        'var(--chart-ram)',
        fmtPct,
    );
    drawChart(
        'status-chart-rx',
        samples,
        (s) => (s.rxBps * 8) / 1000,
        10,
        'var(--chart-rx)',
        formatBitrateAxis,
    );
    drawChart(
        'status-chart-tx',
        samples,
        (s) => (s.txBps * 8) / 1000,
        10,
        'var(--chart-tx)',
        formatBitrateAxis,
    );

    refreshEventsIfStale();
}
