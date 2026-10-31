import * as api from '../core/api.js';
import { state } from '../core/state.js';
import { escapeHtml, fmtMs, fmtMbpsValue, NO_VALUE } from '../core/utils.js';
import { createLegHistory, type LegHistoryRequest } from '../core/leg-history.js';
import type { LegHistoryData, LegHistorySample } from '../types.js';

const legHistory = createLegHistory({
    fetch: api.getLegHistory,
    now: () => Date.now(),
    hidden: () => document.hidden,
});

const LEG_COLORS = ['#38bdf8', '#a78bfa', '#f59e0b', '#34d399', '#fb7185', '#f97316'];

function formatLegChartTimeTick(ts: number): string {
    const date = new Date(ts);
    const minutes = date.getMinutes();
    if (minutes % 5 !== 0) return '';
    const minuteLabel = minutes.toString().padStart(2, '0');
    if (minutes % 10 !== 0) return minuteLabel;
    return `${date.getHours().toString().padStart(2, '0')}:${minuteLabel}`;
}

// The value axis of a cumulative-counter chart. It spans what the window holds, not
// zero up: after hours of accumulated drops the next step would be a hair on a scale
// starting at zero. The span is a whole, even number so the middle label is whole too,
// and at least 2 so a flat line still has an axis.
export function chartValueRange(values: number[]): { min: number; max: number } {
    if (values.length === 0) return { min: 0, max: 2 };
    const min = Math.max(0, Math.floor(Math.min(...values)));
    const span = Math.max(2, 2 * Math.ceil((Math.max(...values) - min) / 2));
    return { min, max: min + span };
}

// One leg's chart. Each leg has its own, with its own value axis: two legs with very
// different counts on one axis would flatten the quieter one.
function legHistoryChart(
    canvasId: string,
    leg: LegHistoryData['legs'][number],
    color: string,
    // Every leg, so all the charts cover the same time range.
    allLegs: LegHistoryData['legs'],
    value: (sample: LegHistorySample) => number | null,
    formatValue: (value: number) => string,
): void {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 96;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    const textColor = getComputedStyle(canvas).color || '#9ca3af';
    const grid = 'rgba(156, 163, 175, 0.18)';
    ctx.font = '10px sans-serif';
    const timeSamples = allLegs.flatMap((leg) => leg.samples);
    const { min: yMin, max: yMax } = chartValueRange(
        leg.samples.map(value).filter((current): current is number => current !== null),
    );
    const yLabels = [0, 1, 2].map((i) => formatValue(yMax - ((yMax - yMin) * i) / 2));
    // Wide enough for the longest label, which grows with the counts.
    const left = Math.max(42, ...yLabels.map((label) => ctx.measureText(label).width + 8));
    const right = 8;
    const top = 8;
    const bottom = 22;
    const plotW = Math.max(1, width - left - right);
    const plotH = Math.max(1, height - top - bottom);
    const minTs = Math.min(...timeSamples.map((sample) => sample.ts));
    const maxTs = Math.max(...timeSamples.map((sample) => sample.ts));
    const range = Math.max(1, maxTs - minTs);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = textColor;
    ctx.globalAlpha = 0.65;
    const tickMinutes = 1;
    const tickIntervalMs = tickMinutes * 60_000;
    const firstMinute = Math.ceil(minTs / tickIntervalMs) * tickIntervalMs;
    ctx.textAlign = 'center';
    for (let tickTs = firstMinute; tickTs <= maxTs; tickTs += tickIntervalMs) {
        const x = left + ((tickTs - minTs) / range) * plotW;
        ctx.strokeStyle = grid;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, height - bottom);
        ctx.stroke();
        ctx.fillText(formatLegChartTimeTick(tickTs), x, height - 5);
    }
    ctx.textAlign = 'start';
    for (let i = 0; i <= 2; i++) {
        const y = top + (plotH * i) / 2;
        ctx.strokeStyle = grid;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(width - right, y);
        ctx.stroke();
        ctx.fillText(yLabels[i], 2, y + 3);
    }
    ctx.globalAlpha = 1;
    const points = leg.samples
        .map((sample) => {
            const current = value(sample);
            if (current === null) return null;
            return {
                x: left + ((sample.ts - minTs) / range) * plotW,
                y: top + (1 - Math.min(1, Math.max(0, (current - yMin) / (yMax - yMin)))) * plotH,
            };
        })
        .filter((point): point is { x: number; y: number } => point !== null);
    if (points.length === 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    if (points.length === 1) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, 2.5, 0, Math.PI * 2);
        ctx.fill();
    }
}

