import type { SrtRelayInputStatus, SrtRelayLegState } from './srtRelay.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';
import {
    allowLegLogLine,
    createLegLogState,
    describeLegChange,
    suppressedLegLinesMessage,
    takeSuppressedLegLines,
    type LegLogState,
} from '../utils/legLog.js';
import {
    counterDelta,
    legQualityHealth,
    type LegHealth,
    type PipelineAlert,
} from '../utils/srtLinkAlerts.js';

// What the health poll keeps about each pipeline's SRT input links between polls:
// the legs a bonded group has had (the relay drops a failed leg instead of reporting
// it broken), which links stopped delivering packets, each link's health, and the
// per-link history behind the SRT details chart. One `observe` per poll per pipeline.

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

export interface LegObservation {
    // Legs the group has had (the group's size for a bonded input, else what the relay lists).
    expectedLegs: number;
    // Health by `ip:port`.
    legHealth: Map<string, LegHealth>;
    // bonded-leg-down, then bonded-leg-no-flow and bonded-leg-quality per leg.
    alerts: PipelineAlert[];
}

interface LegSample {
    state: SrtRelayLegState;
    packets: number | null;
    noFlowSinceMs: number | null;
    recvLossTotal: number | null;
    recvDropTotal: number | null;
    retransTotal: number | null;
    belatedTotal: number | null;
}

export interface LegTrackerOptions {
    // The length of the history kept per pipeline, in samples, and the poll spacing.
    historyMaxSamples: number;
    pollIntervalMs: number;
    // The window the one-minute quality thresholds look at.
    healthWindowMs: number;
    appendPipelineLog: (pipelineId: number, event: string, message: string) => void;
    diagnostics?: DiagnosticsLogger;
}

// A leg with unchanged packet counts for this long has stopped delivering.
const NO_FLOW_ALERT_MS = 10_000;

