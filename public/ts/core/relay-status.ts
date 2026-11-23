import { alertHint } from './hints.js';
import { INPUT_ALERT_CODES } from './pipeline.js';
import { summarizeOutputError, type OutStatus, type StatusIssue } from './status.js';
import { STATUS_COLOR_ERROR, STATUS_COLOR_GOOD, STATUS_COLOR_WARN } from './utils.js';
import type { PipelineView, SrtBondingLeg } from '../types.js';

// The verdict on a pipeline's relay (Goryu) path: its two halves, and the
// problems behind each. `input` is the SRT link from the encoder, `output` is
// the relay's forward into SRS. A pure function of what the server reported and
// of the time it is asked at, like core/status.ts, so the Overview, the pipeline
// list and the Relay card say the same thing.

// How long a relay without a packet still counts as flowing.
const RELAY_FLOW_STALE_MS = 15000;

// A relay problem and the half of the status dot it belongs to. `prefix` names the
// side where the problem is listed without a heading, as in the Overview.
export interface RelayIssue {
    side: 'input' | 'output';
    prefix: string;
    issue: StatusIssue;
}

export interface RelayHealth {
    input: OutStatus;
    output: OutStatus;
    issues: RelayIssue[];
}

// An alert raises the half it is about to its own severity: the SRT interval alerts (dropped
// packets, loss, retransmissions, latency, a bitrate collapse) and a leg's alerts are about
// the link from the encoder, a relay that receives but forwards nothing is about the
// forward to SRS. The server holds an interval alert for 30 s, so the status does not blink.
const alertStatus = (severity: StatusIssue['severity']): OutStatus =>
    severity === 'error' ? 'error' : 'warn';
const worseOf = (a: OutStatus, b: OutStatus): OutStatus =>
    a === 'error' || b === 'error' ? 'error' : a === 'warn' || b === 'warn' ? 'warn' : a;

export function relayHealth(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
    nowMs: number,
): RelayHealth {
    // What the relay's own state says; the alerts below can only raise it, and the reasons
    // listed under it are the ones behind this state, not behind the alerts.
    const baseInput = inputStatus(pipeline, relayProcessRunning, nowMs);
    const baseOutput = outputStatus(pipeline, relayProcessRunning, nowMs);
    let input = baseInput;
    let output = baseOutput;
    const issues: RelayIssue[] = [];
    for (const alert of pipeline.alerts) {
        // The leg-specific version below includes the address and the precise
        // reason, so avoid showing per-leg alerts twice in the combined list.
        if (alert.code === 'bonded-leg-no-flow' || alert.code === 'bonded-leg-quality') {
            continue;
        }
        // Input alerts are shown with the input (see the input's verdict).
        if (INPUT_ALERT_CODES.has(alert.code)) continue;
        const side = alert.code === 'relay-forwarding-stalled' ? 'output' : 'input';
        // An alert only exists while the relay is up and the input is active, so a half
        // that is off stays off.
        if (side === 'output') {
            if (output !== 'off') output = worseOf(output, alertStatus(alert.severity));
        } else if (input !== 'off') {
            input = worseOf(input, alertStatus(alert.severity));
        }
        issues.push({
            side,
            prefix: '',
            issue: {
                severity: alert.severity,
                message: alert.message,
                hint: alertHint(alert.code) ?? undefined,
                sinceMs: alert.sinceMs,
            },
        });
    }
    if (baseInput === 'warn' || baseInput === 'error') {
        // A bonded group's legs down are already an alert with its own "since": say it once.
        const legsAlerted = pipeline.alerts.some((a) => a.code === 'bonded-leg-down');
        for (const reason of inputReasons(pipeline, relayProcessRunning, nowMs, legsAlerted)) {
            issues.push({
                side: 'input',
                prefix: 'Input: ',
                issue: { severity: baseInput === 'error' ? 'error' : 'warning', message: reason },
            });
        }
    }
    if (baseOutput === 'warn' || baseOutput === 'error') {
        for (const reason of outputReasons(pipeline, relayProcessRunning, nowMs)) {
            issues.push({
                side: 'output',
                prefix: 'Output: ',
                issue: {
                    severity: baseOutput === 'error' ? 'error' : 'warning',
                    message: summarizeOutputError(reason, reason),
                },
            });
        }
    }
    return { input, output, issues };
}

// Every relay problem in one list, each reason tagged with its side ("Input: …").
export function relayIssueList(health: RelayHealth): StatusIssue[] {
    return health.issues.map(({ prefix, issue }) =>
        prefix ? { ...issue, message: `${prefix}${issue.message}` } : issue,
    );
}

export function legHealthColor(leg: SrtBondingLeg): string {
    if (leg.health === 'error') return STATUS_COLOR_ERROR;
    if (leg.health === 'warn') return STATUS_COLOR_WARN;
    return STATUS_COLOR_GOOD;
}