function renderLegHistoryCharts(pipelineId: string, data: LegHistoryData): void {
    const wrap = document.getElementById('srt-leg-history-content');
    if (!wrap) return;
    if (data.legs.length === 0 || data.legs.every((leg) => leg.samples.length === 0)) {
        wrap.innerHTML =
            '<p class="text-sm text-muted">No SRT input history is available for this period.</p>';
        delete wrap.dataset.chartMode;
        return;
    }
    const fmt = (value: number) => value.toLocaleString();
    const hasLossTotals = data.legs.some((leg) =>
        leg.samples.some((sample) => sample.lossTotal != null),
    );
    const hasDropTotals = data.legs.some((leg) =>
        leg.samples.some((sample) => sample.dropTotal != null),
    );
    if (!hasLossTotals && !hasDropTotals) {
        wrap.innerHTML =
            '<p class="text-sm text-muted">No SRT packet loss/drop history is available for this period.</p>';
        delete wrap.dataset.chartMode;
        return;
    }
    // The canvases are rebuilt only when the set of charts changes (a leg appears or a
    // counter starts being reported), not on every poll.
    const chartMode = `${hasLossTotals ? 'loss' : ''}${hasDropTotals ? 'drop' : ''}:${data.legs.map((leg) => leg.ip).join(',')}`;
    const kinds = [
        ...(hasLossTotals
            ? [
                  {
                      id: 'loss',
                      title: 'Cumulative packet loss',
                      value: (sample: LegHistorySample) => sample.lossTotal ?? null,
                  },
              ]
            : []),
        ...(hasDropTotals
            ? [
                  {
                      id: 'drop',
                      title: 'Cumulative packet drops',
                      value: (sample: LegHistorySample) => sample.dropTotal ?? null,
                  },
              ]
            : []),
    ];
    const colorOf = (index: number): string => LEG_COLORS[index % LEG_COLORS.length];
    if (wrap.dataset.chartMode !== chartMode) {
        wrap.innerHTML = data.legs
            .map(
                (leg, index) => `<div class="mb-3">
            <div class="mb-1 inline-flex items-center gap-1 text-xs font-semibold"><span class="inline-block h-2 w-2 rounded-full" style="background:${colorOf(index)}"></span>${escapeHtml(leg.ip)}</div>
            <div class="grid grid-cols-1 gap-x-4 gap-y-2 @2xl:grid-cols-2">${kinds
                .map(
                    (kind) =>
                        `<div><div class="text-xs text-muted mb-1">${kind.title}</div><canvas id="srt-leg-${kind.id}-chart-${index}" class="w-full h-24 text-base-content"></canvas></div>`,
                )
                .join('')}</div>
        </div>`,
            )
            .join('');
        wrap.dataset.chartMode = chartMode;
    }
    data.legs.forEach((leg, index) => {
        for (const kind of kinds) {
            legHistoryChart(
                `srt-leg-${kind.id}-chart-${index}`,
                leg,
                colorOf(index),
                data.legs,
                kind.value,
                fmt,
            );
        }
    });
}

const LEG_HISTORY_ERROR_HTML =
    '<p class="text-sm text-error">Unable to load SRT input history. Please try again.</p>';

