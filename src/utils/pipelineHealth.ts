import {
    extractStreamResource,
    type SrsClient,
    type SrsStream,
    type SrsStreamVideo,
} from './srs.js';
import type { InputHealth, PipelineHealth } from '../services/health.js';
import type { InputProtocol } from '../services/inputState.js';
import type { LegObservation } from '../services/legTracker.js';
import type { ProbeStatus, KeyframeResult } from '../services/probeScheduler.js';
import type { SrtRelayStreamStatus } from '../services/srtRelay.js';
import type { Output } from '../types.js';
import type { SrtRecentStats } from './srtRecent.js';
import type { ProbeResult } from '../services/mediaProbe.js';

// One pipeline's input and relay blocks of the health snapshot, put together from what the
// poll read: which SRS stream and publisher it has, what the probes and the relay report,
// and whether SRS accepted the relay's stream. Pure, with the config, the clock and the
// trackers outside, so the rules here are tested with plain objects and the poll
// (services/health.ts) keeps the order of every call that has a side effect.

export interface SrsPublisherInfo {
    id: string;
    ip: string | null;
    type: string | null;
}

// The address the relay publishes to SRS from. Narrower on purpose than the check in
// api/srs.ts, which accepts all of 127.0.0.0/8: another local process must not look
// like the relay.
export function isLoopbackIp(ip: string | null | undefined): boolean {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function srsClientLooksLikeRelayPublisher(client: SrsClient | undefined): boolean {
    if (!client) return false;
    if (!isLoopbackIp(client.ip)) return false;
    return !client.type || client.type === 'srt-publish';
}

export function srsPublisherInfo(client: SrsClient | undefined): SrsPublisherInfo | null {
    if (!client) return null;
    return {
        id: client.id,
        ip: client.ip ?? null,
        type: client.type ?? null,
    };
}

function isLocalSrsHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host.startsWith('127.') ||
        host === '::ffff:7f00:1' ||
        host.startsWith('::ffff:127.')
    );
}

// The stream (`live/<key>`) an output destination publishes into on this server's own SRT
// port, or null when it points anywhere else.
export function localSrtTargetResource(url: string, srtPort: number): string | null {
    if (!url.startsWith('srt://')) return null;
    try {
        const parsed = new URL(url);
        const port = parsed.port ? Number(parsed.port) : 0;
        if (port !== srtPort) return null;
        if (!isLocalSrsHost(parsed.hostname)) return null;
    } catch {
        return null;
    }
    return extractStreamResource(url);
}

// Stream (`live/<key>`) → the pipelines whose running outputs publish into it over this
// server's SRT port. Built once per poll. `srtPort` is read only when a running SRT output
// exists, so a poll without one never touches the SRS config.
export function localSrtTargets(
    outputs: readonly Pick<Output, 'id' | 'pipelineId' | 'desiredState' | 'url'>[],
    isRunning: (outputId: string) => boolean,
    srtPort: () => number,
): Map<string, Set<number>> {
    const index = new Map<string, Set<number>>();
    let port: number | undefined;
    for (const output of outputs) {
        if (output.desiredState !== 'running') continue;
        if (!output.url.startsWith('srt://')) continue;
        if (!isRunning(output.id)) continue;
        port ??= srtPort();
        const resource = localSrtTargetResource(output.url, port);
        if (!resource) continue;
        const pipelineIds = index.get(resource);
        if (pipelineIds) pipelineIds.add(output.pipelineId);
        else index.set(resource, new Set([output.pipelineId]));
    }
    return index;
}

// Another pipeline's running output already publishes into this pipeline's stream key, so
// SRS cannot take the relay's stream for it.
export function hasLocalSrtConflict(
    index: ReadonlyMap<string, ReadonlySet<number>>,
    pipelineId: number,
    streamKey: string,
): boolean {
    for (const id of index.get(`live/${streamKey}`) ?? []) {
        if (id !== pipelineId) return true;
    }
    return false;
}

// Whether the pipeline's live stream arrived over SRT.
export function isSrtStream(live: boolean, stream: SrsStream | undefined): boolean {
    return live && !!stream?.tcUrl?.startsWith('srt://');
}

// The media the dashboard shows: what ffprobe read from the publisher when it has, else what
// SRS reports. `probed` is null until a probe succeeded.
export function displayedMedia(
    probe: ProbeStatus | null,
    stream: SrsStream | undefined,
): { probed: ProbeResult | null; video: SrsStreamVideo | null } {
    const probed = probe?.ok ? probe.result : null;
    return { probed, video: probed?.video ?? stream?.video ?? null };
}

