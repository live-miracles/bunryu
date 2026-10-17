import { execFile } from 'child_process';
import net from 'net';
import type { Express } from 'express';
import type { Db } from '../types.js';
import { kickSrsClientsByStream } from '../utils/srs.js';
import { RENDITION_APP, isRenditionOutput } from '../utils/renditions.js';
import type { SrsEvent } from '../services/health.js';
import type { InputState } from '../services/inputState.js';
import {
    createRejectedPublishes,
    isKeyShaped,
    type KeyState,
    type RejectedPublishes,
} from '../services/rejectedPublishes.js';

const MAX_LOG_READ_BYTES = 100 * 1024;
const MAX_LOG_TAIL_LINES = 200;

// All three only ever log to the journal (never a file), and only exist as
// systemd units in production — `npm run dev`/`npm run srs`/`npm run relay`
// aren't systemd-managed, so these read as empty (source 'none') locally.
const SRS_SYSTEMD_UNIT = 'srs.service';
const APP_SYSTEMD_UNIT = 'bunryu.service';
const RELAY_SYSTEMD_UNIT = 'goryu.service';

type LogSource = 'journal' | 'none';
interface LogTail {
    lines: string[];
    source: LogSource;
}

// SRS colors its own stdout with ANSI SGR codes, which journald stores
// verbatim. Lines are passed through as-is; the dashboard's log viewer
// renders those codes as color instead of stripping them.
function readJournalTail(unit: string, maxLines: number): Promise<string[]> {
    return new Promise((resolve) => {
        execFile(
            'journalctl',
            ['-u', unit, '-n', String(maxLines), '--no-pager', '-o', 'cat'],
            { timeout: 5000, maxBuffer: MAX_LOG_READ_BYTES },
            (err, stdout) => {
                resolve(err ? [] : stdout.split('\n').filter((l) => l.trim()));
            },
        );
    });
}

async function readJournalOnlyTail(unit: string, maxLines: number): Promise<LogTail> {
    const lines = await readJournalTail(unit, maxLines);
    return { lines, source: lines.length > 0 ? 'journal' : 'none' };
}

// A rejected publisher that keeps retrying (misconfigured or stale encoder)
// can hit on_publish far faster than any real publish/kick cycle needs — seen
// in production hitting 10-40ms retry intervals indefinitely. Without this,
// every single rejection fires its own kickSrsClientsByStream sweep against
// SRS's client-list API, and those unthrottled sweeps pile up faster than
// they resolve. Cap kicks to one per app/stream pair per window, and clear
// the whole map each window so it can't grow unbounded under a flood of
// distinct (attacker-controlled) stream names.
const KICK_COOLDOWN_MS = 5000;

// Hook bodies come from SRS, but the hook listener is the one place that parses
// network-supplied text into our logs and dashboard state. A client IP is only
// ever an IP literal; anything else (newlines, markup) is dropped so a body can
// never forge log lines or dashboard entries.
function safeIp(raw: unknown): string {
    return typeof raw === 'string' && net.isIP(raw) !== 0 ? raw : 'unknown';
}
const MAX_LISTED_REJECTIONS = 25;

function isLoopbackIp(ip: string): boolean {
    return ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');
}

