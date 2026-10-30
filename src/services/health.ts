import type { Express } from 'express';
import path from 'path';
import {
    fetchSrsClientsForHealth,
    fetchSrsStreams,
    extractStreamResource,
    type SrsStream,
    type SrsClient,
    type SrsStreamVideo,
    type SrsStreamAudio,
    type AudioTrackInfo,
} from '../utils/srs.js';
import { readAppConfig } from '../utils/appConfig.js';
import { readSrsConfigValues } from '../utils/srsConfig.js';
import { RENDITION_APP, isRenditionOutput } from '../utils/renditions.js';
import type { Db, Output } from '../types.js';
import type { OutputService } from './outputs.js';
import type { SrtRelayService, SrtRelayStats, SrtRelayStreamStatus } from './srtRelay.js';
import type { InputState } from './inputState.js';
import { createLoopFailureReporter, type DiagnosticsLogger } from '../utils/diagnostics.js';
import {
    readCpuPressure,
    readDiskUsage,
    readHostMemory,
    readUdpStats,
} from '../utils/procStats.js';
import { readRelayConfig } from '../utils/relayConfig.js';
import { createRelayErrorLog } from '../utils/relayErrorLog.js';
import { createSrtRecentTracker, type SrtRecent } from '../utils/srtRecent.js';
import {
    describePublisherSource,
    nextPublisherLog,
    type PublisherLogState,
} from '../utils/publisherLog.js';
import { isProbeUsable, type KeyframeStats } from './mediaProbe.js';
import { createProbeScheduler } from './probeScheduler.js';
import { createLegTracker } from './legTracker.js';
import { createInputLifecycle, type PollStaggers } from './inputLifecycle.js';
import { createPipelineMaps } from '../utils/pipelineMaps.js';
import { createHostMonitor, type HostAlertKind } from './hostMonitor.js';
import {
    srtIntervalAlerts,
    type PipelineAlert,
    type RelayInputSample,
} from '../utils/srtLinkAlerts.js';

export type { PipelineAlert };
export type { LegHistorySample, LegHistorySeries } from './legTracker.js';

export { isProbeUsable };

const POLL_INTERVAL_MS = 5000;
// An alert absent for this many polls in a row (~30 s) ends its episode, so a
// condition that flickers poll to poll is one episode, not dozens.
const ALERT_EPISODE_QUIET_POLLS = 6;
const MAX_SRS_EVENTS = 200;
const LEG_HISTORY_MAX_SAMPLES = (60 * 60 * 1000) / POLL_INTERVAL_MS;
const LEG_HISTORY_MAX_WINDOW_MS = 30 * 60 * 1000;
const LEG_HEALTH_WINDOW_MS = 60 * 1000;
const DIAGNOSTICS_SNAPSHOT_INTERVAL_MS = 60 * 1000;

export interface InputHealth {
    connected: boolean;
    live: boolean;
    isSrt: boolean;
    mediaOk: boolean | null;
    mediaProbeStartedAt: number | null;
    mediaCheckedAt: number | null;
    mediaError: string | null;
    // The keyframe check of the current publisher; null until it has run (or when it failed).
    keyframes: (KeyframeStats & { checkedAt: number }) | null;
    recvBitrateKbps: number | null;
    sendBitrateKbps: number | null;
    readers: number;
    uptimeMs: number | null;
    publisherIp: string | null;
    publisherType: string | null;
    video: SrsStreamVideo | null;
    audio: SrsStreamAudio | null;
    audioTracks: AudioTrackInfo[];
}

// Per-output entry in the health snapshot: live process stats (OutputStats from
// the output service) merged with the persisted lastError read from the DB.
// lastError is not part of the runtime stats — it's joined in here so the UI can
// show the last failure alongside live status.
interface OutputHealth {
    status: string;
    pid: number | null;
    bitrateKbps: number | null;
    startedAtMs: number | null;
    failures: number;
    nextRetryAtMs: number | null;
    warningReason: string | null;
    warningSinceMs: number | null;
    lastError: string | null;
    hasErrorHistory: boolean;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
    cpuPercent: number | null;
    speed: number | null;
    lastOutTimeUs: number | null;
    lastTotalSizeBytes: number | null;
    progressAgeMs: number | null;
    outputProgressAgeMs: number | null;
    // Shared encodes (renditions, see utils/renditions.ts): `role` tells a
    // rendition row from an ordinary output, `renditionId` is the rendition a
    // running shared output pulls, `ready` is set for renditions only, and
    // `readers` (renditions only, null otherwise) counts the outputs pulling it.
    role: 'rendition' | 'output';
    renditionId: string | null;
    ready: boolean | null;
    readers: number | null;
}