export function createLegTracker(options: LegTrackerOptions) {
    const { historyMaxSamples, pollIntervalMs, healthWindowMs, diagnostics } = options;
    const samples = new Map<number, Map<string, LegSample>>();
    const history = new Map<number, Map<string, LegHistorySeries>>();
    // The relay drops a failed leg from its legs[] instead of reporting it broken,
    // so a lost leg shows only as a smaller count than the group has had. Keyed by
    // pipeline; reset when the input goes away.
    const groups = new Map<number, { expected: number; shortSinceMs: number | null }>();
    // Which legs (ip:port) a bonded input had at the last poll, for the pipeline log and
    // the diagnostics. Keyed by pipeline; reset when the input goes away. See utils/legLog.ts.
    const logs = new Map<number, LegLogState>();

    const appendLine = (pipelineId: number, event: string, message: string): void => {
        try {
            options.appendPipelineLog(pipelineId, event, message);
        } catch {
            /* non-critical */
        }
    };

    const noteLegChanges = (
        pipelineId: number,
        legs: { ip: string; port: number }[],
        now: number,
    ): void => {
        const keys = legs.map((leg) => `${leg.ip}:${leg.port}`);
        const state = logs.get(pipelineId);
        const change = describeLegChange(state?.keys ?? null, keys);
        const current = state ?? createLegLogState(keys, now);
        current.keys = keys;
        logs.set(pipelineId, current);
        const hidden = takeSuppressedLegLines(current, now);
        if (hidden > 0) appendLine(pipelineId, 'legs', suppressedLegLinesMessage(hidden));
        if (!change) return;
        diagnostics?.event('bonded-legs-changed', {
            pipelineId,
            from: change.from,
            to: change.to,
            joined: change.joined,
            left: change.left,
            legs: keys,
        });
        if (allowLegLogLine(current, now)) appendLine(pipelineId, 'legs', change.message);
    };

    return {
        observe(
            pipelineId: number,
            input: SrtRelayInputStatus,
            inputActive: boolean,
            now: number,
        ): LegObservation {
            const alerts: PipelineAlert[] = [];
            let expectedLegs = input.legs.length;
            if (inputActive && input.bonded) {
                const group = groups.get(pipelineId) ?? { expected: 0, shortSinceMs: null };
                group.expected = Math.max(group.expected, input.legs.length);
                if (input.legs.length < group.expected) group.shortSinceMs ??= now;
                else group.shortSinceMs = null;
                groups.set(pipelineId, group);
                noteLegChanges(pipelineId, input.legs, now);
                expectedLegs = group.expected;
                if (group.shortSinceMs !== null) {
                    const down = group.expected - input.legs.length;
                    alerts.push({
                        severity: 'warning',
                        code: 'bonded-leg-down',
                        message: `${down} of ${group.expected} bonded legs ${down === 1 ? 'is' : 'are'} down.`,
                        sinceMs: group.shortSinceMs,
                    });
                }
            } else {
                groups.delete(pipelineId);
                logs.delete(pipelineId);
            }
            const previousLegs = samples.get(pipelineId) ?? new Map<string, LegSample>();
            const currentLegs = new Map<string, LegSample>();
            const legHealth = new Map<string, LegHealth>();
            // A plain input is one link with no redundancy: same health rules,
            // but it is the whole connection rather than one leg of a group.
            const linkNoun = input.bonded ? 'Leg' : 'Connection';
            const linkAlertPrefix = (transportKey: string): string =>
                input.bonded ? `Bonded leg ${transportKey}` : `SRT input from ${transportKey}`;
            const runningLegs = input.legs.filter((leg) => leg.state === 'running').length;
            for (const leg of input.legs) {
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
                let health: LegHealth['health'] = 'ok';
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
                if (noFlowSinceMs !== null && now - noFlowSinceMs >= NO_FLOW_ALERT_MS) {
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
                        pipelineId,
                        leg: transportKey,
                        bonded: input.bonded,
                        from: previousLeg.state,
                        to: leg.state,
                        health,
                        reason,
                    });
                }
            }
            samples.set(pipelineId, currentLegs);
            const pipelineLegHistory =
                history.get(pipelineId) ?? new Map<string, LegHistorySeries>();
            for (const leg of input.legs) {
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
                    (historySample) => historySample.ts >= now - healthWindowMs,
                );
                const sum = (
                    field:
                        | 'receivedPackets'
                        | 'lossPackets'
                        | 'dropPackets'
                        | 'retransmittedPackets',
                ): number =>
                    windowSamples.reduce(
                        (total, historySample) => total + (historySample[field] ?? 0),
                        0,
                    );
                const { health, reason } = legQualityHealth(
                    {
                        receivedPackets: sum('receivedPackets'),
                        lossPackets: sum('lossPackets'),
                        dropPackets: sum('dropPackets'),
                        retransmittedPackets: sum('retransmittedPackets'),
                    },
                    leg.latencyMs,
                    linkNoun,
                    legHealth.get(transportKey) ?? { health: 'ok', reason: null },
                );
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
                if (series.samples.length > historyMaxSamples) series.samples.shift();
                pipelineLegHistory.set(key, series);
            }
            // Cellular legs change IP often; a leg that has been gone longer than
            // the history covers would otherwise be kept for good.
            for (const [key, series] of pipelineLegHistory) {
                const lastTs = series.samples.at(-1)?.ts ?? 0;
                if (now - lastTs > historyMaxSamples * pollIntervalMs) {
                    pipelineLegHistory.delete(key);
                }
            }
            history.set(pipelineId, pipelineLegHistory);
            return { expectedLegs, legHealth, alerts };
        },

        // The per-link history of a pipeline, for the SRT details chart.
        history(pipelineId: number): LegHistorySeries[] {
            return [...(history.get(pipelineId)?.values() ?? [])];
        },

        // Forget the pipelines that no longer exist.
        keepOnly(activePipelineIds: Set<number>): void {
            for (const map of [samples, history, groups, logs] as Map<number, unknown>[]) {
                for (const pipelineId of map.keys()) {
                    if (!activePipelineIds.has(pipelineId)) map.delete(pipelineId);
                }
            }
        },
    };
}

export type LegTracker = ReturnType<typeof createLegTracker>;
