import type { Db } from '../types.js';
import type { SrsStream } from '../utils/srs.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';
import { formatDuration } from '../utils/duration.js';
import { createPipelineMaps } from '../utils/pipelineMaps.js';
import type { PipelineAlert } from '../utils/srtLinkAlerts.js';
import type { OutputService } from './outputs.js';
import type { InputProtocol, InputState } from './inputState.js';
import {
    keyframeIntervalTooLong,
    keyframeSummary,
    type KeyframeStats,
    type ProbeResult,
} from './mediaProbe.js';
import type { ProbeScheduler } from './probeScheduler.js';

// What the health poll keeps about each pipeline's input between polls: whether it is
// connected and since when, which publisher is on it, how often it dropped, the
// format of the last probed publisher, and the frame counter samples behind the
// frame-rate alert. One `observe` per poll per pipeline records the transitions
// (pipeline log, diagnostics, output restarts); `alerts` then reads the same state.

// An encoder that reconnects with another codec, resolution or audio track count
// breaks the running outputs, so they are restarted. At most one such restart per
// pipeline per window, so an encoder that alternates formats cannot start a storm.
const INPUT_FORMAT_RESTART_COOLDOWN_MS = 60 * 1000;
// An input that disconnects this many times within the window is flapping (a bad
// uplink or a crashing encoder), which one "Input disconnected" line per drop in
// the pipeline log does not make obvious.
const INPUT_FLAP_WINDOW_MS = 5 * 60 * 1000;
const INPUT_FLAP_DISCONNECTS = 3;
// SRS adds RTMP video frames to its counter in ~5 s batches (and starts
// ~20 s after the connect), so a window's rate is off by up to one batch at each
// end: ±5 s / window, about ±4 % over 2 minutes. The ±10 % band sits clear of
// that; a real encoder drops or bursts frames by far more.
const INPUT_FPS_WINDOW_MS = 2 * 60 * 1000;
const INPUT_FPS_TOLERANCE = 0.1;
// How long "SRT publisher reconnected" stays an alert after the publisher changed.
const PUBLISHER_RECONNECTED_ALERT_MS = 30_000;

// The part of a probe that running outputs depend on, as one comparable string.
function inputFormatOf(result: ProbeResult): string {
    const video = result.video
        ? `${result.video.codec} ${result.video.width}x${result.video.height}`
        : 'no video';
    const n = result.audioTracks.length;
    return `${video}, ${n} audio track${n === 1 ? '' : 's'}`;
}

export interface InputLifecycleDeps {
    db: Pick<Db, 'appendPipelineLog'>;
    outputService: Pick<OutputService, 'restartPipelineOutputs' | 'restartRunningOutputs'>;
    inputState: InputState;
    probes: Pick<ProbeScheduler, 'ensure' | 'clear'>;
    diagnostics?: DiagnosticsLogger;
}

// Launch and restart spacing shared by all the pipelines of one poll: each `observe`
// that starts an ffprobe or restarts outputs moves the next one later.
export interface PollStaggers {
    ffprobe: number;
    restart: number;
}

export interface InputObservation {
    // What the dashboard shows: false while SRS is unreachable, even though the
    // lifecycle keeps its last known state for restart and logging decisions.
    live: boolean;
    connected: boolean;
    isSrt: boolean;
}

export interface InputAlertSources {
    // The stream whose RTMP frame counter to measure; none for SRT or no live input.
    fpsStream: SrsStream | undefined;
    // The frame rate ffprobe reports for the publisher.
    nominalFps: number | null;
    connected: boolean;
    keyframes: (KeyframeStats & { checkedAt: number }) | null;
}

