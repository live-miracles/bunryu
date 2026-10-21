import * as api from '../core/api.js';
import { state } from '../core/state.js';
import { escapeHtml, fmtMs, fmtMbpsValue, NO_VALUE } from '../core/utils.js';
import type { LegHistoryData, LegHistorySample } from '../types.js';

const LEG_HISTORY_WINDOW_MS = 30 * 60 * 1000;
const LEG_HISTORY_PAGE_STEP_MS = 10 * 60 * 1000;
const legHistoryOffsets = new Map<string, number>();
const legHistoryCache = new Map<string, LegHistoryData>();
const legHistoryRequestIds = new Map<string, number>();
const legHistoryInFlight = new Set<string>();
// Older pages (offset > 0) are static apart from their newest edge, so they
// are prefetched one step ahead and reused briefly. This keeps paging
// instant like the overview charts, whose full history is already client-side.
const LEG_HISTORY_PAGE_TTL_MS = 60 * 1000;
const legHistoryPageCache = new Map<string, { data: LegHistoryData; fetchedAt: number }>();
const legHistoryPrefetching = new Set<string>();

function formatLegChartTimeTick(ts: number): string {
    const date = new Date(ts);
    const minutes = date.getMinutes();
    if (minutes % 5 !== 0) return '';
    const minuteLabel = minutes.toString().padStart(2, '0');
    if (minutes % 10 !== 0) return minuteLabel;
    return `${date.getHours().toString().padStart(2, '0')}:${minuteLabel}`;
}