async function loadLegHistory(pipelineId: string, request: LegHistoryRequest): Promise<void> {
    const load = legHistory.load(pipelineId, request);
    if (!load) return;
    const loading = document.getElementById('srt-leg-history-content');
    if (loading && request !== 'poll' && load.waiting) {
        if (loading.dataset.chartMode) {
            // Paging: keep the current charts on screen (dimmed) until the
            // new window arrives, instead of blanking them behind a
            // placeholder and flashing.
            loading.classList.add('opacity-50');
        } else {
            loading.innerHTML = '<p class="text-sm text-muted">Loading leg history…</p>';
        }
    }
    const outcome = await load.outcome;
    // A newer request owns the screen, including the dimming.
    if (outcome.status === 'superseded') return;
    const content = document.getElementById('srt-leg-history-content');
    try {
        if (!content) return;
        if (outcome.status === 'failed') {
            delete content.dataset.chartMode;
            content.innerHTML = LEG_HISTORY_ERROR_HTML;
            return;
        }
        const { view } = outcome;
        const range = document.getElementById('srt-leg-history-range');
        if (range) {
            const fmt = (ts: number) =>
                new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            range.innerHTML = view.live
                ? '<span class="badge badge-success badge-xs gap-1">LIVE</span>'
                : `<span class="font-mono text-xs text-muted">${fmt(view.data.from)} – ${fmt(view.data.to)}</span>`;
        }
        const back = document.getElementById('srt-leg-history-back') as HTMLButtonElement | null;
        const forward = document.getElementById(
            'srt-leg-history-forward',
        ) as HTMLButtonElement | null;
        if (back) back.disabled = !view.hasOlder;
        if (forward) forward.disabled = !view.hasNewer;
        renderLegHistoryCharts(pipelineId, view.data);
    } catch {
        if (content) {
            delete content.dataset.chartMode;
            content.innerHTML = LEG_HISTORY_ERROR_HTML;
        }
    } finally {
        content?.classList.remove('opacity-50');
    }
}

function renderLegHistorySection(): string {
    return `<div id="srt-leg-history-section" class="mx-auto mt-1 w-full max-w-5xl">
        <div class="mb-2 flex items-center justify-center gap-2 px-1">
            <div class="flex items-center gap-1">
                <button id="srt-leg-history-back" type="button" class="btn btn-xs btn-ghost">&#8592; 10 min</button>
                <span id="srt-leg-history-range" class="inline-flex w-36 justify-center whitespace-nowrap"><span class="badge badge-success badge-xs gap-1">LIVE</span></span>
                <button id="srt-leg-history-forward" type="button" class="btn btn-xs btn-ghost" disabled>10 min &#8594;</button>
            </div>
        </div>
        <div id="srt-leg-history-content" class="@container"><p class="text-sm text-muted">Loading leg history…</p></div>
    </div>`;
}

// Hover explanations for each statistic, keyed by the row label. Shown via the
// shared `.js-tooltip` portal (see initHoverTooltips in render.ts).
const SRT_STAT_DESCRIPTIONS: Record<string, string> = {
    IP: 'Remote IP address of the sender (encoder) for this bonded link.',
    Port: 'Remote UDP port the sender is transmitting from.',
    Health: 'Leg health based on its connection state and whether packets are still flowing. OK is healthy, WARN is pending or stalled, ERROR is an unknown state or heavy packet drops.',
    'Health issue': 'The specific condition that moved this link out of OK health.',
    State: 'Whether this leg is currently connected and delivering packets.',
    'Recv Packets Total':
        'Total SRT data packets received, including retransmitted copies and duplicates across bonded legs.',
    'Recv Unique Packets Total':
        'Packets received after removing duplicates across bonded legs — what is actually delivered to the stream.',
    'Recv Loss Total':
        'Packets detected as missing on the network (sequence gaps). SRT tries to recover them by retransmission, so loss does not always mean lost video.',
    'Recv Drop Total':
        'Packets that were never recovered in time and were dropped. These cause visible glitches or audio/video artefacts.',
    'Retransmit Total':
        'Packets that had to be sent again because the receiver reported them missing. High values indicate a lossy network.',
    'Sent Packets Total':
        'Total SRT data packets sent to the destination, including retransmissions.',
    'Send Loss Total':
        'Packets the destination reported as lost and requested again (NAK). Indicates loss on the path to the destination.',
    'Send Drop Total':
        'Packets dropped on the sender because they were too late to be delivered within the latency window.',
    RTT: 'Round-Trip Time: how long a packet takes to travel to the peer and back. Higher RTT needs a larger latency setting to allow retransmissions.',
    Latency:
        'Negotiated SRT latency: the buffer window that lets SRT retransmit lost packets before playout. Larger is safer on bad networks but adds delay.',
    Bandwidth:
        'Estimated link capacity measured by SRT packet probing. If the stream rate approaches this, expect loss.',
    'Recv Rate': 'Current incoming data rate on this link.',
    'Send Rate': 'Current outgoing data rate to the destination.',
    'Belated Total':
        'Packets that arrived after their scheduled delivery time and were too late to use.',
    'Belated Avg':
        'Average lateness of belated packets. Consistently high values suggest increasing latency.',
    'Undecrypt Total':
        'Packets that could not be decrypted, typically due to a passphrase mismatch or key-rotation problem.',
    'Reorder Distance':
        'Largest observed out-of-order gap, in packets. High values point to multi-path or heavily jittered delivery.',
    'Recv Buffer': 'Amount of media currently held in the receive buffer waiting to be played out.',
    'Send Buffer':
        'Amount of media currently queued in the send buffer awaiting delivery or acknowledgement.',
};

