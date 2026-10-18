export interface StreamKey {
    id: number;
    slot: number;
    key: string;
}

export interface Pipeline {
    id: string;
    name: string;
    streamKey: string;
    streamKeyId: number;
    groupId: number | null;
    rtmpPublishUrl: string;
    srtPublishUrl: string;
    rtmpPublishUrlLocal: string;
    srtPublishUrlLocal: string;
}

// A collapsible section pipelines can be assigned to (see the pipeline edit
// form). Ordered by `position`; managed as a whole in Settings — see
// registerSettingsApi's normalizePipelineGroups for the write-side contract.
export interface PipelineGroup {
    id: number;
    name: string;
    position: number;
}

export interface HostProbeTarget {
    slot: number;
    label: string;
    host: string;
    port: number;
}

export interface HostProbeSample {
    ts: number;
    ok: boolean;
    latencyMs: number | null;
    error: string | null;
    resolvedAddress: string | null;
}

export interface HostProbeOverviewTarget {
    target: HostProbeTarget;
    latestSample: HostProbeSample | null;
    historySampleCount: number;
    historyFailureCount: number;
    averageLatencyMs: number | null;
    history: HostProbeSample[];
}

export interface HostProbeOverview {
    generatedAt: string;
    intervalMs: number;
    targets: HostProbeOverviewTarget[];
}

export interface Output {
    id: string;
    pipelineId: string;
    seq: number;
    name: string;
    desiredState: 'running' | 'stopped';
    videoEncoding: string;
    url: string;
    audioEncoding: string;
    translation: {
        translatorStreamKey: string;
        sourceTrackIndex: number;
        translatorTrackIndex: number;
        translationDelayMs: number;
        voiceThresholdDb: number;
        duckVolumeDb: number;
        duckDurationMs: number;
        restoreSilenceMs: number;
        restoreVolumeDb: number;
        restoreDurationMs: number;
    } | null;
    lastError: string | null;
    hasErrorHistory: boolean;
}

// Custom pipeline/output display order, verbatim from the server — see
// registerSettingsApi's normalizeLayoutOrder for the write-side contract.
// The backend never reorders anything itself; parsePipelines() reconciles
// this against the actual pipeline/output lists to produce display order.
export interface LayoutOrderEntry {
    id: number;
    outs: string[];
}

export interface OutputPayload {
    name: string;
    videoEncoding: string;
    url: string;
    audioEncoding: string;
    translation?: {
        translatorStreamKey: string;
        sourceTrackIndex?: number;
        translatorTrackIndex?: number;
        translationDelayMs?: number;
        voiceThresholdDb?: number;
        duckVolumeDb?: number;
        duckDurationMs?: number;
        restoreSilenceMs?: number;
        restoreVolumeDb?: number;
        restoreDurationMs?: number;
    } | null;
}

export interface VideoInfo {
    codec: string;
    profile: string;
    level: string;
    width: number;
    height: number;
    fps?: number | null;
    fieldOrder?: string | null;
}

export interface AudioInfo {
    codec: string;
    sample_rate: number;
    channel: number;
    profile: string;
}

export interface AudioTrackInfo {
    index: number;
    codec: string;
    sampleRate: number;
    channels: number;
    profile: string;
    language: string | null;
    title: string | null;
    pid: number | null;
}

export interface TranslationOutputHealth {
    mode: 'source-only' | 'translated';
    duckState: 'resting' | 'ducked';
    sourceVolumePercent: number;
    lastTranslatorMeterDb: number | null;
}

export interface OutputStatus {
    status: 'running' | 'stopped' | 'failed';
    pid: number | null;
    bitrateKbps: number | null;
    startedAtMs: number | null;
    failures: number;
    warningReason: string | null;
    lastError: string | null;
    hasErrorHistory: boolean;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
    cpuPercent: number | null;
    // Only non-null for audioEncoding === 'translation' outputs.
    translation: TranslationOutputHealth | null;
    // Shared encodes (renditions): 'rendition' for the server-managed row, the
    // rendition a running shared output pulls, and (renditions only) whether it is
    // writing data and how many outputs are reading it.
    role?: 'rendition' | 'output';
    renditionId?: string | null;
    ready?: boolean | null;
    readers?: number | null;
}

