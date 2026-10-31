import {
    getConfig,
    getHealth,
    getRejectedPublishes,
    getSystemMetrics,
    getMetricsHistory,
    isServerUnreachable,
} from '../core/api.js';
import { mergeMetricSamples } from '../core/metrics-history.js';
import { parsePipelines } from '../core/pipeline.js';
import { state } from '../core/state.js';
import { renderPipelines, renderMetrics } from './render.js';
import { getUrlParam } from '../core/utils.js';
import { noteDashboardSnapshot } from './sound-alerts.js';

let refreshLoop: Promise<void> | null = null;
let refreshQueued = false;

// A call made while a refresh is running queues one more pass and resolves when that
// pass has rendered, so awaiting it after a change never returns on a fetch that
// started before the change.
export function refreshDashboard(): Promise<void> {
    if (refreshLoop) {
        refreshQueued = true;
        return refreshLoop;
    }
    refreshLoop = (async () => {
        do {
            refreshQueued = false;
            await fetchAndRender();
        } while (refreshQueued);
    })().finally(() => {
        refreshLoop = null;
    });
    return refreshLoop;
}

let configStale = true;

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
    await refreshDashboard();
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
    const showSrtPassphraseBanner = !isServerUnreachable() && !!state.config.srtPassphrasePending;
    const srtPassphraseBanner = document.getElementById('srt-passphrase-banner');
    srtPassphraseBanner?.classList.toggle('hidden', !showSrtPassphraseBanner);
    srtPassphraseBanner?.classList.toggle('flex', showSrtPassphraseBanner);
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
    if (historyResult) {
        state.metricsHistory = mergeMetricSamples(state.metricsHistory, historyResult);
    }
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
        hostAlerts: state.health.hostAlerts ?? [],
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
