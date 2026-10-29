import type { ChildProcess } from 'child_process';
import type { Express } from 'express';
import path from 'path';
import {
    fetchSrsClientsForHealth,
    fetchSrsStreams,
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
import type {
    SrtRelayService,
    SrtRelayStats,
    SrtRelayStreamStatus,
    SrtRelayLegState,
} from './srtRelay.js';
import { inputPullUrl, type InputProtocol, type InputState } from './inputState.js';
import { createLoopFailureReporter, type DiagnosticsLogger } from '../utils/diagnostics.js';
import { createHostAlertTracker } from '../utils/hostAlerts.js';
import {
    formatMb,
    readCpuPressure,
    readDiskUsage,
    readHostMemory,
    readUdpStats,
    topProcessesByRss,
} from '../utils/procStats.js';
import { readRelayConfig } from '../utils/relayConfig.js';
import { createRelayErrorLog } from '../utils/relayErrorLog.js';
import { createSrtRecentTracker, type SrtRecent } from '../utils/srtRecent.js';
import {
    allowLegLogLine,
    createLegLogState,
    describeLegChange,
    suppressedLegLinesMessage,
    takeSuppressedLegLines,
    type LegLogState,
} from '../utils/legLog.js';
import {
    describePublisherSource,
    nextPublisherLog,
    type PublisherLogState,
} from '../utils/publisherLog.js';
import {
    isProbeUsable,
    keyframeIntervalTooLong,
    keyframeSummary,
    probeError,
    runFfprobe,
    runKeyframeProbe,
    type KeyframeStats,
    type ProbeFailure,
    type ProbeResult,
} from './mediaProbe.js';

export { isProbeUsable };

const FFPROBE_FAILED_REFRESH_MS = 30000;
// Stagger concurrent ffprobe launches instead of capping concurrency with a
// semaphore. The real risk is the thundering-herd burst (all N pipelines firing
// at the same millisecond after a mass reconnect), not the sustained overlap —
// probes read different streams so there is no shared bottleneck. Stagger is
// simpler and mirrors the output restart pattern; a semaphore would be needed
// only if memory pressure from simultaneous ffprobe processes became a concern.
const FFPROBE_STAGGER_MS = 200;
// Each keyframe check holds an ffprobe (about 12 MB of private memory) for the
// whole of its ~12 s window, so after a mass reconnect they queue instead of all
// running at once.
const KEYFRAME_MAX_CONCURRENT = 4;
// The check starts this long after the publisher's first successful probe, not
// right away: the first seconds of a publisher (above all one fed by another
// pipeline's output that is still recovering) are not representative, and the
// result is shown until the publisher changes. Measured once, so a bad first
// window cannot be corrected later.
const KEYFRAME_DELAY_MS = 60_000;
const POLL_INTERVAL_MS = 5000;
// An alert absent for this many polls in a row (~30 s) ends its episode, so a
// condition that flickers poll to poll is one episode, not dozens.
const ALERT_EPISODE_QUIET_POLLS = 6;
// An input that disconnects this many times within the window is flapping (a bad
// uplink or a crashing encoder), which one "Input disconnected" line per drop in
// the pipeline log does not make obvious.
// An encoder that reconnects with another codec, resolution or audio track count
// breaks the running outputs, so they are restarted. At most one such restart per
// pipeline per window, so an encoder that alternates formats cannot start a storm.
const INPUT_FORMAT_RESTART_COOLDOWN_MS = 60 * 1000;
const INPUT_FLAP_WINDOW_MS = 5 * 60 * 1000;
const INPUT_FLAP_DISCONNECTS = 3;
const MAX_SRS_EVENTS = 200;
const LEG_HISTORY_MAX_SAMPLES = (60 * 60 * 1000) / POLL_INTERVAL_MS;
const LEG_HISTORY_MAX_WINDOW_MS = 30 * 60 * 1000;
const LEG_HEALTH_WINDOW_MS = 60 * 1000;
// One second is a reasonable buffering target for long-distance or bonded
// SRT, so warn only when the negotiated latency exceeds it with some margin.
// Sudden latency spikes are still reported independently below.
const SRT_HIGH_LATENCY_WARN_MS = 1500;
// SRS adds RTMP video frames to its counter in ~5 s batches (and starts
// ~20 s after the connect), so a window's rate is off by up to one batch at each
// end: ±5 s / window, about ±4 % over 2 minutes. The ±10 % band sits clear of
// that; a real encoder drops or bursts frames by far more.
const INPUT_FPS_WINDOW_MS = 2 * 60 * 1000;
const INPUT_FPS_TOLERANCE = 0.1;
const DIAGNOSTICS_SNAPSHOT_INTERVAL_MS = 60 * 1000;
// Host MemAvailable thresholds, as a fraction of total RAM. Enter/exit differ
// so a box hovering near the line doesn't flap; the transition events carry the
// top processes by RSS so an OOM investigation can see who was holding memory.
const HOST_MEMORY_LOW_RATIO = 0.15;
const HOST_MEMORY_RECOVER_RATIO = 0.2;
// Host CPU pressure (PSI "some", 10 s average: percent of time a runnable task waited
// for a CPU). Measured on an 8-CPU host with busy loops: 8 loops (all CPUs busy, none
// starved) read 25-30, 10 loops 46-53 and 16 loops (2x oversubscribed) only 68-70, so
// 90 is never reached. It must stay at 50 or more for 30 s to start an alert and below
// 30 for 60 s to end it, so a brief encode start or a reading near the line is one episode.
const HOST_CPU_PRESSURE_HIGH = 50;
const HOST_CPU_PRESSURE_RECOVER = 30;
const HOST_CPU_START_POLLS = 6;
const HOST_CPU_END_POLLS = 12;
// Free space of the data directory's filesystem (database, diagnostics, HLS previews)
// and of the root filesystem (journald, SRS logs), as a fraction of its size.
const HOST_DISK_LOW_RATIO = 0.1;
const HOST_DISK_RECOVER_RATIO = 0.15;
const bytesToMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

// The part of a probe that running outputs depend on, as one comparable string.
function inputFormatOf(result: ProbeResult): string {
    const video = result.video
        ? `${result.video.codec} ${result.video.width}x${result.video.height}`
        : 'no video';
    const n = result.audioTracks.length;
    return `${video}, ${n} audio track${n === 1 ? '' : 's'}`;
}

function counterDelta(current: number | null, previous: number | null | undefined): number | null {
    if (current === null || previous === null || previous === undefined) return null;
    return current >= previous ? current - previous : current;
}

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

export type HostAlertKind = 'cpu' | 'memory' | 'disk';

// One line of the dashboard's Server events table: a service becoming unreachable or
// a host resource alert starting ('problem'), and the matching recovery.
export interface SrsEvent {
    ts: number;
    source: 'srs' | 'relay' | 'host';
    type: 'problem' | 'recovered';
    message: string;
}

interface ProbeStatus {
    result: ProbeResult | null;
    startedAt: number;
    checkedAt: number;
    ok: boolean;
    error: string | null;
    // Consecutive failed probes for this publisher; reset by a success.
    failedAttempts: number;
}

interface SrsPublisherInfo {
    id: string;
    ip: string | null;
    type: string | null;
}

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

function extractStreamResource(value: string): string | null {
    const candidates = [value];
    try {
        candidates.push(decodeURIComponent(value));
    } catch {
        /* keep the raw candidate only */
    }

    for (const candidate of candidates) {
        const match = /(?:^|[?,&#]|::|,)r=([^,&#]+)/.exec(candidate);
        if (!match?.[1]) continue;
        return match[1].replace(/^\/+/, '');
    }

    return null;
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

function formatDuration(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    if (h > 0 || m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

// A bitrate for an alert message: Mb/s from 1000 kb/s up.
function formatKbps(kbps: number): string {
    return kbps >= 1000 ? `${Number((kbps / 1000).toFixed(1))} Mb/s` : `${Math.round(kbps)} kb/s`;
}

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

    const inputConnected = new Map<number, boolean>();
    const inputLiveStartMs = new Map<number, number>();
    const inputPublisherCid = new Map<number, string>();
    const publisherChangedAt = new Map<number, number>();
    // The format of each pipeline's last successfully probed input, kept across
    // reconnects so a different one on the next publisher is noticed.
    const inputFormats = new Map<number, string>();
    const lastFormatRestartAt = new Map<number, number>();
    // When each pipeline's input disconnected, within INPUT_FLAP_WINDOW_MS.
    const inputDisconnectsAt = new Map<number, number[]>();
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
    // Per-pipeline RTMP video-frame counter samples, one per poll, covering
    // the last INPUT_FPS_WINDOW_MS.
    const inputFrameSamples = new Map<
        number,
        { cid: string | undefined; points: { at: number; frames: number }[] }
    >();
    // Frame rate over the last full window, or null while the window is not
    // full (new publisher, counter reset, SRS not counting yet).
    function measureInputFps(
        pipelineId: number,
        stream: SrsStream | undefined,
        now: number,
    ): number | null {
        const frames = stream?.frames ?? 0;
        if (!stream || !frames) {
            inputFrameSamples.delete(pipelineId);
            return null;
        }
        const cid = stream.publish?.cid;
        let entry = inputFrameSamples.get(pipelineId);
        const last = entry?.points.at(-1);
        if (!entry || entry.cid !== cid || (last && frames < last.frames)) {
            entry = { cid, points: [] };
            inputFrameSamples.set(pipelineId, entry);
        }
        const { points } = entry;
        points.push({ at: now, frames });
        // Keep the newest sample that is at least a window old as the baseline.
        while (points.length > 1 && now - points[1].at >= INPUT_FPS_WINDOW_MS) points.shift();
        const oldest = points[0];
        const elapsedMs = now - oldest.at;
        if (elapsedMs < INPUT_FPS_WINDOW_MS) return null;
        return ((frames - oldest.frames) * 1000) / elapsedMs;
    }
    const relayInputSamples = new Map<
        number,
        {
            recvLossTotal: number | null;
            recvDropTotal: number | null;
            recvUniquePacketsTotal: number;
            retransTotal: number | null;
            belatedTotal: number | null;
            latencyMs: number | null;
            recvBitrateKbps: number | null;
            forwardedPackets: number;
        }
    >();
    const legPacketSamples = new Map<
        number,
        Map<
            string,
            {
                state: SrtRelayLegState;
                packets: number | null;
                noFlowSinceMs: number | null;
                recvLossTotal: number | null;
                recvDropTotal: number | null;
                retransTotal: number | null;
                belatedTotal: number | null;
            }
        >
    >();
    const legHistory = new Map<number, Map<string, LegHistorySeries>>();
    const srtRecent = createSrtRecentTracker();
    // The relay drops a failed leg from its legs[] instead of reporting it broken,
    // so a lost leg shows only as a smaller count than the group has had. Keyed by
    // pipeline; reset when the input goes away.
    const legGroups = new Map<number, { expected: number; shortSinceMs: number | null }>();
    // Which legs (ip:port) a bonded input had at the last poll, for the pipeline log and
    // the diagnostics. Keyed by pipeline; reset when the input goes away. See utils/legLog.ts.
    const legLogs = new Map<number, LegLogState>();
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
    const publisherLogs = new Map<number, PublisherLogState>();
    const noteLegChanges = (
        pipelineId: number,
        legs: { ip: string; port: number }[],
        now: number,
    ): void => {
        const keys = legs.map((leg) => `${leg.ip}:${leg.port}`);
        const state = legLogs.get(pipelineId);
        const change = describeLegChange(state?.keys ?? null, keys);
        const current = state ?? createLegLogState(keys, now);
        current.keys = keys;
        legLogs.set(pipelineId, current);
        const appendLine = (event: string, message: string): void => {
            try {
                db.appendPipelineLog(pipelineId, event, message);
            } catch {
                /* non-critical */
            }
        };
        const hidden = takeSuppressedLegLines(current, now);
        if (hidden > 0) appendLine('legs', suppressedLegLinesMessage(hidden));
        if (!change) return;
        diagnostics?.event('bonded-legs-changed', {
            pipelineId,
            from: change.from,
            to: change.to,
            joined: change.joined,
            left: change.left,
            legs: keys,
        });
        if (allowLegLogLine(current, now)) appendLine('legs', change.message);
    };
    const ffprobeResults = new Map<number, ProbeStatus>();
    const ffprobeTimers = new Map<number, NodeJS.Timeout>();
    const ffprobeInFlight = new Set<number>();
    const ffprobeStartedAt = new Map<number, number>();
    const ffprobeChildren = new Map<number, ChildProcess>();
    const ffprobeGenerations = new Map<number, number>();
    // Keyframe check per pipeline: once per publisher, KEYFRAME_DELAY_MS after its first successful probe.
    const keyframeResults = new Map<number, KeyframeStats & { checkedAt: number }>();
    // Pipelines whose current publisher has had its check queued (it runs once, so
    // this stays set after it finishes, or fails, until the publisher changes).
    const keyframeScheduled = new Set<number>();
    const keyframeChildren = new Map<number, ChildProcess>();
    interface KeyframeJob {
        pipelineId: number;
        url: string;
        protocol: InputProtocol;
        generation: number;
    }
    const keyframeQueue: KeyframeJob[] = [];
    let keyframeRunning = 0;
    // Set by shutdown(): a probe still in flight must not start a keyframe check.
    let stopped = false;

    function clearFfprobeState(pipelineId: number): void {
        if (
            !ffprobeTimers.has(pipelineId) &&
            !ffprobeInFlight.has(pipelineId) &&
            !ffprobeResults.has(pipelineId) &&
            !keyframeScheduled.has(pipelineId) &&
            !keyframeResults.has(pipelineId)
        ) {
            return;
        }
        const timer = ffprobeTimers.get(pipelineId);
        if (timer) clearTimeout(timer);
        ffprobeTimers.delete(pipelineId);
        ffprobeInFlight.delete(pipelineId);
        ffprobeStartedAt.delete(pipelineId);
        const child = ffprobeChildren.get(pipelineId);
        if (child && child.exitCode == null && child.signalCode == null) {
            child.kill('SIGKILL');
        }
        ffprobeChildren.delete(pipelineId);
        ffprobeResults.delete(pipelineId);
        const keyframeChild = keyframeChildren.get(pipelineId);
        if (keyframeChild && keyframeChild.exitCode == null && keyframeChild.signalCode == null) {
            keyframeChild.kill('SIGKILL');
        }
        keyframeChildren.delete(pipelineId);
        keyframeScheduled.delete(pipelineId);
        keyframeResults.delete(pipelineId);
        ffprobeGenerations.set(pipelineId, (ffprobeGenerations.get(pipelineId) ?? 0) + 1);
    }

    // Failed probes leave the dashboard error as the only trace unless they are
    // recorded. Every failure goes to diagnostics (bounded by the 30 s retry
    // cadence and the diagnostics size caps); the pipeline log only gets the
    // first failure and the recovery per publisher so a persistently bad input
    // cannot flood it.
    function recordProbeOutcome(
        pipelineId: number,
        protocol: InputProtocol,
        outcome: {
            ok: boolean;
            previousFailures: number;
            error: string | null;
            failure: ProbeFailure | null;
            elapsedMs: number;
        },
    ): void {
        const { ok, previousFailures, error, failure, elapsedMs } = outcome;
        if (ok && previousFailures === 0) return;
        let pipelineLogEvent: string | null = null;
        let pipelineLogMessage = '';
        if (ok) {
            pipelineLogEvent = 'probe_recovered';
            pipelineLogMessage = `ffprobe validated the input after ${previousFailures} failed ${previousFailures === 1 ? 'attempt' : 'attempts'}`;
            diagnostics?.event('media-probe-recovered', {
                pipelineId,
                protocol,
                failedAttempts: previousFailures,
                elapsedMs,
            });
        } else {
            const reason = failure?.reason ?? 'unusable';
            if (previousFailures === 0) {
                pipelineLogEvent = 'probe_failed';
                pipelineLogMessage =
                    reason === 'timeout'
                        ? `ffprobe timed out after ${Math.round(elapsedMs / 1000)}s without media data`
                        : `ffprobe failed (${reason}): ${error ?? 'no usable video stream'}`;
            }
            diagnostics?.event('media-probe-failed', {
                pipelineId,
                protocol,
                reason,
                attempt: previousFailures + 1,
                elapsedMs,
                exitCode: failure?.exitCode ?? null,
                signal: failure?.signal ?? null,
                error,
                stderrTail: failure?.stderrTail ?? '',
            });
            console.warn(
                `[probe] pipeline ${pipelineId} (${protocol}) attempt ${previousFailures + 1} failed: ${reason} after ${elapsedMs}ms`,
            );
        }
        if (pipelineLogEvent) {
            try {
                db.appendPipelineLog(pipelineId, pipelineLogEvent, pipelineLogMessage);
            } catch {
                /* non-critical */
            }
        }
    }

    // Called with every successful probe. A format that differs from the previous
    // publisher's restarts the outputs that were already running (never on a failed
    // probe, which proves nothing about the format).
    function noteInputFormat(pipelineId: number, result: ProbeResult): void {
        const format = inputFormatOf(result);
        const previous = inputFormats.get(pipelineId);
        inputFormats.set(pipelineId, format);
        if (previous === undefined || previous === format) return;
        const now = Date.now();
        // Outputs that started after the new publisher connected already read the
        // new format.
        const publisherStartedAt = Math.max(
            publisherChangedAt.get(pipelineId) ?? 0,
            inputLiveStartMs.get(pipelineId) ?? 0,
        );
        const sinceLastRestartMs = now - (lastFormatRestartAt.get(pipelineId) ?? -Infinity);
        const suppressed = sinceLastRestartMs < INPUT_FORMAT_RESTART_COOLDOWN_MS;
        const why = `input format changed from ${previous} to ${format}`;
        let restarted = 0;
        if (!suppressed && publisherStartedAt > 0) {
            lastFormatRestartAt.set(pipelineId, now);
            restarted = outputService.restartRunningOutputs(pipelineId, why, publisherStartedAt);
        }
        diagnostics?.event('input-format-changed', {
            pipelineId,
            from: previous,
            to: format,
            outputsRestarted: restarted,
            suppressed,
            cooldownMs: INPUT_FORMAT_RESTART_COOLDOWN_MS,
        });
        try {
            db.appendPipelineLog(
                pipelineId,
                'format_changed',
                suppressed
                    ? `Input format changed from ${previous} to ${format}; outputs not restarted (another format restart less than ${INPUT_FORMAT_RESTART_COOLDOWN_MS / 1000} s ago)`
                    : `Input format changed from ${previous} to ${format}; restarting ${restarted} running ${restarted === 1 ? 'output' : 'outputs'}`,
            );
        } catch {
            /* non-critical */
        }
    }

    // Measures the keyframe gaps once per publisher, KEYFRAME_DELAY_MS after its first successful
    // probe. Reporting only: a failed check is a diagnostics event, not a retry
    // loop and not a media error, and the result is dropped with the publisher.
    function queueKeyframeProbe(job: KeyframeJob): void {
        keyframeScheduled.add(job.pipelineId);
        keyframeQueue.push(job);
        pumpKeyframeQueue();
    }

    function pumpKeyframeQueue(): void {
        while (!stopped && keyframeRunning < KEYFRAME_MAX_CONCURRENT && keyframeQueue.length > 0) {
            const job = keyframeQueue.shift()!;
            // The publisher changed or the pipeline went away while it waited.
            if ((ffprobeGenerations.get(job.pipelineId) ?? 0) !== job.generation) continue;
            keyframeRunning++;
            void runKeyframeProbeJob(job).finally(() => {
                keyframeRunning--;
                pumpKeyframeQueue();
            });
        }
    }

    async function runKeyframeProbeJob(job: KeyframeJob): Promise<void> {
        const { pipelineId, url, protocol, generation } = job;
        const current = (): boolean =>
            !stopped && (ffprobeGenerations.get(pipelineId) ?? 0) === generation;
        const startedAt = Date.now();
        try {
            let failure: ProbeFailure | null = null;
            const stats = await runKeyframeProbe(
                url,
                (child) => {
                    keyframeChildren.set(pipelineId, child);
                },
                (info) => {
                    failure = info;
                },
            );
            if (!current()) return;
            const elapsedMs = Date.now() - startedAt;
            if (!stats) {
                const info = failure as ProbeFailure | null;
                diagnostics?.event('keyframe-probe-failed', {
                    pipelineId,
                    protocol,
                    reason: info?.reason ?? 'unknown',
                    elapsedMs,
                    exitCode: info?.exitCode ?? null,
                    signal: info?.signal ?? null,
                    stderrTail: info?.stderrTail ?? '',
                });
                console.warn(
                    `[probe] pipeline ${pipelineId} (${protocol}) keyframe check failed: ${info?.reason ?? 'unknown'} after ${elapsedMs}ms; no keyframe interval for this publisher`,
                );
                return;
            }
            keyframeResults.set(pipelineId, { ...stats, checkedAt: Date.now() });
            const tooLong = keyframeIntervalTooLong(stats);
            diagnostics?.event('keyframe-interval', {
                pipelineId,
                protocol,
                keyframes: stats.keyframes,
                meanGapSec: stats.meanGapSec,
                maxGapSec: stats.maxGapSec,
                spanSec: stats.spanSec,
                windowSec: stats.windowSec,
                tooLong,
                elapsedMs,
            });
            if (tooLong) {
                try {
                    db.appendPipelineLog(
                        pipelineId,
                        'keyframe_interval',
                        `Keyframes are too far apart: ${keyframeSummary(stats)}`,
                    );
                } catch {
                    /* non-critical */
                }
            }
        } catch (err) {
            // This runs detached, so a rejection would have no handler.
            console.error(
                `[probe] pipeline ${pipelineId} (${protocol}) keyframe check handling failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        } finally {
            // Only this publisher's child: a new publisher may already have its own.
            if (current()) keyframeChildren.delete(pipelineId);
        }
    }

    async function runScheduledFfprobe(
        pipelineId: number,
        url: string,
        protocol: InputProtocol,
        generation: number,
    ): Promise<void> {
        ffprobeTimers.delete(pipelineId);
        ffprobeInFlight.add(pipelineId);
        const startedAt = Date.now();
        ffprobeStartedAt.set(pipelineId, startedAt);
        try {
            let failure: ProbeFailure | null = null;
            const result = await runFfprobe(
                url,
                (child) => {
                    ffprobeChildren.set(pipelineId, child);
                },
                (info) => {
                    failure = info;
                },
            );
            if ((ffprobeGenerations.get(pipelineId) ?? 0) !== generation) return;
            const ok = isProbeUsable(result);
            const checkedAt = Date.now();
            const previousFailures = ffprobeResults.get(pipelineId)?.failedAttempts ?? 0;
            const error = ok ? null : probeError(result, checkedAt);
            ffprobeResults.set(pipelineId, {
                result,
                startedAt,
                checkedAt,
                ok,
                error,
                failedAttempts: ok ? 0 : previousFailures + 1,
            });
            if (ok && result) noteInputFormat(pipelineId, result);
            recordProbeOutcome(pipelineId, protocol, {
                ok,
                previousFailures,
                error,
                failure,
                elapsedMs: checkedAt - startedAt,
            });
        } catch (err) {
            // This runs from a timer, so a rejection would have no handler
            // and would crash the process.
            console.error(
                `[probe] pipeline ${pipelineId} (${protocol}) probe handling failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        } finally {
            ffprobeInFlight.delete(pipelineId);
            ffprobeStartedAt.delete(pipelineId);
            ffprobeChildren.delete(pipelineId);
        }
    }

    function scheduleFfprobe(
        pipelineId: number,
        streamKey: string,
        protocol: InputProtocol,
        delayMs = 0,
    ) {
        if (ffprobeTimers.has(pipelineId) || ffprobeInFlight.has(pipelineId)) return;
        const url = inputPullUrl(streamKey, protocol);
        const generation = ffprobeGenerations.get(pipelineId) ?? 0;
        const timer = setTimeout(
            () => void runScheduledFfprobe(pipelineId, url, protocol, generation),
            delayMs,
        );
        ffprobeTimers.set(pipelineId, timer);
        timer.unref?.();
    }

    // Probes once per connected publisher; if that probe fails, keeps retrying
    // every FFPROBE_FAILED_REFRESH_MS until it succeeds. Once a probe succeeds
    // for this publisher, it stops re-probing (avoids repeated SRT play/teardown
    // cycles once the input is known healthy).
    function scheduleFfprobeUntilHealthy(
        pipelineId: number,
        streamKey: string,
        protocol: InputProtocol,
        stagger: number,
    ): void {
        if (ffprobeTimers.has(pipelineId) || ffprobeInFlight.has(pipelineId)) return;
        const status = ffprobeResults.get(pipelineId);
        if (status?.ok) return;
        if (status && Date.now() - status.checkedAt < FFPROBE_FAILED_REFRESH_MS) return;
        scheduleFfprobe(pipelineId, streamKey, protocol, stagger * FFPROBE_STAGGER_MS);
    }

    // Called every poll for a connected input: queues its keyframe check once its
    // first successful probe is KEYFRAME_DELAY_MS old.
    function queueKeyframeProbeWhenDue(
        pipelineId: number,
        streamKey: string,
        protocol: InputProtocol,
    ): void {
        const status = ffprobeResults.get(pipelineId);
        if (stopped || keyframeScheduled.has(pipelineId)) return;
        if (!status?.ok || Date.now() - status.checkedAt < KEYFRAME_DELAY_MS) return;
        queueKeyframeProbe({
            pipelineId,
            url: inputPullUrl(streamKey, protocol),
            protocol,
            generation: ffprobeGenerations.get(pipelineId) ?? 0,
        });
    }

    let pollInProgress = false;

    // Host resource alerts (memory, CPU, disk). Each transition is a journal line, a
    // diagnostics event and a row in the dashboard's Server events table; the table
    // is in memory only, the diagnostics events are the durable record.
    const hostMemoryAlert = createHostAlertTracker({
        worse: 'lower',
        breached: (ratio) => ratio < HOST_MEMORY_LOW_RATIO,
        cleared: (ratio) => ratio >= HOST_MEMORY_RECOVER_RATIO,
        startPolls: 1,
        endPolls: 1,
    });
    const hostCpuAlert = createHostAlertTracker({
        worse: 'higher',
        breached: (pressure) => pressure >= HOST_CPU_PRESSURE_HIGH,
        cleared: (pressure) => pressure < HOST_CPU_PRESSURE_RECOVER,
        startPolls: HOST_CPU_START_POLLS,
        endPolls: HOST_CPU_END_POLLS,
    });
    // One tracker per filesystem, keyed by its device so a data directory on the root
    // filesystem is checked once.
    const hostDiskAlerts = new Map<number, ReturnType<typeof createHostAlertTracker>>();

    function hostEvent(
        type: SrsEvent['type'],
        message: string,
        event: string,
        fields: Record<string, unknown>,
    ): void {
        pushSrsEvent('host', type, message);
        if (type === 'problem') console.warn(`[host] ${message}`);
        else console.log(`[host] ${message}`);
        diagnostics?.event(event, { message, ...fields });
    }

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

    function checkHostMemory(): void {
        const host = readHostMemory();
        if (!host) return;
        const ratio = host.availableBytes / host.totalBytes;
        const change = hostMemoryAlert.update(ratio);
        if (!change) return;
        const started = change.change === 'started';
        const fields = {
            availableMb: bytesToMb(host.availableBytes),
            totalMb: bytesToMb(host.totalBytes),
            swapUsedMb: bytesToMb(host.swapUsedBytes),
            thresholdPercent: Math.round(
                (started ? HOST_MEMORY_LOW_RATIO : HOST_MEMORY_RECOVER_RATIO) * 100,
            ),
        };
        if (started) {
            const top = topProcessesByRss(5).map((p) => ({
                pid: p.pid,
                name: p.name,
                rssMb: bytesToMb(p.rssBytes),
            }));
            hostEvent(
                'problem',
                `Memory low: ${formatMb(fields.availableMb)} of ${formatMb(fields.totalMb)} available; top: ${top
                    .map((p) => `${p.name}(${p.pid})=${formatMb(p.rssMb)}`)
                    .join(' ')}`,
                'host-memory-low',
                { ...fields, topProcesses: top },
            );
        } else {
            hostEvent(
                'recovered',
                `Memory recovered: ${formatMb(fields.availableMb)} available`,
                'host-memory-recovered',
                fields,
            );
        }
    }

    function checkHostCpu(): void {
        const pressure = readCpuPressure();
        if (!pressure) return; // no PSI: no CPU alert, the snapshot records cpuPressure null
        const change = hostCpuAlert.update(pressure.some10);
        if (!change) return;
        if (change.change === 'started') {
            const top = topCpuConsumers(5);
            hostEvent(
                'problem',
                `CPU saturated: pressure ${pressure.some10}% (10 s) for ${(HOST_CPU_START_POLLS * POLL_INTERVAL_MS) / 1000}s; top: ${
                    top.map((c) => `${c.name}=${c.cpuPercent}%`).join(' ') || 'unknown'
                }`,
                'host-cpu-high',
                {
                    pressure10: pressure.some10,
                    pressure60: pressure.some60,
                    thresholdPercent: HOST_CPU_PRESSURE_HIGH,
                    topConsumers: top,
                },
            );
        } else {
            hostEvent(
                'recovered',
                `CPU recovered: pressure ${pressure.some10}% (10 s), peak ${change.worst}% over ${formatDuration(Math.round((change.polls * POLL_INTERVAL_MS) / 1000))}`,
                'host-cpu-recovered',
                {
                    pressure10: pressure.some10,
                    pressure60: pressure.some60,
                    peakPressure10: change.worst,
                    durationMs: change.polls * POLL_INTERVAL_MS,
                    thresholdPercent: HOST_CPU_PRESSURE_RECOVER,
                },
            );
        }
    }

    function checkHostDisk(): void {
        const dataDir = path.dirname(readAppConfig().databasePath);
        const seen = new Set<number>();
        for (const dir of [dataDir, '/']) {
            const disk = readDiskUsage(dir);
            if (!disk || seen.has(disk.device)) continue;
            seen.add(disk.device);
            let tracker = hostDiskAlerts.get(disk.device);
            if (!tracker) {
                tracker = createHostAlertTracker({
                    worse: 'lower',
                    breached: (ratio) => ratio < HOST_DISK_LOW_RATIO,
                    cleared: (ratio) => ratio >= HOST_DISK_RECOVER_RATIO,
                    startPolls: 1,
                    endPolls: 1,
                });
                hostDiskAlerts.set(disk.device, tracker);
            }
            const change = tracker.update(disk.availableBytes / disk.totalBytes);
            if (!change) continue;
            const started = change.change === 'started';
            const fields = {
                path: dir,
                availableMb: bytesToMb(disk.availableBytes),
                totalMb: bytesToMb(disk.totalBytes),
                thresholdPercent: Math.round(
                    (started ? HOST_DISK_LOW_RATIO : HOST_DISK_RECOVER_RATIO) * 100,
                ),
            };
            hostEvent(
                started ? 'problem' : 'recovered',
                started
                    ? `Disk space low on ${dir}: ${formatMb(fields.availableMb)} of ${formatMb(fields.totalMb)} free`
                    : `Disk space recovered on ${dir}: ${formatMb(fields.availableMb)} free`,
                started ? 'host-disk-low' : 'host-disk-recovered',
                fields,
            );
        }
    }

    function openHostAlerts(): HostAlertKind[] {
        const open: HostAlertKind[] = [];
        if (hostCpuAlert.active) open.push('cpu');
        if (hostMemoryAlert.active) open.push('memory');
        if ([...hostDiskAlerts.values()].some((tracker) => tracker.active)) open.push('disk');
        return open;
    }

    function checkHostResources(): void {
        checkHostMemory();
        checkHostCpu();
        checkHostDisk();
    }

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
        for (const pipelineId of inputConnected.keys()) {
            if (!activePipelineIds.has(pipelineId)) inputConnected.delete(pipelineId);
        }
        for (const pipelineId of inputLiveStartMs.keys()) {
            if (!activePipelineIds.has(pipelineId)) inputLiveStartMs.delete(pipelineId);
        }
        for (const pipelineId of inputPublisherCid.keys()) {
            if (!activePipelineIds.has(pipelineId)) inputPublisherCid.delete(pipelineId);
        }
        for (const pipelineId of publisherLogs.keys()) {
            if (!activePipelineIds.has(pipelineId)) publisherLogs.delete(pipelineId);
        }
        for (const pipelineId of publisherChangedAt.keys()) {
            if (!activePipelineIds.has(pipelineId)) publisherChangedAt.delete(pipelineId);
        }
        for (const pipelineId of inputDisconnectsAt.keys()) {
            if (!activePipelineIds.has(pipelineId)) inputDisconnectsAt.delete(pipelineId);
        }
        for (const pipelineId of inputFormats.keys()) {
            if (!activePipelineIds.has(pipelineId)) {
                inputFormats.delete(pipelineId);
                lastFormatRestartAt.delete(pipelineId);
            }
        }
        for (const pipelineId of relayInputSamples.keys()) {
            if (!activePipelineIds.has(pipelineId)) relayInputSamples.delete(pipelineId);
        }
        for (const pipelineId of inputFrameSamples.keys()) {
            if (!activePipelineIds.has(pipelineId)) inputFrameSamples.delete(pipelineId);
        }
        for (const pipelineId of legPacketSamples.keys()) {
            if (!activePipelineIds.has(pipelineId)) legPacketSamples.delete(pipelineId);
        }
        for (const pipelineId of legHistory.keys()) {
            if (!activePipelineIds.has(pipelineId)) legHistory.delete(pipelineId);
        }
        srtRecent.keepOnly(activePipelineIds);
        for (const pipelineId of legGroups.keys()) {
            if (!activePipelineIds.has(pipelineId)) legGroups.delete(pipelineId);
        }
        for (const pipelineId of legLogs.keys()) {
            if (!activePipelineIds.has(pipelineId)) legLogs.delete(pipelineId);
        }
        relayErrorLog.keepOnly(activePipelineIds);
        for (const pipelineId of ffprobeResults.keys()) {
            if (!activePipelineIds.has(pipelineId)) clearFfprobeState(pipelineId);
        }
        for (const pipelineId of ffprobeTimers.keys()) {
            if (!activePipelineIds.has(pipelineId)) clearFfprobeState(pipelineId);
        }
        for (const pipelineId of ffprobeInFlight) {
            if (!activePipelineIds.has(pipelineId)) clearFfprobeState(pipelineId);
        }

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
        checkHostResources();

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
        let ffprobeStagger = 0;
        let restartStagger = 0;
        for (const pipeline of pipelines) {
            const path = `live/${pipeline.streamKey}`;
            // When SRS is unreachable we can't distinguish a real stream drop from a
            // transient API failure. Preserve the last known live state so we don't
            // fire spurious offline/online transitions or mass-restart all outputs.
            const prevConnected = inputConnected.get(pipeline.id) ?? false;
            const prevLive = inputState.isLive(pipeline.id);
            const s = srsReachable ? liveByPath.get(path) : undefined;
            const nowConnected = srsReachable ? !!s : prevConnected;
            const nowSrtInput = !!s?.tcUrl?.startsWith('srt://');
            const prevPublisherCid = inputPublisherCid.get(pipeline.id) ?? null;
            const publisherCid = s?.publish?.cid ?? null;
            const publisherChanged =
                nowConnected &&
                publisherCid !== null &&
                prevPublisherCid !== null &&
                publisherCid !== prevPublisherCid;
            if (publisherChanged) {
                clearFfprobeState(pipeline.id);
                publisherChangedAt.set(pipeline.id, Date.now());
                diagnostics?.event('input-publisher-transition', {
                    pipelineId: pipeline.id,
                    fromCid: prevPublisherCid,
                    toCid: publisherCid,
                    protocol: nowSrtInput ? 'srt' : 'rtmp',
                });
            }
            const nowProtocol: InputProtocol | null = nowConnected
                ? nowSrtInput
                    ? 'srt'
                    : 'rtmp'
                : null;
            const nowLive = srsReachable ? nowConnected : prevLive;
            // UI should reflect whether the input is currently usable through SRS.
            // Keep nowLive sticky internally for restart/logging behavior during an
            // SRS outage, but don't present a stale green input while SRS is down.
            const displayLive = srsReachable ? nowLive : false;
            const displayConnected = srsReachable ? nowConnected : false;

            if (srsReachable) {
                inputConnected.set(pipeline.id, nowConnected);
                if (nowConnected && s) {
                    if (publisherCid) inputPublisherCid.set(pipeline.id, publisherCid);
                    inputState.setPipelineState(pipeline.id, nowLive, nowProtocol);
                    if (nowProtocol) {
                        scheduleFfprobeUntilHealthy(
                            pipeline.id,
                            pipeline.streamKey,
                            nowProtocol,
                            ffprobeStagger++,
                        );
                        queueKeyframeProbeWhenDue(pipeline.id, pipeline.streamKey, nowProtocol);
                    }
                } else if (!nowConnected) {
                    inputState.clearPipeline(pipeline.id);
                }

                if (!prevLive && nowLive) {
                    inputLiveStartMs.set(pipeline.id, Date.now());
                    restartStagger += outputService.restartPipelineOutputs(
                        pipeline.id,
                        restartStagger,
                    );
                    try {
                        db.appendPipelineLog(
                            pipeline.id,
                            'online',
                            `Input media detected (${inputState.getProtocol(pipeline.id) ?? 'unknown'})`,
                        );
                    } catch {
                        /* non-critical */
                    }
                    diagnostics?.event('input-transition', {
                        pipelineId: pipeline.id,
                        from: prevLive ? 'live' : 'offline',
                        to: 'live',
                        protocol: inputState.getProtocol(pipeline.id),
                    });
                }

                if (prevConnected && !nowConnected) {
                    const liveStartMs = inputLiveStartMs.get(pipeline.id);
                    const uptimeSec =
                        liveStartMs != null ? Math.round((Date.now() - liveStartMs) / 1000) : null;
                    inputDisconnectsAt.set(pipeline.id, [
                        ...(inputDisconnectsAt.get(pipeline.id) ?? []),
                        Date.now(),
                    ]);
                    inputConnected.delete(pipeline.id);
                    inputPublisherCid.delete(pipeline.id);
                    inputState.clearPipeline(pipeline.id);
                    inputLiveStartMs.delete(pipeline.id);
                    clearFfprobeState(pipeline.id);
                    try {
                        db.appendPipelineLog(
                            pipeline.id,
                            'offline',
                            uptimeSec == null
                                ? 'Input disconnected'
                                : `Input disconnected (was live for ${formatDuration(uptimeSec)})`,
                        );
                    } catch {
                        /* non-critical */
                    }
                    diagnostics?.event('input-transition', {
                        pipelineId: pipeline.id,
                        from: 'connected',
                        to: 'disconnected',
                        uptimeSec,
                    });
                }
            }

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
            const mediaProbe = ffprobeResults.get(pipeline.id) ?? null;
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
            const alerts: PipelineAlert[] = [];
            // RTMP only: an SRT input's frames are counted in larger batches,
            // and its link quality comes from the relay's loss/drop alerts.
            const inputFps = measureInputFps(
                pipeline.id,
                displayLive && !srtStream ? s : undefined,
                now,
            );
            const nominalFps = probedMedia?.video?.fps ?? null;
            if (inputFps !== null && nominalFps) {
                const low = inputFps < nominalFps * (1 - INPUT_FPS_TOLERANCE);
                if (low || inputFps > nominalFps * (1 + INPUT_FPS_TOLERANCE)) {
                    alerts.push({
                        severity: 'warning',
                        code: low ? 'input-low-framerate' : 'input-high-framerate',
                        message: `Input is delivering ${inputFps.toFixed(1)} fps; ffprobe reports ${nominalFps} fps.`,
                        sinceMs: now,
                    });
                }
            }
            const keyframes = keyframeResults.get(pipeline.id) ?? null;
            if (displayConnected && keyframes && keyframeIntervalTooLong(keyframes)) {
                alerts.push({
                    severity: 'warning',
                    code: 'input-keyframe-interval',
                    message: `Input keyframes are too far apart: ${keyframeSummary(keyframes)}`,
                    sinceMs: keyframes.checkedAt,
                });
            }
            const recentDisconnects = (inputDisconnectsAt.get(pipeline.id) ?? []).filter(
                (at) => now - at <= INPUT_FLAP_WINDOW_MS,
            );
            if (recentDisconnects.length > 0)
                inputDisconnectsAt.set(pipeline.id, recentDisconnects);
            else inputDisconnectsAt.delete(pipeline.id);
            if (recentDisconnects.length >= INPUT_FLAP_DISCONNECTS) {
                alerts.push({
                    severity: 'warning',
                    code: 'input-flapping',
                    message: `Input disconnected ${recentDisconnects.length} times in the last 5 minutes.`,
                    sinceMs: recentDisconnects[0],
                });
            }
            const changedAt = publisherChangedAt.get(pipeline.id);
            if (changedAt && now - changedAt <= 30_000) {
                alerts.push({
                    severity: 'warning',
                    code: 'publisher-reconnected',
                    message: 'SRT publisher reconnected; input timing may be recovering.',
                    sinceMs: changedAt,
                });
            } else if (changedAt) {
                publisherChangedAt.delete(pipeline.id);
            }
            if (previousRelaySample && rawBondingStatus.inputActive) {
                const dropped = counterDelta(
                    currentRelaySample.recvDropTotal,
                    previousRelaySample.recvDropTotal,
                );
                const lost = counterDelta(
                    currentRelaySample.recvLossTotal,
                    previousRelaySample.recvLossTotal,
                );
                const received = Math.max(
                    0,
                    currentRelaySample.recvUniquePacketsTotal -
                        previousRelaySample.recvUniquePacketsTotal,
                );
                const lossRatio = received > 0 && lost !== null ? lost / received : 0;
                const retransmitted = counterDelta(
                    currentRelaySample.retransTotal,
                    previousRelaySample.retransTotal,
                );
                const forwarded = Math.max(
                    0,
                    currentRelaySample.forwardedPackets - previousRelaySample.forwardedPackets,
                );
                if (dropped !== null && dropped > 0) {
                    alerts.push({
                        severity: 'warning',
                        code: 'srt-packets-dropped',
                        message: `SRT input dropped ${dropped} packet${dropped === 1 ? '' : 's'} in the last health interval.`,
                        sinceMs: now,
                    });
                } else if (lossRatio >= 0.01) {
                    alerts.push({
                        severity: 'warning',
                        code: 'srt-packet-loss',
                        message: `SRT input packet loss is ${(lossRatio * 100).toFixed(1)}% in the last health interval.`,
                        sinceMs: now,
                    });
                }
                if (received > 0 && retransmitted !== null && retransmitted / received >= 0.05) {
                    alerts.push({
                        severity: 'warning',
                        code: 'srt-retransmissions',
                        message: `SRT retransmissions reached ${((retransmitted / received) * 100).toFixed(1)}% in the last health interval.`,
                        sinceMs: now,
                    });
                }
                const belated =
                    currentRelaySample.belatedTotal !== null &&
                    previousRelaySample.belatedTotal !== null
                        ? Math.max(
                              0,
                              currentRelaySample.belatedTotal - previousRelaySample.belatedTotal,
                          )
                        : 0;
                if (belated > 100) {
                    alerts.push({
                        severity: 'warning',
                        code: 'srt-belated-packets',
                        message: `SRT received ${belated} belated packets in the last health interval.`,
                        sinceMs: now,
                    });
                }
                if (
                    currentRelaySample.latencyMs !== null &&
                    (currentRelaySample.latencyMs >= SRT_HIGH_LATENCY_WARN_MS ||
                        (previousRelaySample.latencyMs !== null &&
                            currentRelaySample.latencyMs >=
                                previousRelaySample.latencyMs * 1.5 + 100))
                ) {
                    alerts.push({
                        severity: 'warning',
                        code: 'srt-latency-spike',
                        message: `SRT latency is high (${Math.round(currentRelaySample.latencyMs)} ms).`,
                        sinceMs: now,
                    });
                }
                if (
                    currentRelaySample.recvBitrateKbps !== null &&
                    previousRelaySample.recvBitrateKbps !== null &&
                    previousRelaySample.recvBitrateKbps >= 500 &&
                    currentRelaySample.recvBitrateKbps <= previousRelaySample.recvBitrateKbps * 0.6
                ) {
                    alerts.push({
                        severity: 'warning',
                        code: 'input-bitrate-collapse',
                        message: `Input bitrate dropped from ${formatKbps(previousRelaySample.recvBitrateKbps)} to ${formatKbps(currentRelaySample.recvBitrateKbps)}.`,
                        sinceMs: now,
                    });
                }
                if (received > 0 && forwarded === 0) {
                    alerts.push({
                        severity: 'warning',
                        code: 'relay-forwarding-stalled',
                        message: 'Relay is receiving SRT packets but forwarding no packets to SRS.',
                        sinceMs: now,
                    });
                }
            }
            let expectedLegs = relayInput.legs.length;
            if (rawBondingStatus.inputActive && relayInput.bonded) {
                const group = legGroups.get(pipeline.id) ?? { expected: 0, shortSinceMs: null };
                group.expected = Math.max(group.expected, relayInput.legs.length);
                if (relayInput.legs.length < group.expected) group.shortSinceMs ??= now;
                else group.shortSinceMs = null;
                legGroups.set(pipeline.id, group);
                noteLegChanges(pipeline.id, relayInput.legs, now);
                expectedLegs = group.expected;
                if (group.shortSinceMs !== null) {
                    const down = group.expected - relayInput.legs.length;
                    alerts.push({
                        severity: 'warning',
                        code: 'bonded-leg-down',
                        message: `${down} of ${group.expected} bonded legs ${down === 1 ? 'is' : 'are'} down.`,
                        sinceMs: group.shortSinceMs,
                    });
                }
            } else {
                legGroups.delete(pipeline.id);
                legLogs.delete(pipeline.id);
            }
            const previousLegs = legPacketSamples.get(pipeline.id) ?? new Map();
            const currentLegs = new Map<
                string,
                {
                    state: SrtRelayLegState;
                    packets: number | null;
                    noFlowSinceMs: number | null;
                    recvLossTotal: number | null;
                    recvDropTotal: number | null;
                    retransTotal: number | null;
                    belatedTotal: number | null;
                }
            >();
            const legHealth = new Map<
                string,
                { health: 'ok' | 'warn' | 'error'; reason: string | null }
            >();
            // A plain input is one link with no redundancy: same health rules,
            // but it is the whole connection rather than one leg of a group.
            const linkNoun = relayInput.bonded ? 'Leg' : 'Connection';
            const linkAlertPrefix = (transportKey: string): string =>
                relayInput.bonded ? `Bonded leg ${transportKey}` : `SRT input from ${transportKey}`;
            const runningLegs = relayInput.legs.filter((leg) => leg.state === 'running').length;
            for (const leg of relayInput.legs) {
                const key = leg.ip;
                const transportKey = `${leg.ip}:${leg.port}`;
                const otherLegRunning = runningLegs > (leg.state === 'running' ? 1 : 0);
                const packets = leg.recvUniquePacketsTotal ?? leg.recvPacketsTotal;
                const previousLeg = previousLegs.get(key);
                const noFlowSinceMs =
                    leg.state === 'running' &&
                    previousLeg &&
                    packets !== null &&
                    previousLeg.packets === packets
                        ? (previousLeg.noFlowSinceMs ?? now)
                        : null;
                currentLegs.set(key, {
                    state: leg.state,
                    packets,
                    noFlowSinceMs,
                    recvLossTotal: leg.recvLossTotal,
                    recvDropTotal: leg.recvDropTotal,
                    retransTotal: leg.retransTotal,
                    belatedTotal: leg.belatedTotal,
                });
                let health: 'ok' | 'warn' | 'error' = 'ok';
                let reason: string | null = null;
                if (leg.state === 'unknown') {
                    health = 'error';
                    reason = `${linkNoun} state is ${leg.state}.`;
                } else if (leg.state === 'idle' && otherLegRunning) {
                    // The standby of a main/backup group: idle by design while the main
                    // leg carries the stream, and it takes over if that leg fails.
                } else if (leg.state === 'pending' || leg.state === 'idle') {
                    health = 'warn';
                    reason = `${linkNoun} is ${leg.state}.`;
                }
                if (noFlowSinceMs !== null && now - noFlowSinceMs >= 10_000) {
                    health = health === 'error' ? health : 'warn';
                    reason = `${linkNoun} is connected but has stopped delivering packets.`;
                    alerts.push({
                        severity: 'warning',
                        code: 'bonded-leg-no-flow',
                        message: `${linkAlertPrefix(transportKey)} is connected but has stopped delivering packets.`,
                        sinceMs: noFlowSinceMs,
                    });
                }
                legHealth.set(transportKey, { health, reason });
                if (previousLeg && previousLeg.state !== leg.state) {
                    diagnostics?.event('bonded-leg-transition', {
                        pipelineId: pipeline.id,
                        leg: transportKey,
                        bonded: relayInput.bonded,
                        from: previousLeg.state,
                        to: leg.state,
                        health,
                        reason,
                    });
                }
            }
            legPacketSamples.set(pipeline.id, currentLegs);
            const pipelineLegHistory =
                legHistory.get(pipeline.id) ?? new Map<string, LegHistorySeries>();
            for (const leg of relayInput.legs) {
                const key = leg.ip;
                const transportKey = `${leg.ip}:${leg.port}`;
                const previousLeg = previousLegs.get(key);
                const packets = leg.recvUniquePacketsTotal ?? leg.recvPacketsTotal;
                const receivedDelta = counterDelta(packets, previousLeg?.packets);
                const lossDelta = counterDelta(leg.recvLossTotal, previousLeg?.recvLossTotal);
                const dropDelta = counterDelta(leg.recvDropTotal, previousLeg?.recvDropTotal);
                const retransDelta = counterDelta(leg.retransTotal, previousLeg?.retransTotal);
                const belatedDelta = counterDelta(leg.belatedTotal, previousLeg?.belatedTotal);
                const series = pipelineLegHistory.get(key) ?? {
                    ip: leg.ip,
                    port: leg.port,
                    samples: [],
                };
                series.port = leg.port;
                const sample: LegHistorySample = {
                    ts: now,
                    state: leg.state,
                    health: legHealth.get(transportKey)?.health ?? 'ok',
                    recvRateMbps: leg.recvRateMbps,
                    rttMs: leg.rttMs,
                    latencyMs: leg.latencyMs,
                    lossPct:
                        receivedDelta && lossDelta !== null
                            ? (lossDelta / receivedDelta) * 100
                            : null,
                    dropPct:
                        receivedDelta && dropDelta !== null
                            ? (dropDelta / receivedDelta) * 100
                            : null,
                    retransmissionPct:
                        receivedDelta && retransDelta !== null
                            ? (retransDelta / receivedDelta) * 100
                            : null,
                    belated: belatedDelta,
                    receivedPackets: receivedDelta,
                    lossPackets: lossDelta,
                    dropPackets: dropDelta,
                    lossTotal: leg.recvLossTotal,
                    dropTotal: leg.recvDropTotal,
                    retransmittedPackets: retransDelta,
                };
                series.samples.push(sample);
                const windowSamples = series.samples.filter(
                    (historySample) => historySample.ts >= now - LEG_HEALTH_WINDOW_MS,
                );
                const receivedPackets = windowSamples.reduce(
                    (total, historySample) => total + (historySample.receivedPackets ?? 0),
                    0,
                );
                const lossPackets = windowSamples.reduce(
                    (total, historySample) => total + (historySample.lossPackets ?? 0),
                    0,
                );
                const dropPackets = windowSamples.reduce(
                    (total, historySample) => total + (historySample.dropPackets ?? 0),
                    0,
                );
                const retransmittedPackets = windowSamples.reduce(
                    (total, historySample) => total + (historySample.retransmittedPackets ?? 0),
                    0,
                );
                const lossPct = receivedPackets > 0 ? (lossPackets / receivedPackets) * 100 : 0;
                const dropPct = receivedPackets > 0 ? (dropPackets / receivedPackets) * 100 : 0;
                const retransmissionPct =
                    receivedPackets > 0 ? (retransmittedPackets / receivedPackets) * 100 : 0;
                let health = legHealth.get(transportKey)?.health ?? 'ok';
                let reason = legHealth.get(transportKey)?.reason ?? null;
                if (receivedPackets >= 100 && (dropPct >= 5 || dropPackets >= 1000)) {
                    health = 'error';
                    reason = `${linkNoun} packet drops are ${dropPct.toFixed(1)}% over the last minute (${dropPackets} packets).`;
                } else if (
                    receivedPackets >= 100 &&
                    (dropPct >= 1 || lossPct >= 1 || dropPackets >= 100 || lossPackets >= 100)
                ) {
                    health = health === 'error' ? health : 'warn';
                    reason = `${linkNoun} packet quality is degraded over the last minute (${lossPct.toFixed(1)}% loss, ${dropPct.toFixed(1)}% drop).`;
                } else if (receivedPackets >= 100 && retransmissionPct >= 5) {
                    health = health === 'error' ? health : 'warn';
                    reason = `${linkNoun} retransmissions are ${retransmissionPct.toFixed(1)}% over the last minute.`;
                }
                if (leg.latencyMs !== null && leg.latencyMs >= SRT_HIGH_LATENCY_WARN_MS) {
                    health = health === 'error' ? health : 'warn';
                    reason = `${linkNoun} latency is high (${Math.round(leg.latencyMs)} ms).`;
                }
                sample.health = health;
                legHealth.set(transportKey, { health, reason });
                if (health !== 'ok' && reason) {
                    alerts.push({
                        severity: health === 'error' ? 'error' : 'warning',
                        code: 'bonded-leg-quality',
                        message: `${linkAlertPrefix(transportKey)}: ${reason}`,
                        sinceMs: windowSamples[0]?.ts ?? now,
                    });
                }
                if (series.samples.length > LEG_HISTORY_MAX_SAMPLES) series.samples.shift();
                pipelineLegHistory.set(key, series);
            }
            // Cellular legs change IP often; a leg that has been gone longer than
            // the history covers would otherwise be kept for good.
            for (const [key, series] of pipelineLegHistory) {
                const lastTs = series.samples.at(-1)?.ts ?? 0;
                if (now - lastTs > LEG_HISTORY_MAX_SAMPLES * POLL_INTERVAL_MS) {
                    pipelineLegHistory.delete(key);
                }
            }
            legHistory.set(pipeline.id, pipelineLegHistory);
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
                        ? ((ffprobeInFlight.has(pipeline.id)
                              ? ffprobeStartedAt.get(pipeline.id)
                              : mediaProbe?.startedAt) ?? null)
                        : null,
                    mediaCheckedAt: displayConnected ? (mediaProbe?.checkedAt ?? null) : null,
                    mediaError: displayConnected ? displayMediaError : null,
                    keyframes: displayConnected ? keyframes : null,
                    recvBitrateKbps: s?.kbps?.recv_30s ?? null,
                    sendBitrateKbps: s?.kbps?.send_30s ?? null,
                    readers: s ? Math.max(0, (s.clients ?? 0) - 1) : 0,
                    uptimeMs: displayLive
                        ? Date.now() - (inputLiveStartMs.get(pipeline.id) ?? Date.now())
                        : null,
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
            hostAlerts: openHostAlerts(),
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
            const series = [...(legHistory.get(pipelineId)?.values() ?? [])].map((leg) => ({
                ...leg,
                samples: leg.samples.filter(
                    (sample) =>
                        sample.ts >= from &&
                        sample.ts <= to &&
                        (after === null || sample.ts > after),
                ),
            }));
            const allSamples = [...(legHistory.get(pipelineId)?.values() ?? [])].flatMap(
                (leg) => leg.samples,
            );
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
        stopped = true;
        for (const timer of ffprobeTimers.values()) {
            clearTimeout(timer);
        }
        ffprobeTimers.clear();
        ffprobeInFlight.clear();
        ffprobeStartedAt.clear();
        for (const child of ffprobeChildren.values()) {
            if (child.exitCode == null && child.signalCode == null) {
                child.kill('SIGKILL');
            }
        }
        ffprobeChildren.clear();
        for (const child of keyframeChildren.values()) {
            if (child.exitCode == null && child.signalCode == null) {
                child.kill('SIGKILL');
            }
        }
        keyframeChildren.clear();
        keyframeScheduled.clear();
        keyframeQueue.length = 0;
    }

    return {
        start,
        registerRoutes,
        shutdown,
        getSrsEvents: (): SrsEvent[] => [...srsEvents],
    };
}

export type HealthService = ReturnType<typeof createHealthService>;
