import { state } from '../core/state.js';
import { escapeHtml, fmtMs, formatClockTime, formatLocalTime } from '../core/utils.js';
import { CHART_SCROLL_STEP_MS, CHART_WINDOW_MS, drawProbeChart } from './dashboard-charts.js';

export function renderHostConnectionsOverview(): void {
    const hostsCol = document.getElementById('hosts-col');
    if (!hostsCol) return;

    const configuredTargets = state.config.hostProbeTargets ?? [];
    const targets = state.hostProbes.targets ?? [];
    if (configuredTargets.length === 0) {
        hostsCol.innerHTML = `
            <div class="rounded-xl border border-dashed border-base-content/15 p-8 text-center">
                <h2 class="text-lg font-semibold">No Host Probes Configured</h2>
                <p class="mt-2 text-sm opacity-60">Open Settings and add up to 10 host targets to monitor connectivity.</p>
            </div>`;
        return;
    }

    const allHistory = targets.flatMap((entry) => entry.history);
    const oldest =
        allHistory.length > 0
            ? allHistory.reduce((min, sample) => Math.min(min, sample.ts), allHistory[0].ts)
            : null;
    const offset = state.hostChartOffsetMs;
    const windowEnd = Date.now() - offset;
    const windowStart = windowEnd - CHART_WINDOW_MS;
    const maxOffset = oldest != null ? Math.max(0, Date.now() - oldest - CHART_WINDOW_MS) : 0;
    const atLive = offset === 0;
    const atStart = offset >= maxOffset && maxOffset > 0;
    const rangeLabel = `<span class="inline-flex justify-center w-28">${
        atLive
            ? `<span class="badge badge-success badge-xs gap-1">LIVE</span>`
            : `<span class="font-mono text-xs opacity-60">${formatClockTime(windowStart)} – ${formatClockTime(windowEnd)}</span>`
    }</span>`;

    const rendered = targets.map((entry) => {
        const latest = entry.latestSample;
        const windowSamples = entry.history.filter(
            (sample) => sample.ts >= windowStart && sample.ts <= windowEnd,
        );
        const highestLatency = windowSamples.reduce<number | null>((max, sample) => {
            if (sample.latencyMs == null) return max;
            return max == null ? sample.latencyMs : Math.max(max, sample.latencyMs);
        }, null);
        const latestStatus = !latest
            ? '<span class="badge badge-sm badge-neutral">No Data</span>'
            : latest.ok
              ? '<span class="badge badge-sm badge-success">Healthy</span>'
              : '<span class="badge badge-sm badge-error">Down</span>';
        const lastSeen = latest ? formatLocalTime(latest.ts) : '—';
        const row = `<tr>
                <td class="font-semibold">${escapeHtml(entry.target.label)}</td>
                <td class="font-mono text-xs">${escapeHtml(entry.target.host)}:${entry.target.port}</td>
                <td>${latestStatus}</td>
                <td class="font-mono text-xs">${fmtMs(latest?.latencyMs)}</td>
                <td class="font-mono text-xs">${fmtMs(highestLatency)}</td>
                <td class="font-mono text-xs">${fmtMs(entry.averageLatencyMs)}</td>
                <td class="font-mono text-xs">${entry.historyFailureCount}</td>
                <td class="font-mono text-xs">${lastSeen}</td>
                <td class="font-mono text-xs">${escapeHtml(latest?.resolvedAddress ?? '—')}</td>
            </tr>`;

        // "no recent failures" must reflect the visible window, not just the
        // single latest sample — a probe can fail repeatedly and still recover
        // on the very next tick, which would otherwise mask the burst.
        const windowFailures = windowSamples.filter((sample) => !sample.ok);
        const lastWindowFailure = windowFailures[windowFailures.length - 1] ?? null;
        const errorText =
            latest && !latest.ok
                ? (latest.error ?? 'probe failed')
                : lastWindowFailure
                  ? `${windowFailures.length} failure${windowFailures.length === 1 ? '' : 's'} in this window, last at ${formatLocalTime(lastWindowFailure.ts)}`
                  : 'no recent failures';
        const errorTone =
            latest && !latest.ok ? 'text-error' : lastWindowFailure ? 'text-warning' : 'opacity-60';
        const canvasId = `host-probe-chart-${entry.target.slot}`;
        const card = `<div class="bg-base-300 rounded-xl p-4">
                <div class="mb-3 flex items-start justify-between gap-3">
                    <div>
                        <h3 class="font-semibold">${escapeHtml(entry.target.label)}</h3>
                        <p class="font-mono text-xs opacity-60">${escapeHtml(entry.target.host)}:${entry.target.port}</p>
                    </div>
                    <div class="text-right">
                        <div class="font-mono text-sm">${fmtMs(latest?.latencyMs)}</div>
                        <div class="text-xs ${errorTone}">${escapeHtml(errorText)}</div>
                    </div>
                </div>
                <canvas id="${canvasId}" style="width:100%;height:110px;display:block"></canvas>
            </div>`;

        return { row, card };
    });

    const rows =
        rendered.length > 0
            ? rendered.map((r) => r.row).join('')
            : `<tr><td colspan="9" class="py-4 text-center opacity-50">No probe history loaded yet — click refresh.</td></tr>`;
    const cards = rendered.map((r) => r.card).join('');

    hostsCol.innerHTML = `
        <div class="mb-4 flex items-center justify-between gap-3">
            <div class="min-w-0 text-sm">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span class="badge badge-outline badge-sm font-mono">
                        Updated ${state.hostProbes.generatedAt ? formatLocalTime(Date.parse(state.hostProbes.generatedAt)) : '—'}
                    </span>
                    <h2 class="text-base font-bold">Host Connections</h2>
                    <span class="opacity-60">TCP probe history for configured platform hosts. Probe interval ${state.hostProbes.intervalMs != null ? `${Math.round(state.hostProbes.intervalMs / 1000)}s` : 'unknown'}.</span>
                </div>
            </div>
            <div class="flex shrink-0 items-center gap-3">
                <button
                    id="host-connections-refresh"
                    type="button"
                    class="btn btn-sm btn-ghost btn-square inline-flex items-center justify-center leading-none"
                    onclick="refreshHostConnectionsBtn()"
                    title="Refresh host connections">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" class="block h-4 w-4 shrink-0 fill-current" aria-hidden="true">
                        <path d="M10 3a7 7 0 0 1 6.56 4.57.75.75 0 1 1-1.4.53A5.5 5.5 0 1 0 14.5 13H12a.75.75 0 0 1 0-1.5h4.25A.75.75 0 0 1 17 12.25v4.25a.75.75 0 0 1-1.5 0v-1.77A7 7 0 1 1 10 3Z" />
                    </svg>
                </button>
            </div>
        </div>
        <div class="bg-base-300 mb-4 rounded-xl p-4 text-sm leading-6 opacity-85">
            Use this view to correlate output failures with basic reachability to the configured ingest hosts. A healthy line means the server could open a TCP connection to that host and port at that time; red markers mean the connect probe failed or timed out. This is useful for ruling in or out broad network-path problems from the server to YouTube, Facebook, or other destinations.
            <br /><br />
            Limitations: these probes do not perform a full RTMP or RTMPS publish handshake, and they do not prove the destination will accept or keep a live stream session open. A host can look healthy here while the platform still rejects, resets, or drops an actual publish connection.
        </div>
        <div class="mb-2 flex items-center justify-center gap-2 px-1">
            <button id="host-chart-back" class="btn btn-xs btn-ghost" ${atStart || maxOffset === 0 ? 'disabled' : ''}>&#8592; 10 min</button>
            ${rangeLabel}
            <button id="host-chart-fwd" class="btn btn-xs btn-ghost" ${atLive ? 'disabled' : ''}>10 min &#8594;</button>
        </div>
        <div class="overflow-x-auto">
            <table class="table table-sm">
                <thead>
                    <tr>
                        <th>Label</th>
                        <th>Host</th>
                        <th>Status</th>
                        <th>Latest</th>
                        <th>15min Higherst</th>
                        <th>Avg</th>
                        <th>6h Fail</th>
                        <th>Last Sample</th>
                        <th>Resolved IP</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="mt-6 grid grid-cols-1 gap-4">${cards}</div>`;

    for (const entry of targets) {
        const chartSamples = entry.history.filter(
            (sample) => sample.ts >= windowStart && sample.ts <= windowEnd,
        );
        drawProbeChart(
            `host-probe-chart-${entry.target.slot}`,
            chartSamples,
            windowStart,
            windowEnd,
            state.hostProbes.intervalMs ?? 5000,
        );
    }

    document.getElementById('host-chart-back')?.addEventListener('click', () => {
        state.hostChartOffsetMs = Math.min(
            state.hostChartOffsetMs + CHART_SCROLL_STEP_MS,
            maxOffset,
        );
        renderHostConnectionsOverview();
    });
    document.getElementById('host-chart-fwd')?.addEventListener('click', () => {
        state.hostChartOffsetMs = Math.max(0, state.hostChartOffsetMs - CHART_SCROLL_STEP_MS);
        renderHostConnectionsOverview();
    });
}
