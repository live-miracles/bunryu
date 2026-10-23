// Says who is publishing an input, for the pipeline log and the diagnostics.
//
// SRS reports the publisher's address, except for SRT that came through goryu: the
// relay publishes to SRS over loopback, so SRS sees 127.0.0.1 and the encoder's
// address is only in the relay's status (`peer`, plain SRT). A bonded group is
// described by its legs (utils/legLog.ts), so it gets no line here.

/** How long to wait for the relay to report the peer of a loopback SRT publisher. The
 * relay status is polled every 5 s, so it can still show the input as inactive for
 * a poll or two after SRS has the publish. After this the loopback address is logged
 * as it is (an encoder on the same host). */
export const RELAY_PEER_WAIT_MS = 15_000;

export interface PublisherLogState {
    /** SRS client id of the publisher this state belongs to. */
    cid: string;
    firstSeenMs: number;
    done: boolean;
}

export interface RelayInputView {
    active: boolean;
    bonded: boolean;
    peer: { ip: string; port: number } | null;
}

export interface PublisherSource {
    /** What to log, or null when there is nothing to say. */
    line: string | null;
    /** True while the relay may still report the peer; ask again on the next poll. */
    wait: boolean;
}

export function describePublisherSource(params: {
    protocol: 'rtmp' | 'srt';
    ip: string | null;
    loopback: boolean;
    relay: RelayInputView;
    waitedMs: number;
}): PublisherSource {
    const { protocol, ip, loopback, relay, waitedMs } = params;
    if (!ip) return { line: null, wait: false };
    if (protocol === 'rtmp' || !loopback) return { line: `${protocol} from ${ip}`, wait: false };
    if (relay.active && relay.bonded) return { line: null, wait: false };
    if (relay.active && relay.peer) {
        return { line: `srt via relay from ${relay.peer.ip}:${relay.peer.port}`, wait: false };
    }
    if (waitedMs < RELAY_PEER_WAIT_MS) return { line: null, wait: true };
    return { line: `srt from ${ip}`, wait: false };
}

/**
 * The state for this poll and, when the publisher is new and its source is known, the
 * line to log (once per SRS client id). `cid` is null when nothing is publishing.
 */
export function nextPublisherLog(
    state: PublisherLogState | undefined,
    cid: string | null,
    now: number,
    source: (waitedMs: number) => PublisherSource,
): { state: PublisherLogState | undefined; line: string | null } {
    if (!cid) return { state: undefined, line: null };
    const current = state?.cid === cid ? state : { cid, firstSeenMs: now, done: false };
    if (current.done) return { state: current, line: null };
    const found = source(now - current.firstSeenMs);
    if (found.wait) return { state: current, line: null };
    return { state: { ...current, done: true }, line: found.line };
}