// SRS has the relay's stream as the pipeline's input only when the stream arrived over SRT,
// its publisher looks like the relay (when the clients list is available to say) and no other
// pipeline's output publishes into the same key. The relay having a live input that SRS
// does not take is a publish conflict, a mistake that keeps the pipeline offline.
export function relayAdmission(params: {
    srtStream: boolean;
    clientsKnown: boolean;
    publisher: SrsClient | undefined;
    localSrtPublisherConflict: boolean;
    inputConnected: boolean;
    relayInputActive: boolean;
}): { acceptedBySrs: boolean; publishConflict: boolean } {
    const acceptedBySrs =
        params.srtStream &&
        (!params.clientsKnown || srsClientLooksLikeRelayPublisher(params.publisher)) &&
        !params.localSrtPublisherConflict;
    return {
        acceptedBySrs,
        publishConflict: params.inputConnected && params.relayInputActive && !acceptedBySrs,
    };
}

export interface PipelineReadings {
    // The live SRS stream of the pipeline's key: none while SRS is unreachable or nobody
    // publishes.
    stream: SrsStream | undefined;
    // The SRS client that publishes it.
    publisher: SrsClient | undefined;
    // False when SRS's clients list could not be read, so the publisher cannot be judged.
    clientsKnown: boolean;
    // What the input lifecycle shows (false while SRS is unreachable).
    live: boolean;
    connected: boolean;
    protocol: InputProtocol | null;
    uptimeMs: number | null;
    probe: {
        status: ProbeStatus | null;
        inFlightSince: number | null;
        keyframes: KeyframeResult | null;
    };
    relay: {
        status: SrtRelayStreamStatus;
        expectedLegs: number;
        legHealth: LegObservation['legHealth'];
        recent: SrtRecentStats;
    };
    // hasLocalSrtConflict for this pipeline.
    localSrtPublisherConflict: boolean;
}

export function buildPipelineHealth(r: PipelineReadings): {
    input: InputHealth;
    srtBonding: PipelineHealth['srtBonding'];
} {
    const { stream: s, publisher, connected, live, probe, relay } = r;
    const srtStream = isSrtStream(live, s);
    const { probed, video } = displayedMedia(probe.status, s);
    const { acceptedBySrs, publishConflict } = relayAdmission({
        srtStream,
        clientsKnown: r.clientsKnown,
        publisher,
        localSrtPublisherConflict: r.localSrtPublisherConflict,
        inputConnected: connected,
        relayInputActive: relay.status.inputActive,
    });

    const input: InputHealth = {
        connected,
        live,
        isSrt: srtStream || (connected && r.protocol === 'srt'),
        mediaOk: connected ? (probe.status ? probe.status.ok : null) : null,
        mediaProbeStartedAt: connected
            ? (probe.inFlightSince ?? probe.status?.startedAt ?? null)
            : null,
        mediaCheckedAt: connected ? (probe.status?.checkedAt ?? null) : null,
        mediaError: connected ? (probe.status?.error ?? null) : null,
        keyframes: connected ? probe.keyframes : null,
        recvBitrateKbps: s?.kbps?.recv_30s ?? null,
        sendBitrateKbps: s?.kbps?.send_30s ?? null,
        readers: s ? Math.max(0, (s.clients ?? 0) - 1) : 0,
        uptimeMs: live ? r.uptimeMs : null,
        publisherIp: connected ? (publisher?.ip ?? null) : null,
        publisherType: connected ? (publisher?.type ?? null) : null,
        video,
        audio: probed?.audio ?? s?.audio ?? null,
        audioTracks: probed?.audioTracks ?? [],
    };

    const raw = relay.status;
    const srtBonding: PipelineHealth['srtBonding'] = {
        ...raw,
        acceptedBySrs,
        publishConflict,
        srsPublisher: srsPublisherInfo(publisher),
        localSrtPublisherConflict: r.localSrtPublisherConflict,
        input: {
            ...raw.input,
            expectedLegs: relay.expectedLegs,
            recent: relay.recent.input,
            legs: raw.input.legs.map((leg) => {
                // Health is kept per `ip:port`, the recent counters per IP: a leg's port
                // changes when its sender reconnects, its counters should not restart.
                const status = relay.legHealth.get(`${leg.ip}:${leg.port}`);
                return {
                    ...leg,
                    health: status?.health ?? 'ok',
                    healthReason: status?.reason ?? null,
                    recent: relay.recent.legs.get(leg.ip) ?? null,
                };
            }),
        },
        output: { ...raw.output, recent: relay.recent.output },
    };

    return { input, srtBonding };
}
