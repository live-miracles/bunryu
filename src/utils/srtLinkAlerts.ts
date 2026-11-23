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

// The latency the relay reports is the one negotiated for the connection: the encoder's
// setting (the larger of the two sides'), fixed for its life, not a measured delay. SRT's
// guidance is about four times the round trip, so a long or lossy link (a satellite hop,
// a congested mobile uplink) legitimately needs two seconds or more. Warn only when it is
// so high that it is probably a mistake on the encoder, such as seconds typed for ms.
export const SRT_HIGH_LATENCY_WARN_MS = 5000;

// Belated packets are the ones that arrived after their play time. A fixed count means
// little at different bitrates (100 in an interval is 3 % at about 5 Mb/s and 20 % at 1),
// so the rule is a share of the packets received, and at least this many.
const SRT_BELATED_WARN_RATIO = 0.03;
const SRT_BELATED_MIN_PACKETS = 10;

// An interval is an error rather than a warning from this many dropped packets (or 5 % of
// those received, the leg rule below), this loss ratio, or this collapse of the bitrate.
const SRT_DROPPED_ERROR_PACKETS = 1000;
const SRT_LOSS_ERROR_RATIO = 0.1;
const BITRATE_COLLAPSE_ERROR_FRACTION = 0.2;

// How much a counter grew since the last sample. A counter that went down was
// reset (the relay stream restarted), so its new value is the growth.
export function counterDelta(
    current: number | null,
    previous: number | null | undefined,
): number | null {
    if (current === null || previous === null || previous === undefined) return null;
    return current >= previous ? current - previous : current;
}

// The counters of one SRT link (a bonded leg, a plain connection, or the whole input) at
// one poll. A counter the relay does not report for the link is null.
export interface LinkCounters {
    received: number | null;
    loss: number | null;
    drop: number | null;
    retrans: number | null;
    belated: number | null;
}

// What each counter grew by since the previous poll of the same link. Null when there is no
// previous poll or the relay does not report the counter. The one place that turns two
// polls into growth, for the interval alerts, a leg's history and its one-minute health.
export type LinkGrowth = LinkCounters;

export function linkGrowth(
    current: LinkCounters,
    previous: LinkCounters | null | undefined,
): LinkGrowth {
    return {
        received: counterDelta(current.received, previous?.received),
        loss: counterDelta(current.loss, previous?.loss),
        drop: counterDelta(current.drop, previous?.drop),
        retrans: counterDelta(current.retrans, previous?.retrans),
        belated: counterDelta(current.belated, previous?.belated),
    };
}

// A growth as a percentage of the packets received over the same span; null when nothing
// was received or the growth is unknown.
export function percentOfReceived(part: number | null, received: number | null): number | null {
    return received && part !== null ? (part / received) * 100 : null;
}

// Whether a counter went back down between two polls (the relay stream restarted), so a
// total that spans both polls would be wrong. Counters that are null in either poll say
// nothing.
export function anyCounterReset(
    previous: readonly (number | null)[],
    current: readonly (number | null)[],
): boolean {
    return current.some((value, i) => {
        const before = previous[i];
        return value !== null && before !== null && before !== undefined && value < before;
    });
}

// One decimal; a share too small for that keeps its first significant digit (0.001).
function formatPercent(percent: number): string {
    return percent < 0.1 ? String(Number(percent.toPrecision(1))) : percent.toFixed(1);
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
    const growth = linkGrowth(
        {
            received: current.recvUniquePacketsTotal,
            loss: current.recvLossTotal,
            drop: current.recvDropTotal,
            retrans: current.retransTotal,
            belated: current.belatedTotal,
        },
        {
            received: previous.recvUniquePacketsTotal,
            loss: previous.recvLossTotal,
            drop: previous.recvDropTotal,
            retrans: previous.retransTotal,
            belated: previous.belatedTotal,
        },
    );
    const { drop: dropped, loss: lost, retrans: retransmitted } = growth;
    const received = growth.received ?? 0;
    const lossRatio = received > 0 && lost !== null ? lost / received : 0;
    const forwarded = counterDelta(current.forwardedPackets, previous.forwardedPackets) ?? 0;
    if (dropped !== null && dropped > 0) {
        alerts.push({
            // The same line as a leg's one-minute error: 5 % or 1000 packets of media gone.
            severity:
                dropped >= SRT_DROPPED_ERROR_PACKETS || (received > 0 && dropped / received >= 0.05)
                    ? 'error'
                    : 'warning',
            code: 'srt-packets-dropped',
            message:
                received > 0
                    ? `SRT input packet drops are ${formatPercent((dropped / received) * 100)}% (${dropped} packet${dropped === 1 ? '' : 's'}) in the last health interval.`
                    : `SRT input dropped ${dropped} packet${dropped === 1 ? '' : 's'} in the last health interval.`,
            sinceMs: now,
        });
    } else if (lossRatio >= 0.01) {
        alerts.push({
            severity: lossRatio >= SRT_LOSS_ERROR_RATIO ? 'error' : 'warning',
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
    const belated = growth.belated ?? 0;
    if (
        received > 0 &&
        belated >= SRT_BELATED_MIN_PACKETS &&
        belated / received >= SRT_BELATED_WARN_RATIO
    ) {
        alerts.push({
            severity: 'warning',
            code: 'srt-belated-packets',
            message: `SRT belated packets are ${formatPercent((belated / received) * 100)}% (${belated} packets) in the last health interval.`,
            sinceMs: now,
        });
    }
    if (current.latencyMs !== null && current.latencyMs >= SRT_HIGH_LATENCY_WARN_MS) {
        alerts.push({
            severity: 'warning',
            code: 'srt-high-latency',
            message: `SRT latency is ${Math.round(current.latencyMs)} ms, above ${SRT_HIGH_LATENCY_WARN_MS} ms.`,
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
            // Down to a fifth or less of what it was: close to no media left.
            severity:
                current.recvBitrateKbps <=
                previous.recvBitrateKbps * BITRATE_COLLAPSE_ERROR_FRACTION
                    ? 'error'
                    : 'warning',
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
        reason = `${linkNoun} latency is ${Math.round(latencyMs)} ms, above ${SRT_HIGH_LATENCY_WARN_MS} ms.`;
    }
    return { health, reason };
}