const ICON_INFO = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;

// A statistic the relay did not report (null, shown as NO_VALUE) has no row; a
// reported 0 does, since "no drops" is worth seeing.
export function srtDetailRow(label: string, value: string): string {
    if (value === NO_VALUE || value === '') return '';
    const description = SRT_STAT_DESCRIPTIONS[label];
    const info = description
        ? `<span class="js-tooltip inline-flex shrink-0 opacity-50 hover:opacity-100" tabindex="0" aria-label="${escapeHtml(description)}">${ICON_INFO}<div class="js-tooltip-content hidden"><div class="max-w-xs text-xs whitespace-normal">${escapeHtml(description)}</div></div></span>`
        : '';
    return `<div class="flex items-center gap-3 py-1 border-b border-base-content/10 last:border-b-0">
        <span class="inline-flex items-center gap-1"><span class="text-muted">${label}</span>${info}</span>
        <span>${value}</span>
    </div>`;
}

// A section whose statistics were all unreported is left out with its title.
export function srtDetailSection(title: string, rowsHtml: string): string {
    if (!rowsHtml) return '';
    return `<section class="border-base-content/10 bg-base-100/50 min-w-0 rounded-lg border p-2">
        <div class="text-xs font-semibold uppercase text-muted mb-1">${escapeHtml(title)}</div>
        <div class="text-xs">${rowsHtml}</div>
    </section>`;
}

function fmtRawCount(n: number | null | undefined): string {
    return n != null ? n.toLocaleString() : NO_VALUE;
}

