import type {
    ConfigData,
    HealthData,
    InputHealth,
    PipelineView,
    OutputView,
    SrtBondingStatus,
} from '../types.js';
import { isRenditionUrl, renditionKey, sharedRecipeKey } from './renditions.js';

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
        expectedLegs: 0,
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

// Alerts about the input itself. They belong to the input's own status and Issues
// (so a plain RTMP input shows them too); every other pipeline alert is about the
// SRT relay link and is shown by the relay views.
export const INPUT_ALERT_CODES = new Set([
    'input-flapping',
    'input-low-framerate',
    'input-high-framerate',
]);

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
        const input: InputHealth = {
            ...(ph?.input ?? EMPTY_INPUT),
            alerts: (ph?.alerts ?? []).filter((a) => INPUT_ALERT_CODES.has(a.code)),
        };

        const pipelineOutputs = reconcileOrder(
            outputs.filter((o) => String(o.pipelineId) === String(p.id)),
            outsOrderByPipeline.get(String(p.id)),
            (o) => o.id,
        );
        const views: OutputView[] = pipelineOutputs.map((o) => {
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
                warningSinceMs: oh?.warningSinceMs ?? null,
                lastError: err?.message ?? null,
                hasErrorHistory,
                lastErrorAt: err?.ts ?? null,
                memoryUsageBytes: oh?.memoryUsageBytes ?? null,
                memoryLimitBytes: oh?.memoryLimitBytes ?? null,
                cpuPercent: oh?.cpuPercent ?? null,
                translationHealth: oh?.translation ?? null,
                renditionId: oh?.renditionId ?? null,
                ready: oh?.ready ?? null,
                readers: oh?.readers ?? null,
                dependents: [],
                sharedEncode: null,
            };
        });

        // Shared encodes are server-managed rows that sit next to the user's
        // outputs. They are kept out of `outs` so nothing counted or listed per
        // output (status dots, start/stop-all, copy/paste, layout order) sees them.
        const renditions = views.filter((o) => isRenditionUrl(o.url));
        const outs = views.filter((o) => !isRenditionUrl(o.url));
        const encodings = config.encodings ?? [];
        const renditionByKey = new Map(renditions.map((r) => [renditionKey(r), r]));
        for (const o of outs) {
            const key = sharedRecipeKey(o, encodings);
            const rendition = key ? renditionByKey.get(key) : undefined;
            if (!rendition) continue;
            // An output that started while it was alone with its recipe runs direct
            // until it next starts; it only reads the encode once health says so.
            if (o.status === 'running' && o.renditionId !== rendition.id) continue;
            o.sharedEncode = rendition;
            rendition.dependents.push({ id: o.id, name: o.name });
        }

        return {
            ...p,
            id: String(p.id),
            input,
            alerts: ph?.alerts ?? [],
            outs,
            renditions,
            srtBonding: ph?.srtBonding ?? EMPTY_BONDING,
        };
    });
}