function legHistoryChart(
    canvasId: string,
    series: LegHistoryData['legs'],
    value: (sample: LegHistorySample) => number | null,
    maxValue: number,
    formatValue: (value: number) => string,
): void {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 130;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    const styles = getComputedStyle(canvas);
    const color = styles.color || '#9ca3af';
    const grid = 'rgba(156, 163, 175, 0.18)';
    const left = 42;
    const right = 8;
    const top = 8;
    const bottom = 22;
    const plotW = Math.max(1, width - left - right);
    const plotH = Math.max(1, height - top - bottom);
    const allSamples = series.flatMap((leg) => leg.samples);
    const minTs = Math.min(...allSamples.map((sample) => sample.ts));
    const maxTs = Math.max(...allSamples.map((sample) => sample.ts));
    const range = Math.max(1, maxTs - minTs);
    const observedMax = Math.max(...allSamples.map((sample) => value(sample) ?? 0));
    // Keep a configured ceiling for charts that need one, but let sparse or
    // low-valued series use their own range so small loss spikes are visible.
    const yMax = maxValue > 0 ? maxValue : observedMax > 0 ? observedMax * 1.2 : 1;
    ctx.clearRect(0, 0, width, height);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = color;
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
        ctx.fillText(formatValue(yMax * (1 - i / 2)), 2, y + 3);
    }
    ctx.globalAlpha = 1;
    const colors = ['#38bdf8', '#a78bfa', '#f59e0b', '#34d399', '#fb7185', '#f97316'];
    series.forEach((leg, legIndex) => {
        const points = leg.samples
            .map((sample) => {
                const current = value(sample);
                if (current === null) return null;
                return {
                    x: left + ((sample.ts - minTs) / range) * plotW,
                    y: top + (1 - Math.min(1, Math.max(0, current / yMax))) * plotH,
                };
            })
            .filter((point): point is { x: number; y: number } => point !== null);
        if (points.length === 0) return;
        ctx.strokeStyle = colors[legIndex % colors.length];
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        points.forEach((point, index) => {
            if (index === 0) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
        });
        ctx.stroke();
        if (points.length === 1) {
            ctx.fillStyle = ctx.strokeStyle;
            ctx.beginPath();
            ctx.arc(points[0].x, points[0].y, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    });
}

function renderLegHistoryCharts(pipelineId: string, data: LegHistoryData): void {
    const wrap = document.getElementById('srt-leg-history-content');
    if (!wrap) return;
    if (data.legs.length === 0 || data.legs.every((leg) => leg.samples.length === 0)) {
        wrap.innerHTML =
            '<p class="text-sm opacity-50">No SRT input history is available for this period.</p>';
        delete wrap.dataset.chartMode;
        return;
    }
    const fmt = (value: number) => (value >= 10 ? value.toFixed(0) : value.toFixed(1));
    const hasLossTotals = data.legs.some((leg) =>
        leg.samples.some((sample) => sample.lossTotal != null),
    );
    const hasDropTotals = data.legs.some((leg) =>
        leg.samples.some((sample) => sample.dropTotal != null),
    );
    if (!hasLossTotals && !hasDropTotals) {
        wrap.innerHTML =
            '<p class="text-sm opacity-50">No SRT packet loss/drop history is available for this period.</p>';
        delete wrap.dataset.chartMode;
        return;
    }
    const chartMode = `${hasLossTotals ? 'loss' : ''}${hasDropTotals ? 'drop' : ''}`;
    const legend = data.legs
        .map(
            (leg, index) =>
                `<span class="inline-flex items-center gap-1 text-xs"><span class="inline-block h-2 w-2 rounded-full" style="background:${['#38bdf8', '#a78bfa', '#f59e0b', '#34d399', '#fb7185', '#f97316'][index % 6]}"></span>${escapeHtml(leg.ip)}</span>`,
        )
        .join('');
    if (wrap.dataset.chartMode !== chartMode) {
        const lossChart = hasLossTotals
            ? '<div><div class="text-xs opacity-60 mb-1">Cumulative packet loss</div><canvas id="srt-leg-loss-chart" class="w-full h-32 text-base-content"></canvas></div>'
            : '';
        const dropChart = hasDropTotals
            ? '<div><div class="text-xs opacity-60 mb-1">Cumulative packet drops</div><canvas id="srt-leg-drop-chart" class="w-full h-32 text-base-content"></canvas></div>'
            : '';
        wrap.innerHTML = `<div class="flex flex-wrap gap-x-3 gap-y-1 mb-2">${legend}</div>
            <div class="grid grid-cols-1 gap-4">
                ${lossChart}
                ${dropChart}
            </div>`;
        wrap.dataset.chartMode = chartMode;
    }
    if (hasLossTotals) {
        legHistoryChart(
            'srt-leg-loss-chart',
            data.legs,
            (sample) => sample.lossTotal ?? null,
            0,
            (value) => fmt(value),
        );
    }
    if (hasDropTotals) {
        legHistoryChart(
            'srt-leg-drop-chart',
            data.legs,
            (sample) => sample.dropTotal ?? null,
            0,
            (value) => fmt(value),
        );
    }
}

function mergeLegHistory(
    pipelineId: string,
    data: LegHistoryData,
    from: number,
    to: number,
): LegHistoryData {
    const cached = legHistoryCache.get(pipelineId);
    if (!cached) {
        legHistoryCache.set(pipelineId, data);
        return data;
    }

    // The relay identifies a leg by source IP. Its port can change when the
    // sender reconnects, so including the port here would split one source
    // into multiple chart series and colors.
    const incomingByKey = new Map(data.legs.map((leg) => [leg.ip, leg]));
    const cachedByKey = new Map(cached.legs.map((leg) => [leg.ip, leg]));
    const keys = new Set([...cachedByKey.keys(), ...incomingByKey.keys()]);
    const legs = [...keys].map((key) => {
        const previous = cachedByKey.get(key);
        const incoming = incomingByKey.get(key);
        const samplesByTimestamp = new Map(
            (previous?.samples ?? []).map((sample) => [sample.ts, sample]),
        );
        for (const sample of incoming?.samples ?? []) samplesByTimestamp.set(sample.ts, sample);
        return {
            ip: incoming?.ip ?? previous!.ip,
            port: incoming?.port ?? previous!.port,
            samples: [...samplesByTimestamp.values()]
                .filter((sample) => sample.ts >= from && sample.ts <= to)
                .sort((a, b) => a.ts - b.ts),
        };
    });
    const merged = { ...data, from, to, legs };
    legHistoryCache.set(pipelineId, merged);
    return merged;
}

function legHistoryPageKey(pipelineId: string, offset: number): string {
    return `${pipelineId}:${offset}`;
}

function freshLegHistoryPage(pipelineId: string, offset: number): LegHistoryData | undefined {
    if (offset === 0) return undefined;
    const entry = legHistoryPageCache.get(legHistoryPageKey(pipelineId, offset));
    return entry && Date.now() - entry.fetchedAt < LEG_HISTORY_PAGE_TTL_MS ? entry.data : undefined;
}

// Best-effort: a failed prefetch is tolerated on purpose. The page simply
// isn't cached, so the next click does the normal fetch and shows its own
// error if that also fails.
async function prefetchLegHistoryPage(pipelineId: string, offset: number): Promise<void> {
    const key = legHistoryPageKey(pipelineId, offset);
    if (
        document.hidden ||
        legHistoryPrefetching.has(key) ||
        freshLegHistoryPage(pipelineId, offset)
    ) {
        return;
    }
    legHistoryPrefetching.add(key);
    try {
        const to = Date.now() - offset;
        const data = await api.getLegHistory(pipelineId, to - LEG_HISTORY_WINDOW_MS, to);
        if (!data) return;
        const now = Date.now();
        for (const [k, entry] of legHistoryPageCache) {
            if (now - entry.fetchedAt >= LEG_HISTORY_PAGE_TTL_MS) legHistoryPageCache.delete(k);
        }
        legHistoryPageCache.set(key, { data, fetchedAt: now });
    } catch {
        // See above: tolerated, falls back to an on-demand fetch.
    } finally {
        legHistoryPrefetching.delete(key);
    }
}

async function loadLegHistory(pipelineId: string, showLoading = true): Promise<void> {
    const offset = legHistoryOffsets.get(pipelineId) ?? 0;
    const requestKey = legHistoryPageKey(pipelineId, offset);
    if (legHistoryInFlight.has(requestKey)) return;
    legHistoryInFlight.add(requestKey);

    const requestId = (legHistoryRequestIds.get(pipelineId) ?? 0) + 1;
    legHistoryRequestIds.set(pipelineId, requestId);
    const isCurrentRequest = (): boolean => {
        if (legHistoryRequestIds.get(pipelineId) !== requestId) return false;
        const details = document.getElementById('srt-bonding-details');
        return !details?.dataset.pipelineId || details.dataset.pipelineId === pipelineId;
    };
    const to = Date.now() - offset;
    const from = to - LEG_HISTORY_WINDOW_MS;
    const prefetchedPage = freshLegHistoryPage(pipelineId, offset);
    const content = document.getElementById('srt-leg-history-content');
    if (content && showLoading && !prefetchedPage) {
        if (content.dataset.chartMode) {
            // Paging: keep the current charts on screen (dimmed) until the
            // new window arrives, instead of blanking them behind a
            // placeholder and flashing.
            content.classList.add('opacity-50');
        } else {
            content.innerHTML = '<p class="text-sm opacity-50">Loading leg history…</p>';
        }
    }
    const cached = offset === 0 ? legHistoryCache.get(pipelineId) : undefined;
    const cachedTimestamps =
        cached?.legs.flatMap((leg) => leg.samples.map((sample) => sample.ts)) ?? [];
    const latestCachedTs = cachedTimestamps.length > 0 ? Math.max(...cachedTimestamps) : undefined;
    try {
        const data =
            prefetchedPage ?? (await api.getLegHistory(pipelineId, from, to, latestCachedTs));
        if (!isCurrentRequest()) return;
        const content = document.getElementById('srt-leg-history-content');
        if (!content) return;
        if (!data) {
            delete content.dataset.chartMode;
            content.innerHTML =
                '<p class="text-sm text-error">Unable to load SRT input history. Please try again.</p>';
            return;
        }
        if (offset > 0 && !prefetchedPage) {
            legHistoryPageCache.set(requestKey, { data, fetchedAt: Date.now() });
        }
        const displayData = offset === 0 ? mergeLegHistory(pipelineId, data, from, to) : data;
        const range = document.getElementById('srt-leg-history-range');
        if (range) {
            const fmt = (ts: number) =>
                new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            range.innerHTML =
                offset === 0
                    ? '<span class="badge badge-success badge-xs gap-1">LIVE</span>'
                    : `<span class="font-mono text-xs opacity-60">${fmt(data.from)} – ${fmt(data.to)}</span>`;
        }
        const back = document.getElementById('srt-leg-history-back') as HTMLButtonElement | null;
        const forward = document.getElementById(
            'srt-leg-history-forward',
        ) as HTMLButtonElement | null;
        const hasOlder = data.oldestTs !== null && data.from > data.oldestTs;
        if (back) back.disabled = !hasOlder;
        if (forward) forward.disabled = offset === 0;
        renderLegHistoryCharts(pipelineId, displayData);
        if (hasOlder) void prefetchLegHistoryPage(pipelineId, offset + LEG_HISTORY_PAGE_STEP_MS);
    } catch {
        if (!isCurrentRequest()) return;
        const content = document.getElementById('srt-leg-history-content');
        if (content) {
            delete content.dataset.chartMode;
            content.innerHTML =
                '<p class="text-sm text-error">Unable to load SRT input history. Please try again.</p>';
        }
    } finally {
        legHistoryInFlight.delete(requestKey);
        // A newer request owns the dimming; only the latest one clears it.
        if (legHistoryRequestIds.get(pipelineId) === requestId) {
            document.getElementById('srt-leg-history-content')?.classList.remove('opacity-50');
        }
    }
}

function renderLegHistorySection(): string {
    return `<div id="srt-leg-history-section" class="mt-1">
        <div class="mb-2 flex items-center justify-center gap-2 px-1">
            <div class="flex items-center gap-1">
                <button id="srt-leg-history-back" type="button" class="btn btn-xs btn-ghost">&#8592; 10 min</button>
                <span id="srt-leg-history-range" class="inline-flex w-36 justify-center whitespace-nowrap"><span class="badge badge-success badge-xs gap-1">LIVE</span></span>
                <button id="srt-leg-history-forward" type="button" class="btn btn-xs btn-ghost" disabled>10 min &#8594;</button>
            </div>
        </div>
        <div id="srt-leg-history-content"><p class="text-sm opacity-50">Loading leg history…</p></div>
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
        <span class="inline-flex items-center gap-1"><span class="opacity-60">${label}</span>${info}</span>
        <span>${value}</span>
    </div>`;
}

// A section whose statistics were all unreported is left out with its title.
export function srtDetailSection(title: string, rowsHtml: string): string {
    if (!rowsHtml) return '';
    return `<div class="mb-4">
        <div class="text-xs font-semibold uppercase opacity-50 mb-1">${escapeHtml(title)}</div>
        <div class="text-xs">${rowsHtml}</div>
    </div>`;
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
    if (!pipeline) return '<p class="opacity-50 text-sm">No SRT bonding data.</p>';

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
            ? `<p class="opacity-50 text-sm">${input.bonded ? 'No bonded legs.' : 'No active SRT connection.'}</p>`
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

    return srtDetailSection('Input', inputRows) + srtDetailSection('Output', outputRows) + legsHtml;
}

function renderSrtBondingDetailsContent(pipelineId: string, target?: HTMLElement | null): void {
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = target ?? document.getElementById('logs-modal-content');
    if (!contentEl) return;

    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    if (titleEl) titleEl.textContent = `SRT Bonding Details — ${pipeline?.name ?? pipelineId}`;
    if (!pipeline) {
        contentEl.innerHTML = '<p class="opacity-50 text-sm">No SRT bonding data.</p>';
        return;
    }

    contentEl.innerHTML =
        renderLegHistorySection() +
        `<div data-srt-stats-body>${renderSrtStatsSections(pipelineId)}</div>`;
    document.getElementById('srt-leg-history-back')?.addEventListener('click', () => {
        legHistoryOffsets.set(
            pipelineId,
            (legHistoryOffsets.get(pipelineId) ?? 0) + LEG_HISTORY_PAGE_STEP_MS,
        );
        void loadLegHistory(pipelineId);
    });
    document.getElementById('srt-leg-history-forward')?.addEventListener('click', () => {
        legHistoryOffsets.set(
            pipelineId,
            Math.max(0, (legHistoryOffsets.get(pipelineId) ?? 0) - LEG_HISTORY_PAGE_STEP_MS),
        );
        void loadLegHistory(pipelineId);
    });
    void loadLegHistory(pipelineId);
}

export function renderSrtBondingDetailsInline(pipelineId: string): void {
    const target = document.getElementById('srt-bonding-details');
    if (!target) return;
    const alreadyRendered =
        target.dataset.pipelineId === pipelineId &&
        !!document.getElementById('srt-leg-history-section');
    if (alreadyRendered) {
        // The raw counters come from the already-polled state.pipelines
        // snapshot, so re-rendering them is free (no request).
        const body = target.querySelector('[data-srt-stats-body]');
        if (body) body.innerHTML = renderSrtStatsSections(pipelineId);
        // Poll refreshes re-render the live dashboard every five seconds. Do
        // not restart a paged historical request on each poll, otherwise a
        // slow request can be perpetually superseded before it renders.
        if ((legHistoryOffsets.get(pipelineId) ?? 0) === 0) {
            void loadLegHistory(pipelineId, false);
        }
        return;
    }
    target.dataset.pipelineId = pipelineId;
    renderSrtBondingDetailsContent(pipelineId, target);
    const graphs = document.getElementById('srt-bonding-graphs');
    const history = target.querySelector('#srt-leg-history-section');
    if (graphs && history) {
        graphs.innerHTML = '';
        graphs.append(history);
    }
}

function hideLogsModalClearErrors(): void {
    const clearBtn = document.getElementById('logs-modal-clear-errors') as HTMLButtonElement | null;
    if (!clearBtn) return;
    clearBtn.classList.add('hidden');
    clearBtn.onclick = null;
}

export function showSrtBondingDetails(pipelineId: string): void {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    const refreshBtn = document.getElementById('logs-modal-refresh');
    if (!modal) return;
    hideLogsModalClearErrors();

    renderSrtBondingDetailsContent(pipelineId);
    if (refreshBtn) {
        refreshBtn.classList.remove('hidden');
        refreshBtn.classList.add('inline-flex');
        refreshBtn.onclick = () => renderSrtBondingDetailsContent(pipelineId);
    }
    modal.showModal();
}
