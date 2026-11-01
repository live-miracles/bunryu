import crypto from 'crypto';
import type { Output, Pipeline } from '../types.js';
import {
    buildOutputViews,
    reportedState,
    type OutputHealthEntry,
    type ReportedStatus,
} from './outputStatus.js';
import { isRenditionUrl } from './renditions.js';

// The heartbeat bunryu sends to Key Vault (see docs/3-operations/3-configuration.md).
// Key Vault shows the state of each stream key from it, so the payload names an
// output only by a hash of its destination URL; the URL itself and anything secret
// in a message never leave this machine.

export const PAYLOAD_VERSION = 1;
export const MAX_MESSAGE_LENGTH = 300;

export interface ReportedOutput {
    hash: string;
    pipeline: string;
    output: string;
    status: ReportedStatus;
    message: string;
    failures: number;
    stoppedAfterFailures: boolean;
    // When the output entered this status (ms since epoch).
    sinceMs: number;
}

export interface KeyVaultPayload {
    version: typeof PAYLOAD_VERSION;
    instance: string;
    sentAt: string;
    outputs: ReportedOutput[];
}

// The string that is hashed: the URL trimmed, with a lowercase scheme and host (the
// rest, including the stream key, keeps its case) and no trailing "/". Key Vault builds
// the same string from a server and a key, so this must not be "improved" without it.
// test/fixtures/key-vault-hash-vectors.json holds the agreed vectors.
export function normalizeDestinationUrl(url: string): string {
    const trimmed = url.trim();
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(trimmed);
    let normalized = trimmed;
    if (match) {
        const [, scheme, authority, rest] = match;
        const hostStart = authority.lastIndexOf('@') + 1;
        normalized = `${scheme.toLowerCase()}://${authority.slice(0, hostStart)}${authority
            .slice(hostStart)
            .toLowerCase()}${rest}`;
    }
    return normalized.replace(/\/+$/, '');
}

// HMAC-SHA256 of the normalised URL, hex, first 32 characters (128 bits).
export function hashDestination(secret: string, url: string): string {
    return crypto
        .createHmac('sha256', secret)
        .update(normalizeDestinationUrl(url), 'utf8')
        .digest('hex')
        .slice(0, 32);
}

// A URL of any scheme (rtmp, rtmps, srt, tcp, http, ...): it may carry a stream key,
// a passphrase or the destination itself.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
// Sentence punctuation after a URL is not part of it; it is kept so the message still reads.
const TRAILING_PUNCTUATION_RE = /[,;.:)\]"']+$/;
// `key=`, `streamid=`, `passphrase=` (also `stream_key=`, `x-token=` ...) and their
// kin, with a quoted or bare value.
const SECRET_PARAM_RE =
    /\b([\w.-]*(?:key|streamid|passphrase|token|secret|password))=("[^"]*"|'[^']*'|\S*)/gi;
// A YouTube-style stream key, in case it is logged on its own.
const DASHED_KEY_RE = /\b[a-z0-9]{4}(?:-[a-z0-9]{4}){3,4}\b/gi;
// Long runs of key-like characters: 16 or more when they hold a digit (ids, keys,
// hashes), 32 or more whatever they hold.
const LONG_TOKEN_RE = /[A-Za-z0-9_-]{16,}/g;

function redactToken(token: string): string {
    return token.length >= 32 || /\d/.test(token) ? '<redacted>' : token;
}

