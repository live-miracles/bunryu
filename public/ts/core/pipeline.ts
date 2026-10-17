import type {
    ConfigData,
    HealthData,
    InputHealth,
    PipelineView,
    OutputView,
    SrtBondingStatus,
} from '../types.js';

const EMPTY_INPUT: InputHealth = {
    connected: false,
    live: false,
    isSrt: false,
    mediaOk: null,
    mediaProbeStartedAt: null,
    mediaCheckedAt: null,
    mediaError: null,
    recvBitrateKbps: null,
    sendBitrateKbps: null,
    readers: 0,
    uptimeMs: null,
    publisherIp: null,
    publisherType: null,
    video: null,
    audio: null,
    audioTracks: [],
};

const EMPTY_BONDING: SrtBondingStatus = {
    inputActive: false,
    outputConnected: false,
    acceptedBySrs: false,
    publishConflict: false,
    srsPublisher: null,
    localSrtPublisherConflict: false,
    retryFailures: 0,
    forwardedPackets: 0,
    forwardedBytes: 0,
    lastPacketAt: null,
    lastInputPacketAt: null,
    input: {
        bonded: true,
        peer: null,
        recvPacketsTotal: null,
        recvUniquePacketsTotal: 0,
        recvLossTotal: null,
        recvDropTotal: null,
        retransTotal: null,
        rttMs: null,
        latencyMs: null,
        bandwidthMbps: null,
        recvRateMbps: null,
        belatedTotal: null,
        belatedAvgMs: null,
        undecryptTotal: null,
        reorderDistance: null,
        rcvBufMs: null,
        legs: [],
    },
    output: {
        sentPacketsTotal: 0,
        sendLossTotal: 0,
        sendDropTotal: 0,
        retransTotal: 0,
        rttMs: null,
        latencyMs: null,
        bandwidthMbps: null,
        sendRateMbps: null,
        undecryptTotal: null,
        sndBufMs: null,
    },
    lastErrorAt: null,
    lastError: null,
};

// last_error is stored as "<ts_ms>\n<message>". Parse both parts.
function parseLastError(raw: string | null): { message: string; ts: number } | null {
    if (!raw) return null;
    const nl = raw.indexOf('\n');
    if (nl === -1) return { message: raw, ts: 0 };
    const ts = parseInt(raw.slice(0, nl), 10);
    return { message: raw.slice(nl + 1), ts: isNaN(ts) ? 0 : ts };
}

// Reorders `items` to match `orderIds` (drag-and-drop order, saved server-side
// as an opaque blob — the server never applies it itself). Ids in `orderIds`
// that no longer correspond to an item are ignored; items missing from
// `orderIds` (never dragged, or created after the order was last saved) keep
// their original relative order, appended after the explicitly ordered ones.
function reconcileOrder<T>(
    items: T[],
    orderIds: string[] | undefined,
    keyOf: (item: T) => string,
): T[] {
    if (!orderIds || orderIds.length === 0) return items;
    const byKey = new Map(items.map((item) => [keyOf(item), item]));
    const remaining = new Set(byKey.keys());
    const ordered: T[] = [];
    for (const id of orderIds) {
        if (!remaining.has(id)) continue;
        ordered.push(byKey.get(id)!);
        remaining.delete(id);
    }
    for (const item of items) {
        if (remaining.has(keyOf(item))) ordered.push(item);
    }
    return ordered;
}

export function parsePipelines(
    config: Partial<ConfigData>,
    health: Partial<HealthData>,
): PipelineView[] {
    const layoutOrder = config.layoutOrder ?? [];
    const outsOrderByPipeline = new Map(layoutOrder.map((e) => [String(e.id), e.outs]));
    const pipelines = reconcileOrder(
        config.pipelines ?? [],
        layoutOrder.map((e) => String(e.id)),
        (p) => String(p.id),
    );
    const outputs = config.outputs ?? [];
    const pipelinesHealth = health.pipelines ?? {};

    return pipelines.map((p) => {
        const ph = pipelinesHealth[String(p.id)];
        const input: InputHealth = ph?.input ?? EMPTY_INPUT;

        const pipelineOutputs = reconcileOrder(
            outputs.filter((o) => String(o.pipelineId) === String(p.id)),
            outsOrderByPipeline.get(String(p.id)),
            (o) => o.id,
        );
        const outs: OutputView[] = pipelineOutputs.map((o) => {
            const oh = ph?.outputs?.[o.id];
            // Health carries the live lastError (polled every 5s); fall back to
            // config's value only on initial load before the first health response.
            const rawError = oh !== undefined ? oh.lastError : (o.lastError ?? null);
            const err = parseLastError(rawError);
            const hasErrorHistory = oh?.hasErrorHistory ?? o.hasErrorHistory ?? rawError !== null;
            return {
                ...o,
                status: oh?.status ?? 'stopped',
                pid: oh?.pid ?? null,
                bitrateKbps: oh?.bitrateKbps ?? null,
                startedAtMs: oh?.startedAtMs ?? null,
                failures: oh?.failures ?? 0,
                warningReason: oh?.warningReason ?? null,
                lastError: err?.message ?? null,
                hasErrorHistory,
                lastErrorAt: err?.ts ?? null,
                memoryUsageBytes: oh?.memoryUsageBytes ?? null,
                memoryLimitBytes: oh?.memoryLimitBytes ?? null,
                cpuPercent: oh?.cpuPercent ?? null,
                translationHealth: oh?.translation ?? null,
            };
        });

        return {
            ...p,
            id: String(p.id),
            input,
            alerts: ph?.alerts ?? [],
            outs,
            srtBonding: ph?.srtBonding ?? EMPTY_BONDING,
        };
    });
}
