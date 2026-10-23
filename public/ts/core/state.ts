import type {
    PipelineView,
    ConfigData,
    HealthData,
    SystemMetrics,
    MetricSample,
    StreamKey,
    RejectedPublish,
} from '../types.js';

export type OverviewFilter = 'all' | 'active' | 'problems';

export interface AppState {
    config: Partial<ConfigData>;
    health: Partial<HealthData>;
    pipelines: PipelineView[];
    metrics: Partial<SystemMetrics>;
    metricsHistory: MetricSample[];
    streamKeys: StreamKey[];
    // Recent publish/play attempts SRS refused (from the on_publish/on_play hooks).
    rejectedPublishes: RejectedPublish[];
    rejectedOmitted: number;
    chartOffsetMs: number;
    // Overview table filter: 'active' hides rows that are offline/stopped,
    // 'problems' hides rows that are neither warning nor error, so a failing
    // input/output is findable at a glance at the 50-input / 500-output scale.
    overviewFilter: OverviewFilter;
    // Overview search boxes (by name), one per table; per-browser and reset on reload.
    inputSearch: string;
    outputSearch: string;
    // Which pipeline groups are collapsed in the left-column list. Per-browser
    // only (localStorage, see saveCollapsedGroups) — intentionally not stored
    // server-side, so it doesn't sync across viewers.
    collapsedGroupIds: Set<number>;
}

const COLLAPSED_GROUPS_KEY = 'bunryu.collapsedGroups';

// Group ids are never reused, so an id left behind by a deleted group is harmless.
function loadCollapsedGroups(): Set<number> {
    try {
        const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]');
        if (Array.isArray(saved)) return new Set(saved.filter(Number.isInteger));
    } catch {
        // Storage blocked or a corrupt value: start with every group expanded.
    }
    return new Set();
}

export function saveCollapsedGroups(): void {
    try {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...state.collapsedGroupIds]));
    } catch {
        // Storage blocked: the collapsed groups last until the page is reloaded.
    }
}

export const state: AppState = {
    config: {},
    health: {},
    pipelines: [],
    metrics: {},
    metricsHistory: [],
    streamKeys: [],
    rejectedPublishes: [],
    rejectedOmitted: 0,
    chartOffsetMs: 0,
    overviewFilter: 'all',
    inputSearch: '',
    outputSearch: '',
    collapsedGroupIds: loadCollapsedGroups(),
};

// "Now" on the server's clock: the health snapshot's own generatedAt rather than
// the browser's Date.now(). Comparing a server-issued timestamp against the
// client's wall clock makes staleness detection sensitive to client/server
// clock skew — a client clock running fast enough looks permanently "stalled"
// even when the relay is flowing normally.
export function healthNowMs(): number {
    const generatedAt = state.health.generatedAt;
    const parsed = generatedAt ? new Date(generatedAt).getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : Date.now();
}