export function registerSrsHooks(
    app: Express,
    db: Db,
    inputState: InputState,
    rejectedPublishes: RejectedPublishes = createRejectedPublishes(),
): void {
    // Which keys exist / are assigned only decides how a rejected attempt is
    // labelled in the dashboard (never whether it is accepted), so it is cached
    // and rebuilt only when the config revision changes — a refused publisher can
    // retry every 10-40ms and must not turn into a DB query per attempt. Names
    // that are not key-shaped are never looked up at all.
    let keySetsRev = -1;
    let validKeys = new Set<string>();
    let assignedKeys = new Set<string>();
    const keyStateOf = (stream: string): KeyState => {
        if (!isKeyShaped(stream)) return 'unknown';
        const rev = db.getConfigRev();
        if (rev !== keySetsRev) {
            validKeys = new Set(db.listStreamKeys().map((k) => k.key));
            assignedKeys = new Set(db.listPipelines().map((p) => p.streamKey));
            keySetsRev = rev;
        }
        return assignedKeys.has(stream)
            ? 'assigned'
            : validKeys.has(stream)
              ? 'unassigned'
              : 'unknown';
    };

    let recentlyKicked = new Map<string, number>();
    setInterval(() => {
        recentlyKicked = new Map();
    }, KICK_COOLDOWN_MS).unref();

    app.post('/api/srs/on_publish', (req, res) => {
        const stream = req.body?.stream as string | undefined;
        const hookApp = req.body?.app as string | undefined;
        const ip = safeIp(req.body?.ip);
        const protocol = (req.body?.tcUrl as string | undefined)?.startsWith('srt://')
            ? 'srt'
            : 'rtmp';

        // Records and logs a rejection. Repeats are throttled: the SRT relay
        // retries a refused publish every second. The IP goes before the
        // attacker-controlled name, which is JSON-quoted, so logs stay easy to
        // scan and cannot be made to look like a different client.
        const noteRejection = (name: string, keyState: KeyState, why: string): void => {
            const result = rejectedPublishes.record(
                name,
                keyState,
                protocol,
                ip === 'unknown' ? null : ip,
            );
            if (!result.shouldLog) return;
            const suppressed =
                result.suppressed > 0 ? ` (${result.suppressed} similar attempts suppressed)` : '';
            console.log(
                `[srs-hook] rejected publish from ${ip}: ${JSON.stringify(name)} (${protocol}, ${why})${suppressed}`,
            );
        };

        if (!stream) {
            noteRejection('', 'unknown', 'missing stream name');
            return res.status(400).json({ code: 400 });
        }

        // The reserved internal app carries shared encodes (renditions): the app's
        // own ffmpeg publishes them over loopback, so nothing else is accepted
        // there. It never carries a pipeline key, so this branch comes first.
        if (hookApp === RENDITION_APP) {
            const allowed =
                protocol === 'rtmp' &&
                isLoopbackIp(ip) &&
                db
                    .listOutputs()
                    .some(
                        (o) =>
                            isRenditionOutput(o) &&
                            o.desiredState === 'running' &&
                            o.url.endsWith(`/${RENDITION_APP}/${stream}`),
                    );
            if (allowed) {
                console.log(`[srs-hook] allowed shared-encode publish from ${ip}: ${stream}`);
                return res.json({ code: 0 });
            }
            noteRejection(stream, 'unknown', 'not a running shared encode');
            const kickKey = `${hookApp}/${stream}`;
            if (!recentlyKicked.has(kickKey)) {
                recentlyKicked.set(kickKey, Date.now());
                void kickSrsClientsByStream(hookApp, stream).catch(() => {});
            }
            return res.status(403).json({ code: 403 });
        }

        const pipeline = db.listPipelines().find((p) => p.streamKey === stream);
        if (!pipeline) {
            const keyIsValid = keyStateOf(stream) !== 'unknown';
            noteRejection(
                stream,
                keyIsValid ? 'unassigned' : 'unknown',
                keyIsValid ? 'key not assigned to a pipeline' : 'unknown stream key',
            );
            const kickKey = `${hookApp ?? ''}/${stream}`;
            if (hookApp && !recentlyKicked.has(kickKey)) {
                recentlyKicked.set(kickKey, Date.now());
                void kickSrsClientsByStream(hookApp, stream).catch(() => {});
            }
            return res.status(403).json({ code: 403 });
        }

        // SRS lets a same-key publish on a different protocol take over the
        // underlying source, but its own stats layer keeps the *original*
        // publisher's tcUrl/cid pinned — a same-key publish is treated as "a
        // duplicate publish event by bridge" and ignored — until the stream
        // fully drops to zero clients. That leaves our protocol tracking (and
        // the ffprobe URL it drives) permanently stuck on the old protocol: seen
        // in production as a stale "rtmp" badge and a failed encoding probe
        // after switching an already-live pipeline's publisher to SRT. Reject a
        // cross-protocol publish to an already-live pipeline outright so this
        // can't happen; the existing stream must be stopped first.
        const currentProtocol = inputState.getProtocol(pipeline.id);
        if (inputState.isLive(pipeline.id) && currentProtocol && currentProtocol !== protocol) {
            console.log(
                `[srs-hook] rejected publish from ${ip}: ${stream} (already live via ${currentProtocol}, attempted ${protocol})`,
            );
            return res.status(403).json({ code: 403 });
        }

        console.log(`[srs-hook] allowed publish from ${ip}: ${stream}`);
        return res.json({ code: 0 });
    });

    // Only the app's own ffmpeg/ffprobe (preview, outputs, health probes) ever
    // plays streams from SRS, and always over loopback. Rejecting every other
    // play makes the public RTMP/SRT ports ingest-only: knowing a stream key is
    // no longer enough to watch a stream. SRT plays fire this hook too (SRS
    // calls on_play for native SRT connections even with srt_to_rtmp off).
    app.post('/api/srs/on_play', (req, res) => {
        const ip = safeIp(req.body?.ip) === 'unknown' ? '' : (req.body.ip as string);
        const stream = (req.body?.stream as string | undefined) ?? '';
        if (!isLoopbackIp(ip)) {
            // An SRT stream id without "m=publish" is a play request to SRS, so an
            // encoder with an incomplete id is rejected here, not in on_publish.
            // Record it like a refused publish so it is visible in the dashboard.
            const protocol = (req.body?.tcUrl as string | undefined)?.startsWith('srt://')
                ? 'srt'
                : 'rtmp';
            const result = rejectedPublishes.record(
                stream,
                keyStateOf(stream),
                protocol,
                ip || null,
                'play',
            );
            if (result.shouldLog) {
                const suppressed =
                    result.suppressed > 0
                        ? ` (${result.suppressed} similar attempts suppressed)`
                        : '';
                console.log(
                    `[srs-hook] rejected play from ${ip || 'unknown'}: ${JSON.stringify(stream)} (${protocol})${suppressed}`,
                );
            }
            return res.status(403).json({ code: 403 });
        }
        return res.json({ code: 0 });
    });
}

// Authenticated: unlike the SRS hooks above, this is read by the dashboard.
export function registerRejectedPublishesApi(app: Express, rejected: RejectedPublishes): void {
    app.get('/api/rejected-publishes', (_req, res) => {
        // A scan of the public RTMP port can create many entries; cap what the
        // dashboard has to render and say how many were left out.
        const all = rejected.list();
        res.json({
            rejected: all.slice(0, MAX_LISTED_REJECTIONS),
            omitted: Math.max(0, all.length - MAX_LISTED_REJECTIONS),
        });
    });
}

export function registerSrsLogsApi(app: Express, getSrsEvents: () => SrsEvent[]): void {
    app.get('/api/srs-logs', async (_req, res) => {
        const [srs, dashboard, relay] = await Promise.all([
            readJournalOnlyTail(SRS_SYSTEMD_UNIT, MAX_LOG_TAIL_LINES),
            readJournalOnlyTail(APP_SYSTEMD_UNIT, MAX_LOG_TAIL_LINES),
            readJournalOnlyTail(RELAY_SYSTEMD_UNIT, MAX_LOG_TAIL_LINES),
        ]);
        res.json({ events: getSrsEvents(), srs, dashboard, relay });
    });
}