// Full, unabbreviated dump of every field the relay reports for a stream's
// input/output/legs — the compact stats row and bonded-legs table only
// surface a curated subset, this is the "show me everything" escape hatch.
// Split from showSrtBondingDetails so the modal's refresh button can re-pull
// the latest polled state.pipelines snapshot without reopening the dialog.
function renderSrtStatsSections(pipelineId: string): string {
    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) return '<p class="text-muted text-sm">No SRT relay data.</p>';

    const { input, output } = pipeline.srtBonding;

    const inputRows = (
        input.legs.length > 0
            ? [
                  srtDetailRow('Recv Packets Total', fmtRawCount(input.recvPacketsTotal)),
                  srtDetailRow(
                      'Recv Unique Packets Total',
                      fmtRawCount(input.recvUniquePacketsTotal),
                  ),
                  srtDetailRow('Recv Drop Total', fmtRawCount(input.recvDropTotal)),
                  srtDetailRow('Latency', fmtMs(input.latencyMs)),
              ]
            : [
                  srtDetailRow('Recv Packets Total', fmtRawCount(input.recvPacketsTotal)),
                  srtDetailRow(
                      'Recv Unique Packets Total',
                      fmtRawCount(input.recvUniquePacketsTotal),
                  ),
                  srtDetailRow('Recv Loss Total', fmtRawCount(input.recvLossTotal)),
                  srtDetailRow('Recv Drop Total', fmtRawCount(input.recvDropTotal)),
                  srtDetailRow('Retransmit Total', fmtRawCount(input.retransTotal)),
                  srtDetailRow('RTT', fmtMs(input.rttMs)),
                  srtDetailRow('Latency', fmtMs(input.latencyMs)),
                  srtDetailRow('Bandwidth', fmtMbpsValue(input.bandwidthMbps)),
                  srtDetailRow('Recv Rate', fmtMbpsValue(input.recvRateMbps)),
                  srtDetailRow('Belated Total', fmtRawCount(input.belatedTotal)),
                  srtDetailRow('Belated Avg', fmtMs(input.belatedAvgMs)),
                  srtDetailRow('Undecrypt Total', fmtRawCount(input.undecryptTotal)),
                  srtDetailRow('Reorder Distance', fmtRawCount(input.reorderDistance)),
                  srtDetailRow('Recv Buffer', fmtMs(input.rcvBufMs)),
              ]
    ).join('');

    const outputRows = [
        srtDetailRow('Sent Packets Total', fmtRawCount(output.sentPacketsTotal)),
        srtDetailRow('Send Loss Total', fmtRawCount(output.sendLossTotal)),
        srtDetailRow('Send Drop Total', fmtRawCount(output.sendDropTotal)),
        srtDetailRow('Retransmit Total', fmtRawCount(output.retransTotal)),
        srtDetailRow('RTT', fmtMs(output.rttMs)),
        srtDetailRow('Latency', fmtMs(output.latencyMs)),
        srtDetailRow('Bandwidth', fmtMbpsValue(output.bandwidthMbps)),
        srtDetailRow('Send Rate', fmtMbpsValue(output.sendRateMbps)),
        srtDetailRow('Undecrypt Total', fmtRawCount(output.undecryptTotal)),
        srtDetailRow('Send Buffer', fmtMs(output.sndBufMs)),
    ].join('');

    const legsHtml =
        input.legs.length === 0
            ? `<p class="text-muted text-sm">${input.bonded ? 'No bonded legs.' : 'No active SRT connection.'}</p>`
            : input.legs
                  .map((leg, idx) => {
                      const legRows = [
                          srtDetailRow('IP', escapeHtml(leg.ip)),
                          srtDetailRow('Port', String(leg.port)),
                          srtDetailRow(
                              'Health',
                              (
                                  leg.health ?? (leg.state === 'running' ? 'ok' : 'warn')
                              ).toUpperCase(),
                          ),
                          ...(leg.healthReason
                              ? [srtDetailRow('Health issue', escapeHtml(leg.healthReason))]
                              : []),
                          srtDetailRow('State', escapeHtml(leg.state)),
                          srtDetailRow('RTT', fmtMs(leg.rttMs)),
                          srtDetailRow('Latency', fmtMs(leg.latencyMs)),
                          srtDetailRow('Recv Packets Total', fmtRawCount(leg.recvPacketsTotal)),
                          srtDetailRow(
                              'Recv Unique Packets Total',
                              fmtRawCount(leg.recvUniquePacketsTotal),
                          ),
                          srtDetailRow('Recv Loss Total', fmtRawCount(leg.recvLossTotal)),
                          srtDetailRow('Recv Drop Total', fmtRawCount(leg.recvDropTotal)),
                          srtDetailRow('Retransmit Total', fmtRawCount(leg.retransTotal)),
                          srtDetailRow('Bandwidth', fmtMbpsValue(leg.bandwidthMbps)),
                          srtDetailRow('Recv Rate', fmtMbpsValue(leg.recvRateMbps)),
                          srtDetailRow('Belated Total', fmtRawCount(leg.belatedTotal)),
                          srtDetailRow('Belated Avg', fmtMs(leg.belatedAvgMs)),
                          srtDetailRow('Undecrypt Total', fmtRawCount(leg.undecryptTotal)),
                          srtDetailRow('Reorder Distance', fmtRawCount(leg.reorderDistance)),
                          srtDetailRow('Recv Buffer', fmtMs(leg.rcvBufMs)),
                      ].join('');
                      return srtDetailSection(
                          `${input.bonded ? `Leg ${idx + 1}` : 'Source'} — ${escapeHtml(leg.ip)}`,
                          legRows,
                      );
                  })
                  .join('');

    return `<div class="srt-stat-grid">${srtDetailSection('Input', inputRows)}${legsHtml}${srtDetailSection('Output', outputRows)}</div>`;
}

