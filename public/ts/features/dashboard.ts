import {
    getConfig,
    getHealth,
    getRejectedPublishes,
    getHostProbes,
    getSystemMetrics,
    getMetricsHistory,
    isServerUnreachable,
} from '../core/api.js';
import { parsePipelines } from '../core/pipeline.js';
import { state } from '../core/state.js';
import { renderPipelines, renderMetrics } from './render.js';
import { getUrlParam } from '../core/utils.js';
import { noteDashboardSnapshot } from './sound-alerts.js';

let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;

export function invalidateHostProbes(): void {
    state.hostProbes = {};
}

export async function refreshDashboard(): Promise<void> {
    if (refreshInFlight) {
        refreshQueued = true;
        return refreshInFlight;
    }

    do {
        refreshQueued = false;
        const lastPromise = fetchAndRender();
        refreshInFlight = lastPromise;
        try {
            await lastPromise;
        } finally {
            if (refreshInFlight === lastPromise) refreshInFlight = null;
        }
    } while (refreshQueued);
}

let configStale = true;

function mergeMetricsHistory(samples: import('../types.js').MetricSample[]): void {
    if (samples.length === 0) return;
    const byTimestamp = new Map(state.metricsHistory.map((sample) => [sample.ts, sample]));
    for (const sample of samples) byTimestamp.set(sample.ts, sample);
    state.metricsHistory = [...byTimestamp.values()].sort((a, b) => a.ts - b.ts);
}

// The configRev the currently loaded /api/config corresponds to. Each health poll
// carries the server's current rev; when it no longer matches what we loaded, the
// config was edited elsewhere (another dashboard client) and we surface a reload
// banner. null until the first config load.
let loadedConfigRev: number | null = null;

export function invalidateConfig(): void {
    configStale = true;
}

// The config was edited in another session (every health snapshot carries the
// server's current configRev). Refetch it automatically instead of asking the
// user to click a reload button: a config reload is just another GET + render,
// identical to any poll, and edit forms live in static modals so nothing is
// ripped out from under the operator. Without this, other clients showed stale
// Start/Stop state until someone noticed the banner.
function resyncConfigIfChanged(healthRev: number | undefined): void {
    // configRev is monotonic, so only a health rev ahead of what we loaded means
    // a newer config exists. Using `>` (not `!=`) avoids a spurious refetch from
    // a health snapshot that is momentarily staler than a just-reloaded config.
    const changed =
        loadedConfigRev !== null && healthRev !== undefined && healthRev > loadedConfigRev;
    if (!changed) return;
    invalidateConfig();
    // Queues a follow-up pass on the in-flight refresh; the refetched config
    // advances loadedConfigRev, so this converges instead of looping.
    void refreshDashboard();
}

export async function refreshAfterMutation(): Promise<void> {
    invalidateConfig();
    invalidateHostProbes();
    await refreshDashboard();
}

export async function refreshHostProbes(hours = 6): Promise<void> {
    const hostProbesResult = await getHostProbes(hours);
    if (hostProbesResult) {
        state.hostProbes = hostProbesResult;
    }
    renderPipelines();
}

async function fetchAndRender(): Promise<void> {
    const doConfig = configStale;
    configStale = false;

    const inOverview = !getUrlParam('p');
    const latestMetricTs = state.metricsHistory.at(-1)?.ts;
    const [configResult, healthResult, rejectedResult, metricsResult, historyResult] =
        await Promise.all([
            doConfig ? getConfig() : Promise.resolve(null),
            getHealth(),
            getRejectedPublishes(),
            getSystemMetrics(),
            inOverview ? getMetricsHistory(latestMetricTs) : Promise.resolve(null),
        ]);

    if (configResult) {
        state.config = configResult;
        loadedConfigRev = configResult.configRev ?? loadedConfigRev;
        if (configResult.streamKeys?.length) {
            state.streamKeys = configResult.streamKeys;
        }
        if (configResult.serverName) {
            const el = document.getElementById('server-name-display');
            if (el) el.textContent = configResult.serverName;
            document.title = configResult.serverName;
        }
    }
    if (healthResult) {
        state.health = healthResult;
        resyncConfigIfChanged(healthResult.configRev);
    }
    // Recompute even when health couldn't be fetched: if the server itself is
    // unreachable, the connection banner already covers it, so suppress the
    // SRS-down banner to avoid showing two alerts at once.
    const showSrsBanner = !isServerUnreachable() && !!state.health && !state.health.srsReachable;
    const srsBanner = document.getElementById('srs-banner');
    srsBanner?.classList.toggle('hidden', !showSrsBanner);
    srsBanner?.classList.toggle('flex', showSrsBanner);
    const showSrtRelayBanner =
        !isServerUnreachable() &&
        !!state.health.srtRelay &&
        state.health.srtRelay.status !== 'running';
    const srtRelayBanner = document.getElementById('srt-relay-banner');
    const srtRelayBannerText = document.getElementById('srt-relay-banner-text');
    srtRelayBanner?.classList.toggle('hidden', !showSrtRelayBanner);
    srtRelayBanner?.classList.toggle('flex', showSrtRelayBanner);
    if (srtRelayBannerText) {
        srtRelayBannerText.textContent =
            state.health.srtRelay?.lastError && state.health.srtRelay.status !== 'running'
                ? `SRT relay is not responding (${state.health.srtRelay.lastError}) — inputs on the bonded SRT port may be down; RTMP and direct SRT are unaffected`
                : 'SRT relay is not running — inputs on the bonded SRT port are down; RTMP and direct SRT are unaffected';
    }
    // The config says publicHost is empty (undefined until it has loaded).
    const showPublicHostBanner = !isServerUnreachable() && state.config.publicHost === '';
    const publicHostBanner = document.getElementById('public-host-banner');
    publicHostBanner?.classList.toggle('hidden', !showPublicHostBanner);
    publicHostBanner?.classList.toggle('flex', showPublicHostBanner);
    if (rejectedResult) {
        state.rejectedPublishes = rejectedResult.rejected;
        state.rejectedOmitted = rejectedResult.omitted;
    }
    if (metricsResult) state.metrics = metricsResult;
    if (historyResult) mergeMetricsHistory(historyResult);
    state.pipelines = parsePipelines(state.config, state.health);
    renderPipelines();
    renderMetrics();
    // Only once both config and health have loaded: a snapshot missing either
    // would set an empty baseline, and the next poll would beep for every
    // problem already on screen.
    if (!state.config.pipelines || !state.health.generatedAt) return;
    noteDashboardSnapshot({
        serverUnreachable: isServerUnreachable(),
        srsReachable: state.health.srsReachable,
        relayDown: !!state.health.srtRelay && state.health.srtRelay.status !== 'running',
        pipelines: state.pipelines,
    });
}

const POLL_MS = 5000;
const HIDDEN_POLL_MS = 30000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPolling(ms: number): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void refreshDashboard(), ms);
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        startPolling(HIDDEN_POLL_MS);
    } else {
        startPolling(POLL_MS);
        void refreshDashboard();
    }
});

void (async () => {
    await refreshDashboard();
    startPolling(document.hidden ? HIDDEN_POLL_MS : POLL_MS);
})();