export function legHealthLabel(leg: SrtBondingLeg): string {
    return (leg.health ?? (leg.state === 'running' ? 'ok' : 'warn')).toUpperCase();
}

function hasRecentFlow(lastPacketAt: number | null, nowMs: number): boolean {
    return lastPacketAt != null && nowMs - lastPacketAt <= RELAY_FLOW_STALE_MS;
}

// A failed leg leaves the relay's legs[] instead of being reported as broken, so
// legs that are down are the ones the group had (`expectedLegs`) and no longer has.
function downLegCount(pipeline: PipelineView): number {
    const { bonded, legs, expectedLegs } = pipeline.srtBonding.input;
    return bonded ? Math.max(0, expectedLegs - legs.length) : 0;
}

function inputStatus(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
    nowMs: number,
): OutStatus {
    if (!relayProcessRunning) return 'off';
    if (!pipeline.srtBonding.inputActive) return 'off';
    if (pipeline.srtBonding.input.legs.some((leg) => leg.health === 'error')) return 'error';
    if (pipeline.srtBonding.input.legs.some((leg) => leg.health === 'warn')) return 'warn';
    const { bonded, legs, expectedLegs } = pipeline.srtBonding.input;
    // A bonded group that had legs and has none left is a total input failure,
    // worse than reduced redundancy.
    if (bonded && legs.length === 0 && expectedLegs > 0) return 'error';
    if (!hasRecentFlow(pipeline.srtBonding.lastInputPacketAt, nowMs)) return 'warn';
    // A plain input has no redundancy by design. A bonded group has it only while
    // it has two or more legs, and a leg that dropped out is redundancy lost.
    if (bonded && legs.length < Math.max(2, expectedLegs)) return 'warn';
    return 'good';
}

function outputStatus(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
    nowMs: number,
): OutStatus {
    if (!relayProcessRunning) return 'off';
    if (!pipeline.srtBonding.inputActive) return 'off';
    if (pipeline.srtBonding.publishConflict) return 'error';
    if (!pipeline.srtBonding.outputConnected) return 'error';
    if (!pipeline.srtBonding.acceptedBySrs) return 'warn';
    return hasRecentFlow(pipeline.srtBonding.lastPacketAt, nowMs) ? 'good' : 'warn';
}

// Every independent problem on the input (upstream encoder → relay) side,
// collected rather than short-circuited on the first match — a leg outage and
// a stalled feed are unrelated causes and both deserve to show up in the
// tooltip instead of one hiding the other.
function inputReasons(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
    nowMs: number,
    legsDownAlerted: boolean,
): string[] {
    if (!relayProcessRunning || !pipeline.srtBonding.inputActive) return [];
    const { bonded, legs, expectedLegs } = pipeline.srtBonding.input;
    const down = downLegCount(pipeline);
    const reasons: string[] = [];

    for (const leg of legs) {
        if (leg.health && leg.health !== 'ok' && leg.healthReason) {
            reasons.push(`${bonded ? 'Leg ' : 'Input '}${leg.ip}: ${leg.healthReason}`);
        }
    }

    if (bonded) {
        if (legs.length === 0) reasons.push('No bonded legs reporting');
        else if (down > 0) {
            if (!legsDownAlerted) reasons.push(`${down} of ${expectedLegs} bonded legs down`);
        } else if (legs.length === 1) reasons.push('Only 1 leg connected — no redundancy');
    }

    if (!hasRecentFlow(pipeline.srtBonding.lastInputPacketAt, nowMs)) {
        reasons.push('No input packets received recently');
    }

    return reasons;
}

// Same collect-don't-shortcircuit approach for the output (relay → SRS) side.
function outputReasons(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
    nowMs: number,
): string[] {
    if (!relayProcessRunning || !pipeline.srtBonding.inputActive) return [];
    const { srtBonding } = pipeline;
    const reasons: string[] = [];

    if (srtBonding.publishConflict) {
        reasons.push(
            srtBonding.localSrtPublisherConflict
                ? 'A local pipeline output is already publishing to this stream key in SRS'
                : 'SRS is already using another publisher for this stream key',
        );
    }

    if (!srtBonding.outputConnected) {
        reasons.push(
            srtBonding.lastError
                ? `Relay output reconnecting: ${srtBonding.lastError}`
                : srtBonding.retryFailures > 0
                  ? `Relay output reconnecting (${srtBonding.retryFailures} retries)`
                  : 'Relay output reconnecting',
        );
    } else {
        if (!srtBonding.acceptedBySrs) {
            reasons.push('SRS has not reported this as the active pipeline input');
        }
        if (!hasRecentFlow(srtBonding.lastPacketAt, nowMs)) {
            reasons.push(
                srtBonding.forwardedPackets > 0
                    ? 'Media forwarding to SRS has stalled'
                    : 'No media has been forwarded to SRS yet',
            );
        }
    }

    return reasons;
}
