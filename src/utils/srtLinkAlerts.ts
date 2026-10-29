export interface PipelineAlert {
    severity: 'warning' | 'error';
    code: string;
    message: string;
    sinceMs: number;
}

// One health interval of an SRT input, as the relay reports it: counters since the
// relay stream started (they only grow, and restart from zero when it does).
export interface RelayInputSample {
    recvLossTotal: number | null;
    recvDropTotal: number | null;
    recvUniquePacketsTotal: number;
    retransTotal: number | null;
    belatedTotal: number | null;
    latencyMs: number | null;
    recvBitrateKbps: number | null;
    forwardedPackets: number;
}

// One second is a reasonable buffering target for long-distance or bonded
// SRT, so warn only when the negotiated latency exceeds it with some margin.
// Sudden latency spikes are still reported independently below.
export const SRT_HIGH_LATENCY_WARN_MS = 1500;

// How much a counter grew since the last sample. A counter that went down was
// reset (the relay stream restarted), so its new value is the growth.
export function counterDelta(
    current: number | null,
    previous: number | null | undefined,
): number | null {
    if (current === null || previous === null || previous === undefined) return null;
    return current >= previous ? current - previous : current;
}

function formatKbps(kbps: number): string {
    return kbps >= 1000 ? `${Number((kbps / 1000).toFixed(1))} Mb/s` : `${Math.round(kbps)} kb/s`;
}

// The alerts for what an SRT input did between two health polls: packets dropped
// or lost, retransmissions, belated packets, a latency spike, a collapsing bitrate,
// and a relay that receives but forwards nothing. Pure, so every threshold can be
// tested with two samples. Call it only while the input is active.
export function srtIntervalAlerts(
    previous: RelayInputSample,
    current: RelayInputSample,
    now: number,
): PipelineAlert[] {
    const alerts: PipelineAlert[] = [];
    const dropped = counterDelta(current.recvDropTotal, previous.recvDropTotal);
    const lost = counterDelta(current.recvLossTotal, previous.recvLossTotal);
    const received = Math.max(0, current.recvUniquePacketsTotal - previous.recvUniquePacketsTotal);
    const lossRatio = received > 0 && lost !== null ? lost / received : 0;
    const retransmitted = counterDelta(current.retransTotal, previous.retransTotal);
    const forwarded = Math.max(0, current.forwardedPackets - previous.forwardedPackets);
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
        current.belatedTotal !== null && previous.belatedTotal !== null
            ? Math.max(0, current.belatedTotal - previous.belatedTotal)
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
        current.latencyMs !== null &&
        (current.latencyMs >= SRT_HIGH_LATENCY_WARN_MS ||
            (previous.latencyMs !== null && current.latencyMs >= previous.latencyMs * 1.5 + 100))
    ) {
        alerts.push({
            severity: 'warning',
            code: 'srt-latency-spike',
            message: `SRT latency is high (${Math.round(current.latencyMs)} ms).`,
            sinceMs: now,
        });
    }
    if (
        current.recvBitrateKbps !== null &&
        previous.recvBitrateKbps !== null &&
        previous.recvBitrateKbps >= 500 &&
        current.recvBitrateKbps <= previous.recvBitrateKbps * 0.6
    ) {
        alerts.push({
            severity: 'warning',
            code: 'input-bitrate-collapse',
            message: `Input bitrate dropped from ${formatKbps(previous.recvBitrateKbps)} to ${formatKbps(current.recvBitrateKbps)}.`,
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
    return alerts;
}

export interface LegHealth {
    health: 'ok' | 'warn' | 'error';
    reason: string | null;
}

// What the last minute of one SRT link (a bonded leg, or the whole connection of a
// plain input) says about its health, on top of what its state already said (`state`):
// heavy drops are an error, degraded quality or retransmissions a warning, and a
// latency above the buffering target a warning. Fewer than 100 packets prove nothing.
// `linkNoun` is "Leg" or "Connection". An error is never downgraded.
export function legQualityHealth(
    window: {
        receivedPackets: number;
        lossPackets: number;
        dropPackets: number;
        retransmittedPackets: number;
    },
    latencyMs: number | null,
    linkNoun: string,
    state: LegHealth,
): LegHealth {
    const { receivedPackets, lossPackets, dropPackets, retransmittedPackets } = window;
    const lossPct = receivedPackets > 0 ? (lossPackets / receivedPackets) * 100 : 0;
    const dropPct = receivedPackets > 0 ? (dropPackets / receivedPackets) * 100 : 0;
    const retransmissionPct =
        receivedPackets > 0 ? (retransmittedPackets / receivedPackets) * 100 : 0;
    let { health, reason } = state;
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
    if (latencyMs !== null && latencyMs >= SRT_HIGH_LATENCY_WARN_MS) {
        health = health === 'error' ? health : 'warn';
        reason = `${linkNoun} latency is high (${Math.round(latencyMs)} ms).`;
    }
    return { health, reason };
}