export interface SrtRelayStatus {
    status: 'running' | 'stopping' | 'stopped' | 'failed';
    pid: number | null;
    startedAtMs: number | null;
    lastError: string | null;
    port: number;
}

export type SrtBondingLegState = 'pending' | 'idle' | 'running' | 'broken' | 'unknown';

export interface SrtBondingLeg {
    ip: string;
    port: number;
    state: SrtBondingLegState;
    rttMs: number | null;
    latencyMs: number | null;
    recvPacketsTotal: number | null;
    recvUniquePacketsTotal: number | null;
    recvLossTotal: number | null;
    recvDropTotal: number | null;
    retransTotal: number | null;
    bandwidthMbps: number | null;
    recvRateMbps: number | null;
    belatedTotal: number | null;
    belatedAvgMs: number | null;
    undecryptTotal: number | null;
    reorderDistance: number | null;
    rcvBufMs: number | null;
    health?: 'ok' | 'warn' | 'error';
    healthReason?: string | null;
}

export interface SrtBondingInputStatus {
    // False for a plain single-link SRT input. Its encoder address is `peer`, and
    // it is also presented as the one entry of `legs`; a bonded group has no
    // `peer` and carries the addresses in `legs`.
    bonded: boolean;
    peer: { ip: string; port: number } | null;
    recvPacketsTotal: number | null;
    recvUniquePacketsTotal: number;
    recvLossTotal: number | null;
    recvDropTotal: number | null;
    retransTotal: number | null;
    rttMs: number | null;
    latencyMs: number | null;
    bandwidthMbps: number | null;
    recvRateMbps: number | null;
    belatedTotal: number | null;
    belatedAvgMs: number | null;
    undecryptTotal: number | null;
    reorderDistance: number | null;
    rcvBufMs: number | null;
    legs: SrtBondingLeg[];
}

export interface SrtBondingOutputStatus {
    sentPacketsTotal: number;
    sendLossTotal: number;
    sendDropTotal: number;
    retransTotal: number;
    rttMs: number | null;
    latencyMs: number | null;
    bandwidthMbps: number | null;
    sendRateMbps: number | null;
    undecryptTotal: number | null;
    sndBufMs: number | null;
}

export interface SrtBondingStatus {
    inputActive: boolean;
    outputConnected: boolean;
    acceptedBySrs: boolean;
    publishConflict: boolean;
    srsPublisher: {
        id: string;
        ip: string | null;
        type: string | null;
    } | null;
    localSrtPublisherConflict: boolean;
    retryFailures: number;
    forwardedPackets: number;
    forwardedBytes: number;
    lastPacketAt: number | null;
    lastInputPacketAt: number | null;
    input: SrtBondingInputStatus;
    output: SrtBondingOutputStatus;
    lastErrorAt: number | null;
    lastError: string | null;
}

export interface SrsLogEvent {
    ts: number;
    source: 'srs' | 'relay';
    type: 'up' | 'down';
    message: string;
}

export interface ServerLogTail {
    lines: string[];
    source: 'journal' | 'none';
}

export interface SrsLogsData {
    events: SrsLogEvent[];
    srs: ServerLogTail;
    dashboard: ServerLogTail;
    relay: ServerLogTail;
}

export interface PipelineLog {
    id: number;
    pipelineId: number;
    ts: number;
    event: string;
    message: string;
}

export type OutputErrorKind = 'crash' | 'stopped' | 'warning';

export interface OutputErrorRecord {
    ts: number;
    message: string;
    kind: OutputErrorKind;
}

export interface InputHealth {
    connected: boolean;
    live: boolean;
    isSrt: boolean;
    mediaOk: boolean | null;
    mediaProbeStartedAt: number | null;
    mediaCheckedAt: number | null;
    mediaError: string | null;
    recvBitrateKbps: number | null;
    sendBitrateKbps: number | null;
    readers: number;
    uptimeMs: number | null;
    publisherIp: string | null;
    publisherType: string | null;
    video: VideoInfo | null;
    audio: AudioInfo | null;
    audioTracks: AudioTrackInfo[];
}