interface PipelineHealth {
    input: InputHealth;
    outputs: Record<string, OutputHealth>;
    alerts: PipelineAlert[];
    srtBonding: SrtRelayStreamStatus & {
        acceptedBySrs: boolean;
        publishConflict: boolean;
        srsPublisher: SrsPublisherInfo | null;
        localSrtPublisherConflict: boolean;
        input: {
            expectedLegs: number;
            recent: SrtRecent | null;
            legs: Array<{ recent: SrtRecent | null }>;
        };
        output: { recent: SrtRecent | null };
    };
}

export interface HealthSnapshot {
    generatedAt: string;
    srsReachable: boolean;
    srtRelay: SrtRelayStats;
    // Host resource alerts open right now (see the host alert trackers below). The
    // dashboard beeps when memory or disk joins the list.
    hostAlerts: HostAlertKind[];
    // Config revision at snapshot time. Clients compare this against the rev they
    // loaded /api/config at; a mismatch means the config was edited elsewhere and
    // the client should reload. Carried on the health snapshot so it reaches every
    // client on the regular 5s poll without an extra request.
    configRev: number;
    pipelines: Record<string, PipelineHealth>;
}

// One line of the dashboard's Server events table: a service becoming unreachable or
// a host resource alert starting ('problem'), and the matching recovery.
export interface SrsEvent {
    ts: number;
    source: 'srs' | 'relay' | 'host';
    type: 'problem' | 'recovered';
    message: string;
}