// A message about an output is its own error or warning text (an FFmpeg stderr line,
// a watchdog reason), which routinely names the destination. This strips URLs, secret
// parameters and token-like strings, joins the lines and cuts it to 300 characters.
export function redactMessage(message: string): string {
    const redacted = message
        .replace(URL_RE, (url) => `<url>${url.match(TRAILING_PUNCTUATION_RE)?.[0] ?? ''}`)
        .replace(SECRET_PARAM_RE, '$1=<redacted>')
        .replace(DASHED_KEY_RE, '<redacted>')
        .replace(LONG_TOKEN_RE, redactToken)
        .replace(/\s+/g, ' ')
        .trim();
    return redacted.length > MAX_MESSAGE_LENGTH
        ? `${redacted.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
        : redacted;
}

export interface PayloadSource {
    instance: string;
    hashSecret: string;
    pipelines: readonly Pipeline[];
    outputs: readonly Output[];
    // The health snapshot: per pipeline, whether its input is live and each output's state.
    health: Record<
        string,
        { input: { live: boolean }; outputs: Record<string, OutputHealthEntry> } | undefined
    >;
    // A stop after repeated failures: how many attempts failed, from the output's History.
    failedAttemptsOf?: (outputId: string) => number;
    // Status changes seen so far, so `sinceMs` survives from one report to the next.
    // The caller owns it; it is updated here.
    sinceById: Map<string, { status: ReportedStatus; sinceMs: number }>;
    nowMs: number;
    // Caches hashes of URLs already seen (the HMAC is cheap, but there can be 500 outputs).
    hashOf?: (url: string) => string;
}

// Every configured output of every pipeline, but not the shared-encode rows that
// bunryu manages itself.
export function buildPayload(source: PayloadSource): KeyVaultPayload {
    const hashOf = source.hashOf ?? ((url: string) => hashDestination(source.hashSecret, url));
    const outputsOf = new Map<number, Output[]>();
    for (const output of source.outputs) {
        const list = outputsOf.get(output.pipelineId);
        if (list) list.push(output);
        else outputsOf.set(output.pipelineId, [output]);
    }

    const seen = new Set<string>();
    const reported: ReportedOutput[] = [];
    for (const pipeline of source.pipelines) {
        const pipelineHealth = source.health[String(pipeline.id)];
        const input = { live: pipelineHealth?.input.live ?? false };
        const views = buildOutputViews(outputsOf.get(pipeline.id) ?? [], pipelineHealth?.outputs);
        for (const view of views) {
            if (isRenditionUrl(view.url)) continue;
            const state = reportedState(view, input);
            seen.add(view.id);
            let since = source.sinceById.get(view.id);
            if (since?.status !== state.status) {
                since = {
                    status: state.status,
                    sinceMs: sinceOf(state.status, view, source.nowMs),
                };
                source.sinceById.set(view.id, since);
            }
            reported.push({
                hash: hashOf(view.url),
                pipeline: pipeline.name,
                output: view.name,
                status: state.status,
                message: redactMessage(state.message),
                failures: state.stoppedAfterFailures
                    ? Math.max(view.failures, source.failedAttemptsOf?.(view.id) ?? 0)
                    : view.failures,
                stoppedAfterFailures: state.stoppedAfterFailures,
                sinceMs: since.sinceMs,
            });
        }
    }
    // An output that was deleted must not keep its entry for ever.
    for (const id of source.sinceById.keys()) if (!seen.has(id)) source.sinceById.delete(id);

    return {
        version: PAYLOAD_VERSION,
        instance: source.instance,
        sentAt: new Date(source.nowMs).toISOString(),
        outputs: reported,
    };
}

// The first time an output is seen in a status (after a restart of bunryu, or when it
// changes): when it really began where the output knows, else now.
function sinceOf(
    status: ReportedStatus,
    view: { startedAtMs: number | null; warningSinceMs: number | null; lastErrorAt: number | null },
    nowMs: number,
): number {
    const known =
        status === 'running'
            ? view.startedAtMs
            : status === 'warning'
              ? view.warningSinceMs
              : status === 'error'
                ? view.lastErrorAt
                : null;
    return known && known > 0 && known <= nowMs ? known : nowMs;
}

// What changes the colour of a key in Key Vault: used to send at once on a change
// without sending for every new message or counter.
export function payloadSignature(payload: KeyVaultPayload): string {
    return payload.outputs
        .map((o) => `${o.hash}:${o.status}:${o.stoppedAfterFailures ? 1 : 0}`)
        .sort()
        .join('|');
}
