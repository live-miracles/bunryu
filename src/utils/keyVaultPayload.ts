import crypto from 'crypto';
import type { Output, Pipeline } from '../types.js';
import {
    buildOutputViews,
    reportedState,
    type OutputHealthEntry,
    type ReportedStatus,
} from './outputStatus.js';
import { reportedInputState, type InputStatusEntry } from './inputStatus.js';
import { isRenditionUrl } from './renditions.js';
import type { PipelineAlert } from './srtLinkAlerts.js';

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

// The signal arriving in one pipeline. Key Vault matches it to one of its inputs by the
// pipeline's name (ignoring case and extra spaces), so the name goes out as typed.
export interface ReportedInput {
    pipeline: string;
    status: ReportedStatus;
    message: string;
    // When the input entered this status (ms since epoch).
    sinceMs: number;
}

export interface KeyVaultPayload {
    version: typeof PAYLOAD_VERSION;
    instance: string;
    sentAt: string;
    outputs: ReportedOutput[];
    inputs: ReportedInput[];
}

// Key Vault rejects the whole heartbeat for an empty pipeline name or one over 200 characters.
const MAX_PIPELINE_NAME_LENGTH = 200;

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

// When each output and input entered its current status, so that `sinceMs` holds from
// one report to the next. The reporter owns one for as long as it runs; building a
// payload notes the status of everything in it, so a change is timed when it is seen
// and not when the report that carries it is sent.
export interface SinceTracker {
    // When `key` entered `status`: the earlier answer while the status holds, else
    // `startedAtMs` where it is known (and not in the future), else `nowMs`.
    of(key: string, status: ReportedStatus, startedAtMs: number | null, nowMs: number): number;
    // Forgets every key not in `keys`, so a deleted output or pipeline does not keep its
    // entry for ever.
    retain(keys: ReadonlySet<string>): void;
}

export function createSinceTracker(): SinceTracker {
    const seen = new Map<string, { status: ReportedStatus; sinceMs: number }>();
    return {
        of(key, status, startedAtMs, nowMs) {
            const before = seen.get(key);
            if (before?.status === status) return before.sinceMs;
            const sinceMs =
                startedAtMs !== null && startedAtMs > 0 && startedAtMs <= nowMs
                    ? startedAtMs
                    : nowMs;
            seen.set(key, { status, sinceMs });
            return sinceMs;
        },
        retain(keys) {
            for (const key of seen.keys()) if (!keys.has(key)) seen.delete(key);
        },
    };
}

export interface PayloadSource {
    instance: string;
    hashSecret: string;
    pipelines: readonly Pipeline[];
    outputs: readonly Output[];
    // The health snapshot: per pipeline, whether its input is live and each output's state.
    health: Record<
        string,
        | {
              input: Partial<InputStatusEntry> & { live: boolean };
              outputs: Record<string, OutputHealthEntry>;
              alerts?: readonly PipelineAlert[];
          }
        | undefined
    >;
    // A stop after repeated failures: how many attempts failed, from the output's History.
    failedAttemptsOf?: (outputId: string) => number;
    since: SinceTracker;
    nowMs: number;
    // Caches hashes of URLs already seen (the HMAC is cheap, but there can be 500 outputs).
    hashOf?: (url: string) => string;
}

type PipelineHealth = NonNullable<PayloadSource['health'][string]>;

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

    const keys = new Set<string>();
    const reportedInputs: ReportedInput[] = [];
    const reported: ReportedOutput[] = [];
    for (const pipeline of source.pipelines) {
        const pipelineHealth = source.health[String(pipeline.id)];
        const outputs = outputsOf.get(pipeline.id) ?? [];
        const input = { live: pipelineHealth?.input.live ?? false };

        // Every pipeline has an input, whether or not it has outputs.
        const reportedInput = reportInput(source, pipeline, pipelineHealth, outputs);
        if (reportedInput) {
            keys.add(inputKey(pipeline));
            reportedInputs.push(reportedInput);
        }

        for (const view of buildOutputViews(outputs, pipelineHealth?.outputs)) {
            if (isRenditionUrl(view.url)) continue;
            const state = reportedState(view, input);
            keys.add(view.id);
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
                sinceMs: source.since.of(
                    view.id,
                    state.status,
                    knownStart(state.status, view),
                    source.nowMs,
                ),
            });
        }
    }
    source.since.retain(keys);

    return {
        version: PAYLOAD_VERSION,
        instance: source.instance,
        sentAt: new Date(source.nowMs).toISOString(),
        outputs: reported,
        inputs: reportedInputs,
    };
}

// Output ids are `<pipeline id>-<n>`, so this cannot be one.
const inputKey = (pipeline: Pipeline): string => `input:${pipeline.id}`;

// A pipeline's input as reported, or null for a name Key Vault would reject (blank),
// which is left out rather than failing the whole report.
function reportInput(
    source: PayloadSource,
    pipeline: Pipeline,
    pipelineHealth: PipelineHealth | undefined,
    outputs: readonly Output[],
): ReportedInput | null {
    const name = pipeline.name.slice(0, MAX_PIPELINE_NAME_LENGTH);
    if (!name.trim()) return null;
    const outputsShouldRun = outputs.some(
        (o) => o.desiredState !== 'stopped' && !isRenditionUrl(o.url),
    );
    const state = reportedInputState(
        {
            connected: false,
            mediaOk: null,
            mediaError: null,
            recvBitrateKbps: null,
            uptimeMs: null,
            audioTracks: [],
            audio: null,
            ...pipelineHealth?.input,
            live: pipelineHealth?.input.live ?? false,
        },
        pipelineHealth?.alerts ?? [],
        outputsShouldRun,
    );
    // A signal that is arriving began when the publisher connected, where known.
    const uptimeMs = pipelineHealth?.input.uptimeMs;
    const connectedAtMs =
        state.status === 'running' && uptimeMs != null && uptimeMs > 0
            ? source.nowMs - uptimeMs
            : null;
    return {
        pipeline: name,
        status: state.status,
        message: redactMessage(state.message),
        sinceMs: source.since.of(inputKey(pipeline), state.status, connectedAtMs, source.nowMs),
    };
}

// When the output really entered this status, where it knows (the first time it is seen
// after a restart of bunryu, or when the status changes).
function knownStart(
    status: ReportedStatus,
    view: { startedAtMs: number | null; warningSinceMs: number | null; lastErrorAt: number | null },
): number | null {
    return status === 'running'
        ? view.startedAtMs
        : status === 'warning'
          ? view.warningSinceMs
          : status === 'error'
            ? view.lastErrorAt
            : null;
}

// What changes the colour of a key in Key Vault: used to send at once on a change
// without sending for every new message or counter.
export function payloadSignature(payload: KeyVaultPayload): string {
    return [
        ...payload.outputs.map((o) => `${o.hash}:${o.status}:${o.stoppedAfterFailures ? 1 : 0}`),
        ...payload.inputs.map((i) => `i:${i.pipeline}:${i.status}`),
    ]
        .sort()
        .join('|');
}