export function createInputLifecycle({
    db,
    outputService,
    inputState,
    probes,
    diagnostics,
}: InputLifecycleDeps) {
    const pipelineMaps = createPipelineMaps();
    const connected = pipelineMaps.map<boolean>();
    const liveStartMs = pipelineMaps.map<number>();
    const publisherCid = pipelineMaps.map<string>();
    const publisherChangedAt = pipelineMaps.map<number>();
    // The format of each pipeline's last successfully probed input, kept across
    // reconnects so a different one on the next publisher is noticed.
    const formats = pipelineMaps.map<string>();
    const lastFormatRestartAt = pipelineMaps.map<number>();
    // When each pipeline's input disconnected, within INPUT_FLAP_WINDOW_MS.
    const disconnectsAt = pipelineMaps.map<number[]>();
    // Per-pipeline RTMP video-frame counter samples, one per poll, covering
    // the last INPUT_FPS_WINDOW_MS.
    const frameSamples = pipelineMaps.map<{
        cid: string | undefined;
        points: { at: number; frames: number }[];
    }>();

    // Frame rate over the last full window, or null while the window is not
    // full (new publisher, counter reset, SRS not counting yet).
    function measureFps(
        pipelineId: number,
        stream: SrsStream | undefined,
        now: number,
    ): number | null {
        const frames = stream?.frames ?? 0;
        if (!stream || !frames) {
            frameSamples.delete(pipelineId);
            return null;
        }
        const cid = stream.publish?.cid;
        let entry = frameSamples.get(pipelineId);
        const last = entry?.points.at(-1);
        if (!entry || entry.cid !== cid || (last && frames < last.frames)) {
            entry = { cid, points: [] };
            frameSamples.set(pipelineId, entry);
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

    return {
        // Records this poll's view of a pipeline's input. `stream` is its live SRS
        // stream, none when it is not publishing or SRS is unreachable (then the
        // last known state stands, so an API failure is not a mass disconnect).
        observe(
            pipeline: { id: number; streamKey: string },
            stream: SrsStream | undefined,
            srsReachable: boolean,
            staggers: PollStaggers,
        ): InputObservation {
            const id = pipeline.id;
            const prevConnected = connected.get(id) ?? false;
            const prevLive = inputState.isLive(id);
            const nowConnected = srsReachable ? !!stream : prevConnected;
            const isSrt = !!stream?.tcUrl?.startsWith('srt://');
            const prevPublisherCid = publisherCid.get(id) ?? null;
            const nowPublisherCid = stream?.publish?.cid ?? null;
            const publisherChanged =
                nowConnected &&
                nowPublisherCid !== null &&
                prevPublisherCid !== null &&
                nowPublisherCid !== prevPublisherCid;
            if (publisherChanged) {
                probes.clear(id);
                publisherChangedAt.set(id, Date.now());
                diagnostics?.event('input-publisher-transition', {
                    pipelineId: id,
                    fromCid: prevPublisherCid,
                    toCid: nowPublisherCid,
                    protocol: isSrt ? 'srt' : 'rtmp',
                });
            }
            const nowProtocol: InputProtocol | null = nowConnected
                ? isSrt
                    ? 'srt'
                    : 'rtmp'
                : null;
            const nowLive = srsReachable ? nowConnected : prevLive;
            // The dashboard reflects whether the input is currently usable through SRS.
            // nowLive stays sticky internally during an SRS outage, but a stale green
            // input is not presented while SRS is down.
            const observation = {
                live: srsReachable ? nowLive : false,
                connected: srsReachable ? nowConnected : false,
                isSrt,
            };
            if (!srsReachable) return observation;

            connected.set(id, nowConnected);
            if (nowConnected && stream) {
                if (nowPublisherCid) publisherCid.set(id, nowPublisherCid);
                inputState.setPipelineState(id, nowLive, nowProtocol);
                if (nowProtocol) {
                    probes.ensure(id, pipeline.streamKey, nowProtocol, staggers.ffprobe++);
                }
            } else if (!nowConnected) {
                inputState.clearPipeline(id);
            }

            if (!prevLive && nowLive) {
                liveStartMs.set(id, Date.now());
                staggers.restart += outputService.restartPipelineOutputs(id, staggers.restart);
                try {
                    db.appendPipelineLog(
                        id,
                        'online',
                        `Input media detected (${inputState.getProtocol(id) ?? 'unknown'})`,
                    );
                } catch {
                    /* non-critical */
                }
                diagnostics?.event('input-transition', {
                    pipelineId: id,
                    from: prevLive ? 'live' : 'offline',
                    to: 'live',
                    protocol: inputState.getProtocol(id),
                });
            }

            if (prevConnected && !nowConnected) {
                const startMs = liveStartMs.get(id);
                const uptimeSec =
                    startMs != null ? Math.round((Date.now() - startMs) / 1000) : null;
                disconnectsAt.set(id, [...(disconnectsAt.get(id) ?? []), Date.now()]);
                connected.delete(id);
                publisherCid.delete(id);
                inputState.clearPipeline(id);
                liveStartMs.delete(id);
                probes.clear(id);
                try {
                    db.appendPipelineLog(
                        id,
                        'offline',
                        uptimeSec == null
                            ? 'Input disconnected'
                            : `Input disconnected (was live for ${formatDuration(uptimeSec * 1000)})`,
                    );
                } catch {
                    /* non-critical */
                }
                diagnostics?.event('input-transition', {
                    pipelineId: id,
                    from: 'connected',
                    to: 'disconnected',
                    uptimeSec,
                });
            }
            return observation;
        },

        // The input's own alerts for this poll: a frame rate off the probed one, keyframes
        // too far apart, an input that keeps disconnecting, a publisher that just changed.
        alerts(pipelineId: number, sources: InputAlertSources, now: number): PipelineAlert[] {
            const alerts: PipelineAlert[] = [];
            const inputFps = measureFps(pipelineId, sources.fpsStream, now);
            const { nominalFps, keyframes } = sources;
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
            if (sources.connected && keyframes && keyframeIntervalTooLong(keyframes)) {
                alerts.push({
                    severity: 'warning',
                    code: 'input-keyframe-interval',
                    message: `Input keyframes are too far apart: ${keyframeSummary(keyframes)}`,
                    sinceMs: keyframes.checkedAt,
                });
            }
            const recentDisconnects = (disconnectsAt.get(pipelineId) ?? []).filter(
                (at) => now - at <= INPUT_FLAP_WINDOW_MS,
            );
            if (recentDisconnects.length > 0) disconnectsAt.set(pipelineId, recentDisconnects);
            else disconnectsAt.delete(pipelineId);
            if (recentDisconnects.length >= INPUT_FLAP_DISCONNECTS) {
                alerts.push({
                    severity: 'warning',
                    code: 'input-flapping',
                    message: `Input disconnected ${recentDisconnects.length} times in the last 5 minutes.`,
                    sinceMs: recentDisconnects[0],
                });
            }
            const changedAt = publisherChangedAt.get(pipelineId);
            if (changedAt && now - changedAt <= PUBLISHER_RECONNECTED_ALERT_MS) {
                alerts.push({
                    severity: 'warning',
                    code: 'publisher-reconnected',
                    message: 'SRT publisher reconnected; input timing may be recovering.',
                    sinceMs: changedAt,
                });
            } else if (changedAt) {
                publisherChangedAt.delete(pipelineId);
            }
            return alerts;
        },

        // Called with every successful probe. A format that differs from the previous
        // publisher's restarts the outputs that were already running (never on a failed
        // probe, which proves nothing about the format).
        noteProbe(pipelineId: number, result: ProbeResult): void {
            const format = inputFormatOf(result);
            const previous = formats.get(pipelineId);
            formats.set(pipelineId, format);
            if (previous === undefined || previous === format) return;
            const now = Date.now();
            // Outputs that started after the new publisher connected already read the
            // new format.
            const publisherStartedAt = Math.max(
                publisherChangedAt.get(pipelineId) ?? 0,
                liveStartMs.get(pipelineId) ?? 0,
            );
            const sinceLastRestartMs = now - (lastFormatRestartAt.get(pipelineId) ?? -Infinity);
            const suppressed = sinceLastRestartMs < INPUT_FORMAT_RESTART_COOLDOWN_MS;
            const why = `input format changed from ${previous} to ${format}`;
            let restarted = 0;
            if (!suppressed && publisherStartedAt > 0) {
                lastFormatRestartAt.set(pipelineId, now);
                restarted = outputService.restartRunningOutputs(
                    pipelineId,
                    why,
                    publisherStartedAt,
                );
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
        },

        // How long the pipeline's input has been live; 0 when it is not known to be.
        uptimeMs(pipelineId: number): number {
            return Date.now() - (liveStartMs.get(pipelineId) ?? Date.now());
        },

        keepOnly: pipelineMaps.keepOnly,
    };
}

export type InputLifecycle = ReturnType<typeof createInputLifecycle>;