function renderSrtBondingDetailsContent(pipelineId: string, target?: HTMLElement | null): void {
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = target ?? document.getElementById('logs-modal-content');
    if (!contentEl) return;

    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    if (titleEl) titleEl.textContent = `SRT Relay Details — ${pipeline?.name ?? pipelineId}`;
    if (!pipeline) {
        contentEl.innerHTML = '<p class="text-muted text-sm">No SRT relay data.</p>';
        return;
    }

    contentEl.innerHTML =
        renderLegHistorySection() +
        `<div class="font-sans" data-srt-stats-body>${renderSrtStatsSections(pipelineId)}</div>`;
    document.getElementById('srt-leg-history-back')?.addEventListener('click', () => {
        void loadLegHistory(pipelineId, 'older');
    });
    document.getElementById('srt-leg-history-forward')?.addEventListener('click', () => {
        void loadLegHistory(pipelineId, 'newer');
    });
    void loadLegHistory(pipelineId, 'open');
}

export function showSrtBondingDetails(pipelineId: string): void {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    if (!modal) return;

    modal.classList.add('srt-details-modal');
    modal.dataset.srtPipelineId = pipelineId;
    renderSrtBondingDetailsContent(pipelineId);
    fitSrtDetailsDialog(modal);
    modal.showModal();
}

export function refreshSrtBondingDetailsModal(pipelineId: string): void {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    if (!modal?.open || modal.dataset.srtPipelineId !== pipelineId) return;
    const statsBody = modal.querySelector('[data-srt-stats-body]');
    if (statsBody) statsBody.innerHTML = renderSrtStatsSections(pipelineId);
    fitSrtDetailsDialog(modal);
    // Polls re-render the dashboard every five seconds; a paged window is left alone
    // (see LegHistoryRequest), so a slow historical request is not superseded by each one.
    void loadLegHistory(pipelineId, 'poll');
}

function fitSrtDetailsDialog(modal: HTMLDialogElement): void {
    const box = modal.querySelector('.modal-box') as HTMLElement | null;
    const grid = modal.querySelector('.srt-stat-grid') as HTMLElement | null;
    if (!box || !grid) return;

    const boxStyle = getComputedStyle(box);
    const horizontalPadding =
        Number.parseFloat(boxStyle.paddingLeft) + Number.parseFloat(boxStyle.paddingRight);
    const maxWidth = window.innerWidth * 0.96;
    const availableContentWidth = Math.max(1, maxWidth - horizontalPadding);
    const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 8;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const maxColumnWidth = 22 * rem;
    const itemCount = Math.max(1, grid.children.length);
    const columns = Math.max(
        1,
        Math.min(itemCount, Math.floor((availableContentWidth + gap) / (maxColumnWidth + gap))),
    );
    const columnWidth = Math.min(
        maxColumnWidth,
        (availableContentWidth - gap * (columns - 1)) / columns,
    );
    const gridWidth = columnWidth * columns + gap * (columns - 1);

    box.style.width = `${gridWidth + horizontalPadding}px`;
    box.style.maxWidth = `${maxWidth}px`;
    grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, ${columnWidth}px))`;
}

if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
        const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
        if (modal?.open && modal.classList.contains('srt-details-modal'))
            fitSrtDetailsDialog(modal);
    });
}