interface SrsPublisherInfo {
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

function srsPublisherInfo(client: SrsClient | undefined): SrsPublisherInfo | null {
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

export function localSrtOutputTargetsStream(url: string, streamKey: string): boolean {
    if (!url.startsWith('srt://')) return false;

    const srs = readSrsConfigValues();
    try {
        const parsed = new URL(url);
        const port = parsed.port ? Number(parsed.port) : 0;
        if (port !== srs.srtPort) return false;
        if (!isLocalSrsHost(parsed.hostname)) return false;
    } catch {
        return false;
    }

    return extractStreamResource(url) === `live/${streamKey}`;
}

export function hasBondedRelayPublishConflict(params: {
    inputConnected: boolean;
    relayInputActive: boolean;
    relayAcceptedBySrs: boolean;
}): boolean {
    return params.inputConnected && params.relayInputActive && !params.relayAcceptedBySrs;
}

// A bitrate for an alert message: Mb/s from 1000 kb/s up.
interface ProcessUsage {
    cpuPercent: number | null;
    ramBytes: number | null;
}

export type ProcessUsageSource = () => {
    node: ProcessUsage;
    srs: ProcessUsage;
    relay: ProcessUsage;
};

export function createHealthService(
    db: Db,
    outputService: OutputService,
    srtRelayService: SrtRelayService,
    inputState: InputState,
    diagnostics?: DiagnosticsLogger,
    getProcessUsage?: ProcessUsageSource,
) {
    let snapshot: HealthSnapshot = {
        generatedAt: new Date().toISOString(),
        srsReachable: false,
        srtRelay: srtRelayService.getStats(),
        hostAlerts: [],
        configRev: db.getConfigRev(),
        pipelines: {},
    };

    const srsEvents: SrsEvent[] = [];
    let prevSrsReachable: boolean | null = null;
    // Only 'failed' (was reachable, now isn't) is worth a "down" event — 'stopped'
    // also covers a relay that has simply never been started (no bonding pipeline
    // configured), which would otherwise fire a spurious down event on every boot.
    let prevRelayFailed = false;
    let lastDiagnosticsSnapshotAt = 0;
    let lastRcvbufErrors: number | null = null;

    function pushSrsEvent(
        source: SrsEvent['source'],
        type: SrsEvent['type'],
        message: string,
    ): void {
        srsEvents.push({ ts: Date.now(), source, type, message });
        if (srsEvents.length > MAX_SRS_EVENTS) srsEvents.shift();
    }

    // State kept per pipeline between polls that the input lifecycle does not own.
    const pipelineMaps = createPipelineMaps();
    // Open alert episodes by `${pipelineId}:${code}`. Alerts are rebuilt every
    // poll; these turn them into one started and one ended diagnostics event.
    const alertEpisodes = new Map<
        string,
        {
            pipelineId: number;
            code: string;
            startedAtMs: number;
            lastSeenMs: number;
            activePolls: number;
            absentPolls: number;
            lastMessage: string;
        }
    >();

    function endAlertEpisode(key: string, reason: string): void {
        const episode = alertEpisodes.get(key);
        if (!episode) return;
        alertEpisodes.delete(key);
        diagnostics?.event('pipeline-alert-ended', {
            pipelineId: episode.pipelineId,
            code: episode.code,
            durationMs: episode.lastSeenMs - episode.startedAtMs,
            activePolls: episode.activePolls,
            lastMessage: episode.lastMessage,
            reason,
        });
    }

    function trackAlertEpisodes(pipelineId: number, alerts: PipelineAlert[]): void {
        const now = Date.now();
        const seen = new Set<string>();
        for (const alert of alerts) {
            const key = `${pipelineId}:${alert.code}`;
            seen.add(key);
            const episode = alertEpisodes.get(key);
            if (episode) {
                alert.sinceMs = episode.startedAtMs;
                episode.lastSeenMs = now;
                episode.activePolls += 1;
                episode.absentPolls = 0;
                episode.lastMessage = alert.message;
                continue;
            }
            alertEpisodes.set(key, {
                pipelineId,
                code: alert.code,
                startedAtMs: now,
                lastSeenMs: now,
                activePolls: 1,
                absentPolls: 0,
                lastMessage: alert.message,
            });
            alert.sinceMs = now;
            diagnostics?.event('pipeline-alert-started', {
                pipelineId,
                code: alert.code,
                severity: alert.severity,
                message: alert.message,
            });
        }
        for (const [key, episode] of alertEpisodes) {
            if (episode.pipelineId !== pipelineId || seen.has(key)) continue;
            episode.absentPolls += 1;
            if (episode.absentPolls >= ALERT_EPISODE_QUIET_POLLS) endAlertEpisode(key, 'cleared');
        }
    }
    const relayInputSamples = pipelineMaps.map<RelayInputSample>();
    const legTracker = createLegTracker({
        historyMaxSamples: LEG_HISTORY_MAX_SAMPLES,
        pollIntervalMs: POLL_INTERVAL_MS,
        healthWindowMs: LEG_HEALTH_WINDOW_MS,
        appendPipelineLog: (pipelineId, event, message) =>
            db.appendPipelineLog(pipelineId, event, message),
        diagnostics,
    });
    const srtRecent = createSrtRecentTracker();
    // Goryu's latest error per stream, kept in the pipeline log and the diagnostics before
    // the relay drops it with the session. Repeats are merged: utils/relayErrorLog.ts.
    const relayErrorLog = createRelayErrorLog();
    const recordRelayError = (
        pipelineId: number,
        now: number,
        lastError: string | null,
        lastErrorAt: number | null,
    ): void => {
        const record = relayErrorLog.observe(pipelineId, now, lastError, lastErrorAt);
        if (!record) return;
        if (record.diagnostics) {
            diagnostics?.event('relay-stream-error', {
                pipelineId,
                error: lastError,
                repeat: record.kind === 'repeat',
                count: record.count,
                spanMs: record.spanMs,
            });
        }
        const message = `Relay error: ${record.message}`;
        try {
            if (
                record.kind === 'repeat' &&
                record.logId !== null &&
                db.updatePipelineLog(pipelineId, record.logId, message)
            ) {
                return;
            }
            relayErrorLog.setLogId(
                pipelineId,
                db.appendPipelineLog(pipelineId, 'relay_error', message),
            );
        } catch {
            /* non-critical */
        }
    };
    // Whether the current publisher's source address has been logged. See utils/publisherLog.ts.
    const publisherLogs = pipelineMaps.map<PublisherLogState>();
    // The ffprobe checks of each connected publisher. A format that differs from the
    // previous publisher's restarts the outputs that were already running.
    const probes = createProbeScheduler({
        db,
        diagnostics,
        onUsableProbe: (pipelineId, result) => inputLifecycle.noteProbe(pipelineId, result),
    });
    const inputLifecycle = createInputLifecycle({
        db,
        outputService,
        inputState,
        probes,
        diagnostics,
    });

    let pollInProgress = false;

    // CPU use of the processes the server manages, largest first, from the samples
    // already taken: the previous poll's per-output FFmpeg CPU and the usage source's
    // node/srs/relay. Cheap, unlike scanning /proc, so it can name suspects on a start.
    function topCpuConsumers(limit: number): { name: string; cpuPercent: number }[] {
        const consumers: { name: string; cpuPercent: number }[] = [];
        const usage = getProcessUsage?.();
        for (const [name, entry] of Object.entries(usage ?? {})) {
            if (entry.cpuPercent != null) consumers.push({ name, cpuPercent: entry.cpuPercent });
        }
        for (const [pipelineId, pipeline] of Object.entries(snapshot.pipelines)) {
            for (const [outputId, output] of Object.entries(pipeline.outputs)) {
                if (output.cpuPercent != null) {
                    consumers.push({
                        name: `output ${outputId} (pipeline ${pipelineId})`,
                        cpuPercent: output.cpuPercent,
                    });
                }
            }
        }
        return consumers.sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, limit);
    }

    const hostMonitor = createHostMonitor({
        pollIntervalMs: POLL_INTERVAL_MS,
        record: (type, message) => pushSrsEvent('host', type, message),
        topCpuConsumers,
        diagnostics,
    });

    const pollFailures = createLoopFailureReporter('health-poll', diagnostics);

    async function poll(): Promise<void> {
        if (pollInProgress) return;
        pollInProgress = true;
        try {
            await doPoll();
            pollFailures.succeeded();
        } catch (err) {
            pollFailures.failed(err);
        } finally {
            pollInProgress = false;
        }
    }

    async function doPoll(): Promise<void> {
        const pipelines = db.listPipelines();
        const activePipelineIds = new Set(pipelines.map((pipeline) => pipeline.id));
        for (const [key, episode] of alertEpisodes) {
            if (!activePipelineIds.has(episode.pipelineId))
                endAlertEpisode(key, 'pipeline deleted');
        }
        pipelineMaps.keepOnly(activePipelineIds);
        inputLifecycle.keepOnly(activePipelineIds);
        legTracker.keepOnly(activePipelineIds);
        inputState.keepOnly(activePipelineIds);
        srtRecent.keepOnly(activePipelineIds);
        relayErrorLog.keepOnly(activePipelineIds);
        probes.keepOnly(activePipelineIds);

        const outputRows = db.listOutputs();
        const outputsByPipeline = new Map<number, string[]>();
        const outputById = new Map<string, Output>();
        const lastErrorById = new Map<string, string | null>();
        const hasErrorHistoryById = new Map<string, boolean>();
        for (const o of outputRows) {
            const ids = outputsByPipeline.get(o.pipelineId);
            if (ids) ids.push(o.id);
            else outputsByPipeline.set(o.pipelineId, [o.id]);
            outputById.set(o.id, o);
            lastErrorById.set(o.id, o.lastError);
            hasErrorHistoryById.set(o.id, o.hasErrorHistory);
        }

        let streams: SrsStream[] = [];
        let clients: SrsClient[] = [];
        let srsReachable = true;
        const [streamsResult, clientsResult] = await Promise.allSettled([
            fetchSrsStreams(),
            fetchSrsClientsForHealth(),
        ]);
        if (streamsResult.status === 'fulfilled') {
            streams = streamsResult.value;
        } else {
            srsReachable = false;
            if (prevSrsReachable !== false) {
                const reason = streamsResult.reason;
                const msg = `Unreachable: ${reason instanceof Error ? reason.message : String(reason)}`;
                pushSrsEvent('srs', 'problem', msg);
                console.warn(`[srs] ${msg}`);
                diagnostics?.event('srs-transition', { from: 'up', to: 'down', message: msg });
            }
        }
        if (clientsResult.status === 'fulfilled') {
            clients = clientsResult.value;
        }
        if (srsReachable && prevSrsReachable === false) {
            pushSrsEvent('srs', 'recovered', 'Reachable again');
            console.log('[srs] reachable again');
            diagnostics?.event('srs-transition', { from: 'down', to: 'up' });
        }
        prevSrsReachable = srsReachable;
        inputState.setSrsReachable(srsReachable);

        const relayStats = srtRelayService.getStats();
        const relayFailed = relayStats.status === 'failed';
        if (relayFailed && !prevRelayFailed) {
            const msg = `Unreachable: ${relayStats.lastError ?? 'unknown error'}`;
            pushSrsEvent('relay', 'problem', msg);
            console.warn(`[relay] ${msg}`);
            diagnostics?.event('relay-transition', { from: 'running', to: 'failed', message: msg });
        } else if (!relayFailed && prevRelayFailed && relayStats.status === 'running') {
            pushSrsEvent('relay', 'recovered', 'Reachable again');
            console.log('[relay] reachable again');
            diagnostics?.event('relay-transition', { from: 'failed', to: 'running' });
        }
        prevRelayFailed = relayFailed;
        hostMonitor.check();

        const liveByPath = new Map<string, SrsStream>();
        for (const s of streams) {
            if (s.publish?.active) {
                liveByPath.set(`${s.app}/${s.name}`, s);
            }
        }
        const publisherByCid = new Map<string, SrsClient>();
        for (const client of clients) {
            if (client.publish && client.id) publisherByCid.set(client.id, client);
        }
        const pipelinesHealth: Record<string, PipelineHealth> = {};
        const staggers: PollStaggers = { ffprobe: 0, restart: 0 };
        for (const pipeline of pipelines) {
            const path = `live/${pipeline.streamKey}`;
            // When SRS is unreachable we can't distinguish a real stream drop from a
            // transient API failure, so there is no stream to observe: the lifecycle keeps
            // the last known live state and fires no spurious offline/online transitions
            // or mass restarts.
            const s = srsReachable ? liveByPath.get(path) : undefined;
            const {
                live: displayLive,
                connected: displayConnected,
                isSrt: nowSrtInput,
            } = inputLifecycle.observe(pipeline, s, srsReachable, staggers);

            const outputsHealth: Record<string, OutputHealth> = {};
            for (const outId of outputsByPipeline.get(pipeline.id) ?? []) {
                const stats = outputService.getStats(outId);
                const outputRow = outputById.get(outId);
                // Internal streams never feed pipeline liveness (that looks up
                // live/<key> only); they are read here, for a rendition's readers.
                const isRendition = !!outputRow && isRenditionOutput(outputRow);
                const renditionStream = isRendition
                    ? liveByPath.get(`${RENDITION_APP}/${outputRow.url.split('/').pop()}`)
                    : undefined;
                outputsHealth[outId] = {
                    ...stats,
                    readers: isRendition ? Math.max(0, (renditionStream?.clients ?? 1) - 1) : null,
                    failures: stats.failures,
                    lastError: lastErrorById.get(outId) ?? null,
                    hasErrorHistory: hasErrorHistoryById.get(outId) ?? false,
                };
            }

            const srtStream = displayLive && s?.tcUrl?.startsWith('srt://');
            const mediaProbe = probes.status(pipeline.id);
            const displayMediaOk = mediaProbe ? mediaProbe.ok : null;
            const displayMediaError = mediaProbe?.error ?? null;
            const probedMedia = mediaProbe?.ok ? mediaProbe.result : null;
            const displayVideo = probedMedia?.video ?? s?.video ?? null;
            inputState.setInputResolution(
                pipeline.id,
                displayConnected ? (displayVideo?.width ?? null) : null,
                displayConnected ? (displayVideo?.height ?? null) : null,
            );
            const bondingStreamId = `#!::r=live/${pipeline.streamKey},m=publish`;
            const rawBondingStatus = srtRelayService.getStreamStatus(bondingStreamId);
            const now = Date.now();
            const previousRelaySample = relayInputSamples.get(pipeline.id);
            const relayInput = rawBondingStatus.input;
            const currentRelaySample = {
                recvLossTotal: relayInput.recvLossTotal,
                recvDropTotal: relayInput.recvDropTotal,
                recvUniquePacketsTotal: relayInput.recvUniquePacketsTotal,
                retransTotal: relayInput.retransTotal,
                belatedTotal: relayInput.belatedTotal,
                latencyMs: relayInput.latencyMs,
                recvBitrateKbps: s?.kbps?.recv_30s ?? null,
                forwardedPackets: rawBondingStatus.forwardedPackets,
            };
            relayInputSamples.set(pipeline.id, currentRelaySample);
            const keyframes = probes.keyframes(pipeline.id);
            // The frame rate is RTMP only: an SRT input's frames are counted in larger
            // batches, and its link quality comes from the relay's loss/drop alerts.
            const alerts = inputLifecycle.alerts(
                pipeline.id,
                {
                    fpsStream: displayLive && !srtStream ? s : undefined,
                    nominalFps: probedMedia?.video?.fps ?? null,
                    connected: displayConnected,
                    keyframes,
                },
                now,
            );
            if (previousRelaySample && rawBondingStatus.inputActive) {
                alerts.push(...srtIntervalAlerts(previousRelaySample, currentRelaySample, now));
            }
            const {
                expectedLegs,
                legHealth,
                alerts: legAlerts,
            } = legTracker.observe(pipeline.id, relayInput, rawBondingStatus.inputActive, now);
            alerts.push(...legAlerts);
            const publisher = s?.publish?.cid ? publisherByCid.get(s.publish.cid) : undefined;
            {
                const logged = nextPublisherLog(
                    publisherLogs.get(pipeline.id),
                    displayConnected && publisher?.id ? publisher.id : null,
                    now,
                    (waitedMs) =>
                        describePublisherSource({
                            protocol: nowSrtInput ? 'srt' : 'rtmp',
                            ip: publisher?.ip ?? null,
                            loopback: isLoopbackIp(publisher?.ip),
                            relay: {
                                active: rawBondingStatus.inputActive,
                                bonded: relayInput.bonded,
                                peer: relayInput.peer,
                            },
                            waitedMs,
                        }),
                );
                if (logged.state) publisherLogs.set(pipeline.id, logged.state);
                else publisherLogs.delete(pipeline.id);
                if (logged.line) {
                    try {
                        db.appendPipelineLog(pipeline.id, 'publisher', `Publisher: ${logged.line}`);
                    } catch {
                        /* non-critical */
                    }
                    diagnostics?.event('publisher-source', {
                        pipelineId: pipeline.id,
                        source: logged.line,
                    });
                }
            }
            const localSrtPublisherConflict = outputRows.some((output) => {
                if (output.pipelineId === pipeline.id) return false;
                if (output.desiredState !== 'running') return false;
                if (outputService.getStats(output.id).status !== 'running') return false;
                return localSrtOutputTargetsStream(output.url, pipeline.streamKey);
            });
            const relayAcceptedBySrs =
                !!srtStream &&
                srsClientLooksLikeRelayPublisher(publisher) &&
                !localSrtPublisherConflict;
            const relayPublishConflict = hasBondedRelayPublishConflict({
                inputConnected: displayConnected,
                relayInputActive: rawBondingStatus.inputActive,
                relayAcceptedBySrs,
            });
            const rawLegs = rawBondingStatus.input.legs;
            const recent = srtRecent.update(pipeline.id, now, rawBondingStatus);
            recordRelayError(
                pipeline.id,
                now,
                rawBondingStatus.lastError,
                rawBondingStatus.lastErrorAt,
            );
            const bondingStatus: PipelineHealth['srtBonding'] = {
                ...rawBondingStatus,
                acceptedBySrs: relayAcceptedBySrs,
                publishConflict: relayPublishConflict,
                srsPublisher: srsPublisherInfo(publisher),
                localSrtPublisherConflict,
                input: {
                    ...rawBondingStatus.input,
                    expectedLegs,
                    recent: recent.input,
                    legs: rawLegs.map((leg) => {
                        const status = legHealth.get(`${leg.ip}:${leg.port}`);
                        return {
                            ...leg,
                            health: status?.health ?? 'ok',
                            healthReason: status?.reason ?? null,
                            recent: recent.legs.get(leg.ip) ?? null,
                        };
                    }),
                },
                output: { ...rawBondingStatus.output, recent: recent.output },
            };

            pipelinesHealth[String(pipeline.id)] = {
                input: {
                    connected: displayConnected,
                    live: displayLive,
                    isSrt:
                        !!srtStream ||
                        (displayConnected && inputState.getProtocol(pipeline.id) === 'srt'),
                    mediaOk: displayConnected ? displayMediaOk : null,
                    mediaProbeStartedAt: displayConnected
                        ? (probes.inFlightSince(pipeline.id) ?? mediaProbe?.startedAt ?? null)
                        : null,
                    mediaCheckedAt: displayConnected ? (mediaProbe?.checkedAt ?? null) : null,
                    mediaError: displayConnected ? displayMediaError : null,
                    keyframes: displayConnected ? keyframes : null,
                    recvBitrateKbps: s?.kbps?.recv_30s ?? null,
                    sendBitrateKbps: s?.kbps?.send_30s ?? null,
                    readers: s ? Math.max(0, (s.clients ?? 0) - 1) : 0,
                    uptimeMs: displayLive ? inputLifecycle.uptimeMs(pipeline.id) : null,
                    publisherIp: displayConnected ? (publisher?.ip ?? null) : null,
                    publisherType: displayConnected ? (publisher?.type ?? null) : null,
                    video: displayVideo,
                    audio: probedMedia?.audio ?? s?.audio ?? null,
                    audioTracks: probedMedia?.audioTracks ?? [],
                },
                outputs: outputsHealth,
                alerts,
                srtBonding: bondingStatus,
            };
            trackAlertEpisodes(pipeline.id, alerts);
        }

        snapshot = {
            generatedAt: new Date().toISOString(),
            srsReachable,
            srtRelay: relayStats,
            hostAlerts: hostMonitor.openAlerts(),
            configRev: db.getConfigRev(),
            pipelines: pipelinesHealth,
        };

        const snapshotAt = Date.now();
        if (
            diagnostics &&
            snapshotAt - lastDiagnosticsSnapshotAt >= DIAGNOSTICS_SNAPSHOT_INTERVAL_MS
        ) {
            const pipelineDiagnostics: Record<string, unknown> = {};
            for (const [pipelineId, pipelineHealth] of Object.entries(pipelinesHealth)) {
                pipelineDiagnostics[pipelineId] = {
                    input: {
                        connected: pipelineHealth.input.connected,
                        live: pipelineHealth.input.live,
                        isSrt: pipelineHealth.input.isSrt,
                        mediaOk: pipelineHealth.input.mediaOk,
                        recvBitrateKbps: pipelineHealth.input.recvBitrateKbps,
                        sendBitrateKbps: pipelineHealth.input.sendBitrateKbps,
                    },
                    bonding: {
                        inputActive: pipelineHealth.srtBonding.inputActive,
                        outputConnected: pipelineHealth.srtBonding.outputConnected,
                        retryFailures: pipelineHealth.srtBonding.retryFailures,
                        forwardedPackets: pipelineHealth.srtBonding.forwardedPackets,
                        forwardedBytes: pipelineHealth.srtBonding.forwardedBytes,
                        lastPacketAt: pipelineHealth.srtBonding.lastPacketAt,
                        lastInputPacketAt: pipelineHealth.srtBonding.lastInputPacketAt,
                        input: {
                            recvPacketsTotal: pipelineHealth.srtBonding.input.recvPacketsTotal,
                            recvUniquePacketsTotal:
                                pipelineHealth.srtBonding.input.recvUniquePacketsTotal,
                            recvLossTotal: pipelineHealth.srtBonding.input.recvLossTotal,
                            recvDropTotal: pipelineHealth.srtBonding.input.recvDropTotal,
                            retransTotal: pipelineHealth.srtBonding.input.retransTotal,
                            recvRateMbps: pipelineHealth.srtBonding.input.recvRateMbps,
                            latencyMs: pipelineHealth.srtBonding.input.latencyMs,
                            expectedLegs: pipelineHealth.srtBonding.input.expectedLegs,
                            legs: pipelineHealth.srtBonding.input.legs.map((leg) => ({
                                ip: leg.ip,
                                port: leg.port,
                                state: leg.state,
                                health: leg.health,
                                healthReason: leg.healthReason,
                                recvPacketsTotal: leg.recvPacketsTotal,
                                recvUniquePacketsTotal: leg.recvUniquePacketsTotal,
                                recvLossTotal: leg.recvLossTotal,
                                recvDropTotal: leg.recvDropTotal,
                                retransTotal: leg.retransTotal,
                                recvRateMbps: leg.recvRateMbps,
                                rttMs: leg.rttMs,
                                latencyMs: leg.latencyMs,
                            })),
                        },
                    },
                    // A stopped output's fields are all null; at 500 outputs they
                    // would dominate the snapshot's size.
                    outputs: Object.fromEntries(
                        Object.entries(pipelineHealth.outputs)
                            .filter(([, output]) => output.status !== 'stopped')
                            .map(([outputId, output]) => [
                                outputId,
                                {
                                    status: output.status,
                                    pid: output.pid,
                                    bitrateKbps: output.bitrateKbps,
                                    lastOutTimeUs: output.lastOutTimeUs,
                                    lastTotalSizeBytes: output.lastTotalSizeBytes,
                                    progressAgeMs: output.progressAgeMs,
                                    outputProgressAgeMs: output.outputProgressAgeMs,
                                    startedAtMs: output.startedAtMs,
                                    failures: output.failures,
                                    warningReason: output.warningReason,
                                    memoryUsageBytes: output.memoryUsageBytes,
                                    memoryLimitBytes: output.memoryLimitBytes,
                                    cpuPercent: output.cpuPercent,
                                    speed: output.speed,
                                    role: output.role,
                                    renditionId: output.renditionId,
                                    ready: output.ready,
                                    readers: output.readers,
                                },
                            ]),
                    ),
                    alerts: pipelineHealth.alerts,
                };
            }
            const mem = process.memoryUsage();
            const host = readHostMemory();
            const dataDir = path.dirname(readAppConfig().databasePath);
            const dataDisk = readDiskUsage(dataDir);
            // Kernel-side evidence for the SRT ingest sockets (the UDP buffer ceiling
            // decision in the design docs): a rising rcvbufErrorsDelta or any socket
            // drops means datagrams were lost before SRT saw them.
            const ingestPorts: number[] = [];
            for (const readPort of [
                () => readSrsConfigValues().srtPort,
                () => readRelayConfig().input_port,
            ]) {
                try {
                    ingestPorts.push(readPort());
                } catch {
                    /* config unreadable: that port is skipped */
                }
            }
            const udp = readUdpStats(ingestPorts);
            const rcvbufErrorsDelta =
                udp.rcvbufErrors != null && lastRcvbufErrors != null
                    ? Math.max(0, udp.rcvbufErrors - lastRcvbufErrors)
                    : null;
            lastRcvbufErrors = udp.rcvbufErrors;
            const usage = getProcessUsage?.();
            diagnostics.event('health-snapshot', {
                srsReachable,
                relay: relayStats,
                // CPU/RSS of the control plane, SRS and the relay over time (same
                // samples the dashboard shows, up to ~10s old). The per-output
                // numbers below only cover ffmpeg, so a Node heap leak or a
                // runaway SRS/relay would otherwise be invisible until the OOM
                // killer acted. Node's RSS is read fresh; heap detail is Node-only.
                processes: {
                    node: {
                        cpuPercent: usage?.node.cpuPercent ?? null,
                        rssBytes: mem.rss,
                        heapUsedBytes: mem.heapUsed,
                        heapTotalBytes: mem.heapTotal,
                        externalBytes: mem.external,
                        arrayBuffersBytes: mem.arrayBuffers,
                    },
                    srs: {
                        cpuPercent: usage?.srs.cpuPercent ?? null,
                        rssBytes: usage?.srs.ramBytes ?? null,
                    },
                    relay: {
                        cpuPercent: usage?.relay.cpuPercent ?? null,
                        rssBytes: usage?.relay.ramBytes ?? null,
                    },
                },
                host: {
                    totalBytes: host?.totalBytes ?? null,
                    availableBytes: host?.availableBytes ?? null,
                    swapUsedBytes: host?.swapUsedBytes ?? null,
                    dataDisk: dataDisk
                        ? {
                              path: dataDir,
                              totalBytes: dataDisk.totalBytes,
                              availableBytes: dataDisk.availableBytes,
                          }
                        : null,
                    cpuPressure: readCpuPressure(),
                    udp: { ...udp, rcvbufErrorsDelta },
                },
                pipelines: pipelineDiagnostics,
            });
            lastDiagnosticsSnapshotAt = snapshotAt;
        }
    }

    function start(): void {
        void poll();
        setInterval(() => void poll(), POLL_INTERVAL_MS).unref();
    }

    function registerRoutes(app: Express): void {
        app.get('/api/health', (_req, res) => {
            res.json(snapshot);
        });
        app.get('/api/health/pipelines/:pipelineId/legs/history', (req, res) => {
            const pipelineId = Number(req.params.pipelineId);
            if (
                !Number.isInteger(pipelineId) ||
                !db.listPipelines().some((p) => p.id === pipelineId)
            ) {
                res.status(404).json({ error: 'Pipeline not found' });
                return;
            }
            const now = Date.now();
            const requestedTo = Number(req.query.to);
            const requestedFrom = Number(req.query.from);
            const to = Number.isFinite(requestedTo) ? Math.min(requestedTo, now) : now;
            const from = Number.isFinite(requestedFrom)
                ? Math.max(requestedFrom, to - LEG_HISTORY_MAX_WINDOW_MS)
                : to - LEG_HISTORY_MAX_WINDOW_MS;
            const requestedAfter = Number(req.query.after);
            const after = Number.isFinite(requestedAfter) ? requestedAfter : null;
            const legSeries = legTracker.history(pipelineId);
            const series = legSeries.map((leg) => ({
                ...leg,
                samples: leg.samples.filter(
                    (sample) =>
                        sample.ts >= from &&
                        sample.ts <= to &&
                        (after === null || sample.ts > after),
                ),
            }));
            const allSamples = legSeries.flatMap((leg) => leg.samples);
            const oldestTs =
                allSamples.length > 0 ? Math.min(...allSamples.map((sample) => sample.ts)) : null;
            res.json({
                pipelineId,
                from,
                to,
                oldestTs,
                intervalMs: POLL_INTERVAL_MS,
                legs: series,
            });
        });
    }

    function shutdown(): void {
        probes.shutdown();
    }

    return {
        start,
        registerRoutes,
        shutdown,
        getSrsEvents: (): SrsEvent[] => [...srsEvents],
    };
}

export type HealthService = ReturnType<typeof createHealthService>;
