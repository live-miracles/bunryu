// Remembers recent publish attempts that on_publish rejected because the stream
// name is not a key assigned to a pipeline, and play attempts that on_play
// rejected from outside (an SRT stream id without "m=publish" is a play request
// to SRS, so an encoder with a typo'd id lands there), so the dashboard can show
// them. An
// encoder on an unassigned key looks healthy on its side (SRT through the
// bonding relay even connects and streams at full bitrate until SRS refuses the
// downstream publish), and without this the only trace is a journal line.
//
// Names shaped like a stream key ("key01_<secret>") are tracked one entry per
// key label. Every other name (empty, a typo, a key missing its "keyNN_" prefix,
// a scan) is folded into one aggregate entry per protocol, so the map is bounded
// no matter what a public RTMP port is sent. The aggregate also counts distinct
// names (by a short in-memory hash, never the name) so the dashboard can say how
// many different streams it stands for. The secret part of a key, and any
// other name, is never stored, returned or logged — only the label.

import { createHash } from 'node:crypto';

export type RejectedPublishReason = 'assigned' | 'unassigned' | 'unknown' | 'unrecognized';
// What the stream name matched: a key some pipeline uses, a valid key no
// pipeline uses, or no key at all (only meaningful for key-shaped names).
export type KeyState = 'assigned' | 'unassigned' | 'unknown';
export type RejectedKind = 'publish' | 'play';

export interface RejectedPublish {
    // "key01" — the non-secret prefix of the stream key. Empty for the
    // 'unrecognized' aggregate, which stands for every non-key name.
    label: string;
    // 'publish': on_publish refused it. 'play': on_play refused a non-loopback
    // play request (a viewer, or an encoder whose SRT stream id lacks m=publish).
    kind: RejectedKind;
    // 'assigned': the key belongs to a pipeline (only seen for plays).
    // 'unassigned': the full key is a valid stream key that no pipeline uses.
    // 'unknown': right label but the secret does not match any key (stale key
    // after a regenerate, or a typo). 'unrecognized': not shaped like a key.
    reason: RejectedPublishReason;
    protocol: 'rtmp' | 'srt';
    ip: string | null;
    attempts: number;
    lastAttemptAgoMs: number;
    // Distinct stream names seen recently. Always 1 for a key label; for the
    // 'unrecognized' aggregate, how many different names it combines.
    streams: number;
    // True when the distinct-name set is full, so `streams` is a lower bound.
    streamsCapped: boolean;
}

export interface RecordResult {
    // False while a repeat of an already-logged rejection is being throttled.
    shouldLog: boolean;
    // Rejections not logged since the last logged one for this label and kind.
    suppressed: number;
}

const KEY_LABEL_RE = /^(key\d{1,3})_/;
const OTHER_BUCKET = '';
const OTHER_LABEL = '';
// A stuck encoder (or the relay retrying a refused SRT publish every second)
// would otherwise write one identical line per attempt.
const LOG_INTERVAL_MS = 60_000;
const RETENTION_MS = 5 * 60_000;
// A refused publisher can retry every 10-40ms; walking every entry on each call
// would be wasted work, and retention is minutes, so prune at most once a second.
const PRUNE_INTERVAL_MS = 1000;
// A real deployment has 99 key slots; this only guards against malformed labels.
const MAX_ENTRIES = 200;
// Distinct names tracked per aggregate entry; beyond this the count is "N+".
const MAX_DISTINCT_NAMES = 100;

interface Entry {
    label: string;
    kind: RejectedKind;
    reason: RejectedPublishReason;
    protocol: 'rtmp' | 'srt';
    ip: string | null;
    attempts: number;
    lastAttemptAt: number;
    // Aggregate entries only: short hash of each distinct name -> last seen.
    names: Map<string, number> | null;
    namesCapped: boolean;
}

