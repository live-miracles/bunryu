import type {
    PipelineView,
    ConfigData,
    HealthData,
    HostProbeOverview,
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
    hostProbes: Partial<HostProbeOverview>;
    streamKeys: StreamKey[];
    // Recent publish/play attempts SRS refused (from the on_publish/on_play hooks).
    rejectedPublishes: RejectedPublish[];
    rejectedOmitted: number;
    chartOffsetMs: number;
    hostChartOffsetMs: number;
    // Overview table filter: 'active' hides rows that are offline/stopped,
    // 'problems' hides rows that are neither warning nor error, so a failing
    // input/output is findable at a glance at the 50-input / 500-output scale.
    overviewFilter: OverviewFilter;
    // Overview search boxes (by name), one per table; per-browser and reset on reload.
    inputSearch: string;
    outputSearch: string;
    // Which pipeline groups are collapsed in the left-column list. Per-browser
    // only — intentionally not persisted server-side, so it resets on reload
    // and doesn't sync across viewers.
    collapsedGroupIds: Set<number>;
}

export const state: AppState = {
    config: {},
    health: {},
    pipelines: [],
    metrics: {},
    metricsHistory: [],
    hostProbes: {},
    streamKeys: [],
    rejectedPublishes: [],
    rejectedOmitted: 0,
    chartOffsetMs: 0,
    hostChartOffsetMs: 0,
    overviewFilter: 'all',
    inputSearch: '',
    outputSearch: '',
    collapsedGroupIds: new Set(),
};