export interface PipelineHealth {
    input: InputHealth;
    outputs: Record<string, OutputStatus>;
    alerts: PipelineAlert[];
    srtBonding: SrtBondingStatus;
}

export interface PipelineAlert {
    severity: 'warning' | 'error';
    code: string;
    message: string;
    sinceMs: number;
}

export interface LegHistorySample {
    ts: number;
    state: string;
    health: 'ok' | 'warn' | 'error';
    recvRateMbps: number | null;
    rttMs: number | null;
    latencyMs: number | null;
    lossPct: number | null;
    dropPct: number | null;
    retransmissionPct: number | null;
    belated: number | null;
    receivedPackets?: number | null;
    lossPackets?: number | null;
    dropPackets?: number | null;
    lossTotal?: number | null;
    dropTotal?: number | null;
    retransmittedPackets?: number | null;
}

export interface LegHistorySeries {
    ip: string;
    port: number;
    samples: LegHistorySample[];
}

export interface LegHistoryData {
    pipelineId: number;
    from: number;
    to: number;
    oldestTs: number | null;
    intervalMs: number;
    legs: LegHistorySeries[];
}

export interface HealthData {
    generatedAt: string;
    srsReachable: boolean;
    srtRelay: SrtRelayStatus;
    configRev: number;
    pipelines: Record<string, PipelineHealth>;
}

export interface RejectedPublish {
    label: string;
    kind: 'publish' | 'play';
    reason: 'assigned' | 'unassigned' | 'unknown' | 'unrecognized';
    protocol: 'rtmp' | 'srt';
    ip: string | null;
    attempts: number;
    lastAttemptAgoMs: number;
    streams: number;
    streamsCapped: boolean;
}

export interface RejectedPublishesData {
    rejected: RejectedPublish[];
    // Entries beyond the API's row cap that are not included.
    omitted: number;
}

export interface ConfigData {
    configRev: number;
    pipelines: Pipeline[];
    outputs: Output[];
    hostProbeTargets: HostProbeTarget[];
    groups: PipelineGroup[];
    encodings: string[];
    streamKeys: StreamKey[];
    serverName: string;
    srtPassphrase: string | null;
    publicHost: string;
    layoutOrder: LayoutOrderEntry[];
}

export interface ProcUsage {
    cpuPercent: number | null;
    ramBytes: number | null;
}

export interface SystemMetrics {
    cpu: { cores: number; percent: number };
    ram: { usedBytes: number; totalBytes: number };
    disk: { totalBytes: number; usedBytes: number } | null;
    net: { rxBytesPerSec: number; txBytesPerSec: number };
    uptimeSeconds?: number;
    node: ProcUsage;
    srs: ProcUsage;
    relay: ProcUsage;
}

export interface MetricSample {
    ts: number;
    cpu: number;
    ramUsed: number;
    ramTotal: number;
    rxBps: number;
    txBps: number;
}

export interface PipelineView {
    id: string;
    name: string;
    streamKey: string;
    streamKeyId: number;
    groupId: number | null;
    srtBonding: SrtBondingStatus;
    rtmpPublishUrl: string;
    srtPublishUrl: string;
    input: InputHealth & { live: boolean };
    alerts: PipelineAlert[];
    // Your outputs. Shared-encode rows are kept apart in `renditions` so every
    // count, status and list built from `outs` ignores them.
    outs: OutputView[];
    renditions: OutputView[];
}

export interface OutputView extends Output {
    status: 'running' | 'stopped' | 'failed';
    pid: number | null;
    bitrateKbps: number | null;
    startedAtMs: number | null;
    failures: number;
    warningReason: string | null;
    lastError: string | null;
    hasErrorHistory: boolean;
    lastErrorAt: number | null;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
    cpuPercent: number | null;
    // Named distinctly from the inherited `translation` config field (Output.translation).
    translationHealth: TranslationOutputHealth | null;
    // The shared encode this output is reading right now (health), else null.
    renditionId: string | null;
    // Renditions: whether the encode is writing data, and the outputs reading it.
    ready: boolean | null;
    readers: number | null;
    dependents: { id: string; name: string }[];
    // Your outputs: the shared encode (rendition row) this one pulls, if any.
    sharedEncode: OutputView | null;
}