export interface RejectedPublishes {
    record(
        stream: string,
        keyState: KeyState,
        protocol: 'rtmp' | 'srt',
        ip: string | null,
        kind?: RejectedKind,
    ): RecordResult;
    list(): RejectedPublish[];
}

export function isKeyShaped(stream: string): boolean {
    return KEY_LABEL_RE.test(stream);
}

export function createRejectedPublishes(now: () => number = Date.now): RejectedPublishes {
    const entries = new Map<string, Entry>();
    // Throttle state is separate from entries: all non-key names share one log
    // bucket, so a stream of distinct junk names can't bypass the throttle.
    const lastLogged = new Map<string, { at: number; suppressed: number }>();
    let lastPruneAt = 0;

    function prune(at: number): void {
        for (const [entryKey, entry] of entries) {
            if (at - entry.lastAttemptAt > RETENTION_MS) {
                entries.delete(entryKey);
                continue;
            }
            if (!entry.names) continue;
            for (const [hash, seenAt] of entry.names) {
                if (at - seenAt > RETENTION_MS) entry.names.delete(hash);
            }
            if (entry.names.size < MAX_DISTINCT_NAMES) entry.namesCapped = false;
        }
        for (const [label, state] of lastLogged) {
            if (at - state.at > RETENTION_MS) lastLogged.delete(label);
        }
    }

    function record(
        stream: string,
        keyState: KeyState,
        protocol: 'rtmp' | 'srt',
        ip: string | null,
        kind: RejectedKind = 'publish',
    ): RecordResult {
        const at = now();
        if (at - lastPruneAt >= PRUNE_INTERVAL_MS) {
            prune(at);
            lastPruneAt = at;
        }
        const label = KEY_LABEL_RE.exec(stream)?.[1] ?? OTHER_BUCKET;

        // Key-shaped names get their own entry; everything else shares one per
        // protocol, which (unlike key labels) needs no size guard.
        const entryKey = label === OTHER_BUCKET ? `other:${kind}:${protocol}` : `${kind}:${label}`;
        if (label === OTHER_BUCKET || entries.size < MAX_ENTRIES || entries.has(entryKey)) {
            const prev = entries.get(entryKey);
            const names = label === OTHER_BUCKET ? (prev?.names ?? new Map()) : null;
            let namesCapped = prev?.namesCapped ?? false;
            if (names) {
                const hash = createHash('sha256').update(stream).digest('hex').slice(0, 16);
                if (names.has(hash) || names.size < MAX_DISTINCT_NAMES) names.set(hash, at);
                else namesCapped = true;
            }
            entries.set(entryKey, {
                label: label === OTHER_BUCKET ? OTHER_LABEL : label,
                kind,
                reason: label === OTHER_BUCKET ? 'unrecognized' : keyState,
                protocol,
                ip,
                attempts: (prev?.attempts ?? 0) + 1,
                lastAttemptAt: at,
                names,
                namesCapped,
            });
        }

        // Publish and play rejections of the same key are different incidents.
        const bucket = `${kind}:${label}`;
        const state = lastLogged.get(bucket);
        if (state && at - state.at < LOG_INTERVAL_MS) {
            state.suppressed++;
            return { shouldLog: false, suppressed: state.suppressed };
        }
        const suppressed = state?.suppressed ?? 0;
        lastLogged.set(bucket, { at, suppressed: 0 });
        return { shouldLog: true, suppressed };
    }

    function list(): RejectedPublish[] {
        const at = now();
        prune(at);
        return [...entries.values()]
            .sort((a, b) => b.lastAttemptAt - a.lastAttemptAt)
            .map((e) => ({
                label: e.label,
                kind: e.kind,
                reason: e.reason,
                protocol: e.protocol,
                ip: e.ip,
                attempts: e.attempts,
                lastAttemptAgoMs: at - e.lastAttemptAt,
                streams: e.names ? e.names.size : 1,
                streamsCapped: e.namesCapped,
            }));
    }

    return { record, list };
}
