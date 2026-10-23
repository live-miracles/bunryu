import { readRelayConfig } from '../utils/relayConfig.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';

const SRT_RELAY_POLL_MS = 5000;
const SRT_RELAY_FETCH_TIMEOUT_MS = 2000;

export interface SrtRelayStats {
    status: 'running' | 'stopping' | 'stopped' | 'failed';
    pid: number | null;
    startedAtMs: number | null;
    lastError: string | null;
    port: number;
}

export type SrtRelayLegState = 'pending' | 'idle' | 'running' | 'unknown';

export interface SrtRelayLegStatus {
    ip: string;
    port: number;
    state: SrtRelayLegState;
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

export interface SrtRelayInputStatus {
    // False for an ordinary single-link SRT caller. Such an input has no legs in
    // the relay's own status; parseStreamStatus presents it as one link (see
    // plainInputLink) so everything downstream can treat both kinds alike.
    bonded: boolean;
    // The encoder's address for a plain input; null for a bonded group, whose
    // legs[] carry the addresses.
    peer: { ip: string; port: number } | null;
    recvPacketsTotal: number | null;
    recvUniquePacketsTotal: number;
    // Bonded group sockets do not expose deduplicated loss or receive-
    // retransmission counters. Those values are available per leg instead.
    recvLossTotal: number | null;
    recvDropTotal: number | null;
    retransTotal: number | null;
    rttMs: number | null;
    // Negotiated SRT buffering latency. For a bonded group this is derived as
    // the max latencyMs across legs (see SrtRelayLegStatus) since the group
    // socket's own srt_bstats never fills this in.
    latencyMs: number | null;
    // bandwidthMbps..rcvBufMs are only populated for a non-bonded input; a
    // real bonded group leaves these null (check legs[] instead).
    bandwidthMbps: number | null;
    recvRateMbps: number | null;
    belatedTotal: number | null;
    belatedAvgMs: number | null;
    undecryptTotal: number | null;
    reorderDistance: number | null;
    rcvBufMs: number | null;
    legs: SrtRelayLegStatus[];
}

export interface SrtRelayOutputStatus {
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

export interface SrtRelayStreamStatus {
    inputActive: boolean;
    outputConnected: boolean;
    retryFailures: number;
    forwardedPackets: number;
    forwardedBytes: number;
    lastPacketAt: number | null;
    lastInputPacketAt: number | null;
    input: SrtRelayInputStatus;
    output: SrtRelayOutputStatus;
    lastErrorAt: number | null;
    lastError: string | null;
}

export interface SrtRelayService {
    getStats(): SrtRelayStats;
    getStreamStatus(streamId: string): SrtRelayStreamStatus;
    start(): void;
    shutdown(): void;
}

interface RelayStatusResponseLeg {
    ip?: string;
    port?: number;
    state?: string;
    rttMs?: number | null;
    latencyMs?: number | null;
    recvPacketsTotal?: number | null;
    recvUniquePacketsTotal?: number | null;
    recvLossTotal?: number | null;
    recvDropTotal?: number | null;
    retransTotal?: number | null;
    bandwidthMbps?: number | null;
    recvRateMbps?: number | null;
    belatedTotal?: number | null;
    belatedAvgMs?: number | null;
    undecryptTotal?: number | null;
    reorderDistance?: number | null;
    rcvBufMs?: number | null;
}

interface RelayStatusResponseInput {
    bonded?: boolean;
    peer?: { ip?: unknown; port?: unknown } | null;
    recvPacketsTotal?: number | null;
    recvUniquePacketsTotal?: number;
    recvLossTotal?: number | null;
    recvDropTotal?: number | null;
    retransTotal?: number | null;
    rttMs?: number | null;
    latencyMs?: number | null;
    bandwidthMbps?: number | null;
    recvRateMbps?: number | null;
    belatedTotal?: number | null;
    belatedAvgMs?: number | null;
    undecryptTotal?: number | null;
    reorderDistance?: number | null;
    rcvBufMs?: number | null;
    legs?: RelayStatusResponseLeg[];
}

interface RelayStatusResponseOutput {
    sentPacketsTotal?: number;
    sendLossTotal?: number;
    sendDropTotal?: number;
    retransTotal?: number;
    rttMs?: number | null;
    latencyMs?: number | null;
    bandwidthMbps?: number | null;
    sendRateMbps?: number | null;
    undecryptTotal?: number | null;
    sndBufMs?: number | null;
}

interface RelayStatusResponse {
    pid?: number;
    startedAtMs?: number;
    updatedAtMs?: number;
    lastError?: string | null;
    activeStreamIds?: string[];
    streamStates?: Array<{
        streamId?: string;
        inputActive?: boolean;
        outputConnected?: boolean;
        retryFailures?: number;
        forwardedPackets?: number;
        forwardedBytes?: number;
        lastPacketAt?: number;
        lastInputPacketAt?: number;
        input?: RelayStatusResponseInput;
        output?: RelayStatusResponseOutput;
        lastErrorAt?: number;
        lastError?: string | null;
    }>;
}

const VALID_LEG_STATES: readonly SrtRelayLegState[] = ['pending', 'idle', 'running'];
const MAX_REASONABLE_BELATED_AVG_MS = 1_000_000_000;

function numOrNull(v: unknown): number | null {
    return typeof v === 'number' ? v : null;
}

function belatedAvgOrNull(v: unknown): number | null {
    const value = numOrNull(v);
    return value !== null &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= MAX_REASONABLE_BELATED_AVG_MS
        ? value
        : null;
}

function parseLegState(state: string | undefined): SrtRelayLegState {
    return (VALID_LEG_STATES as readonly string[]).includes(state ?? '')
        ? (state as SrtRelayLegState)
        : 'unknown';
}

function parseLeg(leg: RelayStatusResponseLeg): SrtRelayLegStatus {
    return {
        ip: leg.ip ?? '',
        port: typeof leg.port === 'number' ? leg.port : 0,
        state: parseLegState(leg.state),
        rttMs: numOrNull(leg.rttMs),
        latencyMs: numOrNull(leg.latencyMs),
        recvPacketsTotal: numOrNull(leg.recvPacketsTotal),
        recvUniquePacketsTotal: numOrNull(leg.recvUniquePacketsTotal),
        recvLossTotal: numOrNull(leg.recvLossTotal),
        recvDropTotal: numOrNull(leg.recvDropTotal),
        retransTotal: numOrNull(leg.retransTotal),
        bandwidthMbps: numOrNull(leg.bandwidthMbps),
        recvRateMbps: numOrNull(leg.recvRateMbps),
        belatedTotal: numOrNull(leg.belatedTotal),
        belatedAvgMs: belatedAvgOrNull(leg.belatedAvgMs),
        undecryptTotal: numOrNull(leg.undecryptTotal),
        reorderDistance: numOrNull(leg.reorderDistance),
        rcvBufMs: numOrNull(leg.rcvBufMs),
    };
}

function extractStreamResource(streamId: string): string | null {
    const match = /(?:^|[?,&#]|::|,)r=([^,&#]+)/.exec(streamId);
    if (!match?.[1]) return null;
    return match[1].replace(/^\/+/, '');
}

const EMPTY_INPUT_STATUS: SrtRelayInputStatus = {
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
};

const EMPTY_OUTPUT_STATUS: SrtRelayOutputStatus = {
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
};

const EMPTY_STREAM_STATUS: SrtRelayStreamStatus = {
    inputActive: false,
    outputConnected: false,
    retryFailures: 0,
    forwardedPackets: 0,
    forwardedBytes: 0,
    lastPacketAt: null,
    lastInputPacketAt: null,
    input: EMPTY_INPUT_STATUS,
    output: EMPTY_OUTPUT_STATUS,
    lastErrorAt: null,
    lastError: null,
};

function parsePeer(peer: RelayStatusResponseInput['peer']): SrtRelayInputStatus['peer'] {
    if (!peer || typeof peer.ip !== 'string' || typeof peer.port !== 'number') return null;
    return { ip: peer.ip, port: peer.port };
}

function parseInputStatus(input: RelayStatusResponseInput | undefined): SrtRelayInputStatus {
    if (!input) return { ...EMPTY_INPUT_STATUS };
    return {
        bonded: input.bonded !== false,
        peer: input.bonded === false ? parsePeer(input.peer) : null,
        recvPacketsTotal: numOrNull(input.recvPacketsTotal),
        recvUniquePacketsTotal:
            typeof input.recvUniquePacketsTotal === 'number' ? input.recvUniquePacketsTotal : 0,
        recvLossTotal: numOrNull(input.recvLossTotal),
        recvDropTotal: numOrNull(input.recvDropTotal),
        retransTotal: numOrNull(input.retransTotal),
        rttMs: numOrNull(input.rttMs),
        latencyMs: numOrNull(input.latencyMs),
        bandwidthMbps: numOrNull(input.bandwidthMbps),
        recvRateMbps: numOrNull(input.recvRateMbps),
        belatedTotal: numOrNull(input.belatedTotal),
        belatedAvgMs: belatedAvgOrNull(input.belatedAvgMs),
        undecryptTotal: numOrNull(input.undecryptTotal),
        reorderDistance: numOrNull(input.reorderDistance),
        rcvBufMs: numOrNull(input.rcvBufMs),
        legs: Array.isArray(input.legs) ? input.legs.map(parseLeg) : [],
    };
}

function parseOutputStatus(output: RelayStatusResponseOutput | undefined): SrtRelayOutputStatus {
    if (!output) return { ...EMPTY_OUTPUT_STATUS };
    return {
        sentPacketsTotal: typeof output.sentPacketsTotal === 'number' ? output.sentPacketsTotal : 0,
        sendLossTotal: typeof output.sendLossTotal === 'number' ? output.sendLossTotal : 0,
        sendDropTotal: typeof output.sendDropTotal === 'number' ? output.sendDropTotal : 0,
        retransTotal: typeof output.retransTotal === 'number' ? output.retransTotal : 0,
        rttMs: numOrNull(output.rttMs),
        latencyMs: numOrNull(output.latencyMs),
        bandwidthMbps: numOrNull(output.bandwidthMbps),
        sendRateMbps: numOrNull(output.sendRateMbps),
        undecryptTotal: numOrNull(output.undecryptTotal),
        sndBufMs: numOrNull(output.sndBufMs),
    };
}

// A plain input has full aggregate statistics but no legs. Presenting it as a
// single running link gives the health poll, the history graphs, the downlink
// total and the dashboard tables one shape to handle for both kinds of input;
// `bonded` tells them which wording and redundancy rules apply.
function plainInputLink(input: SrtRelayInputStatus, peer: { ip: string; port: number }) {
    const link: SrtRelayLegStatus = {
        ip: peer.ip,
        port: peer.port,
        state: 'running',
        rttMs: input.rttMs,
        latencyMs: input.latencyMs,
        recvPacketsTotal: input.recvPacketsTotal,
        recvUniquePacketsTotal: input.recvUniquePacketsTotal,
        recvLossTotal: input.recvLossTotal,
        recvDropTotal: input.recvDropTotal,
        retransTotal: input.retransTotal,
        bandwidthMbps: input.bandwidthMbps,
        recvRateMbps: input.recvRateMbps,
        belatedTotal: input.belatedTotal,
        belatedAvgMs: input.belatedAvgMs,
        undecryptTotal: input.undecryptTotal,
        reorderDistance: input.reorderDistance,
        rcvBufMs: input.rcvBufMs,
    };
    return link;
}

function parseStreamStatus(
    s: NonNullable<RelayStatusResponse['streamStates']>[number],
): SrtRelayStreamStatus {
    const input = parseInputStatus(s.input);
    if (s.inputActive && !input.bonded && input.peer && input.legs.length === 0) {
        input.legs = [plainInputLink(input, input.peer)];
    }
    return {
        inputActive: !!s.inputActive,
        outputConnected: !!s.outputConnected,
        retryFailures: typeof s.retryFailures === 'number' ? s.retryFailures : 0,
        forwardedPackets: typeof s.forwardedPackets === 'number' ? s.forwardedPackets : 0,
        forwardedBytes: typeof s.forwardedBytes === 'number' ? s.forwardedBytes : 0,
        lastPacketAt: typeof s.lastPacketAt === 'number' ? s.lastPacketAt : null,
        lastInputPacketAt: typeof s.lastInputPacketAt === 'number' ? s.lastInputPacketAt : null,
        input,
        output: parseOutputStatus(s.output),
        lastErrorAt: typeof s.lastErrorAt === 'number' ? s.lastErrorAt : null,
        lastError: s.lastError ?? null,
    };
}

export function createSrtRelayService(diagnostics?: DiagnosticsLogger): SrtRelayService {
    let stats: SrtRelayStats = {
        status: 'stopped',
        pid: null,
        startedAtMs: null,
        lastError: null,
        port: readRelayConfig().input_port,
    };
    let streamStates = new Map<string, SrtRelayStreamStatus>();
    let pollTimer: NodeJS.Timeout | null = null;
    let everReachedRelay = false;
    let refreshInFlight: Promise<void> | null = null;
    let previousStatus: SrtRelayStats['status'] = stats.status;
    const previousStreamStates = new Map<string, SrtRelayStreamStatus>();

    async function refresh(): Promise<void> {
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = (async () => {
            try {
                const relayConfig = readRelayConfig();
                const statusUrl = `http://127.0.0.1:${relayConfig.status_port}/status`;
                const res = await fetch(statusUrl, {
                    signal: AbortSignal.timeout(SRT_RELAY_FETCH_TIMEOUT_MS),
                    headers: { Connection: 'close' },
                });
                if (!res.ok) throw new Error(`Relay status HTTP ${res.status}`);
                const data = (await res.json()) as RelayStatusResponse;
                const pid = typeof data.pid === 'number' ? data.pid : null;
                const startedAtMs = typeof data.startedAtMs === 'number' ? data.startedAtMs : null;
                streamStates = new Map(
                    (data.streamStates ?? [])
                        .filter(
                            (s): s is typeof s & { streamId: string } =>
                                typeof s.streamId === 'string' && s.streamId.length > 0,
                        )
                        .map((s) => [s.streamId, parseStreamStatus(s)]),
                );
                everReachedRelay = true;
                stats = {
                    status: 'running',
                    pid,
                    startedAtMs,
                    lastError: data.lastError ?? null,
                    port: relayConfig.input_port,
                };
                if (previousStatus !== stats.status) {
                    diagnostics?.event('relay-transition', {
                        from: previousStatus,
                        to: stats.status,
                        pid,
                        error: stats.lastError,
                    });
                    previousStatus = stats.status;
                }
                for (const [streamId, next] of streamStates) {
                    const previous = previousStreamStates.get(streamId);
                    if (!previous) {
                        diagnostics?.event('relay-input-transition', {
                            streamId,
                            inputActive: next.inputActive,
                            outputConnected: next.outputConnected,
                        });
                        continue;
                    }
                    if (
                        previous.inputActive !== next.inputActive ||
                        previous.outputConnected !== next.outputConnected
                    ) {
                        diagnostics?.event('relay-input-transition', {
                            streamId,
                            fromInputActive: previous.inputActive,
                            toInputActive: next.inputActive,
                            fromOutputConnected: previous.outputConnected,
                            toOutputConnected: next.outputConnected,
                            retryFailures: next.retryFailures,
                            error: next.lastError,
                        });
                    }
                }
                previousStreamStates.clear();
                for (const [streamId, value] of streamStates)
                    previousStreamStates.set(streamId, value);
            } catch (err) {
                const relayConfig = readRelayConfig();
                streamStates = new Map();
                stats = {
                    status: everReachedRelay ? 'failed' : 'stopped',
                    pid: null,
                    startedAtMs: null,
                    lastError: err instanceof Error ? err.message : String(err),
                    port: relayConfig.input_port,
                };
                if (previousStatus !== stats.status) {
                    diagnostics?.event('relay-transition', {
                        from: previousStatus,
                        to: stats.status,
                        error: stats.lastError,
                    });
                    previousStatus = stats.status;
                }
            } finally {
                refreshInFlight = null;
            }
        })();
        return refreshInFlight;
    }

    function start(): void {
        void refresh();
        pollTimer = setInterval(() => void refresh(), SRT_RELAY_POLL_MS);
        pollTimer.unref?.();
    }

    function getStreamStatus(streamId: string): SrtRelayStreamStatus {
        const exact = streamStates.get(streamId);
        if (exact) return exact;

        const wantedResource = extractStreamResource(streamId);
        if (wantedResource) {
            for (const [rawStreamId, status] of streamStates) {
                if (extractStreamResource(rawStreamId) === wantedResource) return status;
            }
        }

        return { ...EMPTY_STREAM_STATUS };
    }

    return {
        getStats(): SrtRelayStats {
            return stats;
        },

        getStreamStatus(streamId: string): SrtRelayStreamStatus {
            return getStreamStatus(streamId);
        },

        start,

        shutdown(): void {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
            stats = {
                status: 'stopping',
                pid: stats.pid,
                startedAtMs: stats.startedAtMs,
                lastError: stats.lastError,
                port: stats.port,
            };
        },
    };
}
