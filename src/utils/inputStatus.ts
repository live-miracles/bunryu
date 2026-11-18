import type { PipelineAlert } from './srtLinkAlerts.js';
import type { ReportedStatus } from './outputStatus.js';

// The state of a pipeline's input and why: the one place these rules live. The verdict they
// give (dot colour, Issues text) goes to the dashboard in /api/health (healthVerdicts.ts),
// and `reportedInputState` below turns it into what the Key Vault reporter sends. The
// dashboard has no copy; the few values it repeats for display are pinned in
// test/statusConstants.test.js.

// The dashboard repeats these two (LOW_BITRATE_KBPS in public/ts/core/utils.ts and
// INPUT_BITRATE_STATS_WARMUP_MS in public/ts/core/status.ts) for the bitrate it shows.
const LOW_BITRATE_KBPS = 200;
const INPUT_BITRATE_STATS_WARMUP_MS = 30_000;

// Alerts about the input itself, which belong to its status; every other pipeline alert
// is about the SRT relay link. The dashboard repeats this list (INPUT_ALERT_CODES in
// public/ts/core/pipeline.ts) to sort alerts into the input's and the relay's.
export const INPUT_ALERT_CODES: ReadonlySet<string> = new Set([
    'input-flapping',
    'input-low-framerate',
    'input-high-framerate',
    'input-interlaced',
    'input-keyframe-interval',
]);

export type InputStatus = 'good' | 'warn' | 'error' | 'off';

// The part of a health snapshot's per-pipeline input (InputHealth in services/health.ts)
// that decides the status.
export interface InputStatusEntry {
    connected: boolean;
    live: boolean;
    mediaOk: boolean | null;
    mediaError: string | null;
    recvBitrateKbps: number | null;
    uptimeMs: number | null;
    audioTracks: readonly unknown[];
    audio: unknown | null;
}

export interface InputIssue {
    severity: 'warning' | 'error';
    message: string;
    // An alert's code and start, for the dashboard's hint and "since"; the other issues have none.
    code?: string;
    sinceMs?: number;
}

// The input as the status rules need it, from a health snapshot's input (which can be
// missing or partial before the first poll that sees the pipeline): nothing connected.
export function toInputStatusEntry(input: Partial<InputStatusEntry> | undefined): InputStatusEntry {
    return {
        connected: false,
        live: false,
        mediaOk: null,
        mediaError: null,
        recvBitrateKbps: null,
        uptimeMs: null,
        audioTracks: [],
        audio: null,
        ...input,
    };
}

function inputStatusMessage(input: InputStatusEntry): string {
    if (input.mediaError) return input.mediaError;
    if (input.mediaOk === null) {
        return 'Waiting for ffprobe to finish and return the input encoding.';
    }
    return 'Input connected, waiting for valid media.';
}

// SRS reports a zero receive bitrate until its rolling statistics are populated; that
// startup placeholder is not a low bitrate.
function inputBitrateStatsReady(input: InputStatusEntry): boolean {
    return input.uptimeMs !== null && input.uptimeMs >= INPUT_BITRATE_STATS_WARMUP_MS;
}

// `alerts` are all of the pipeline's alerts (PipelineHealth.alerts); the ones about the
// input itself are merged into the input's status, as the dashboard does in parsePipelines.
export function inputHealth(
    input: InputStatusEntry,
    alerts: readonly PipelineAlert[] = [],
): { status: InputStatus; issues: InputIssue[] } {
    if (!input.connected) return { status: 'off', issues: [] };
    // A failed probe takes precedence over the transient pending state.
    if (input.mediaOk === false || input.mediaError) {
        return {
            status: 'error',
            issues: [{ severity: 'error', message: inputStatusMessage(input) }],
        };
    }
    // A connected publisher is not ready until ffprobe has returned its media details.
    if (input.mediaOk === null) {
        return {
            status: 'warn',
            issues: [{ severity: 'warning', message: inputStatusMessage(input) }],
        };
    }
    if (!input.live) {
        return {
            status: 'warn',
            issues: [{ severity: 'warning', message: inputStatusMessage(input) }],
        };
    }

    const issues: InputIssue[] = [];
    if (
        inputBitrateStatsReady(input) &&
        input.recvBitrateKbps !== null &&
        input.recvBitrateKbps < LOW_BITRATE_KBPS
    ) {
        issues.push({
            severity: 'warning',
            message: `Input bitrate is below ${LOW_BITRATE_KBPS} kb/s.`,
        });
    }
    if (input.audioTracks.length === 0 && input.audio === null) {
        issues.push({ severity: 'warning', message: 'No audio track detected in input.' });
    }
    for (const alert of alerts) {
        if (!INPUT_ALERT_CODES.has(alert.code)) continue;
        issues.push({
            severity: alert.severity,
            message: alert.message,
            code: alert.code,
            sinceMs: alert.sinceMs,
        });
    }
    if (issues.some((issue) => issue.severity === 'error')) return { status: 'error', issues };
    return { status: issues.length > 0 ? 'warn' : 'good', issues };
}

export const NO_SIGNAL_MESSAGE = 'No signal is arriving.';

export interface ReportedInputState {
    status: ReportedStatus;
    // Why, in one line, unredacted: it can be an ffprobe error.
    message: string;
}

// The state the Key Vault reporter sends for an input. No signal at all (`off`) is an
// error when an output of the pipeline should be running, since that is when somebody
// is waiting for it, and just `stopped` (idle) when nothing should run.
export function reportedInputState(
    input: InputStatusEntry,
    alerts: readonly PipelineAlert[],
    outputsShouldRun: boolean,
): ReportedInputState {
    const health = inputHealth(input, alerts);
    if (health.status === 'off') {
        return outputsShouldRun
            ? { status: 'error', message: NO_SIGNAL_MESSAGE }
            : { status: 'stopped', message: '' };
    }
    if (health.status === 'good') return { status: 'running', message: '' };
    return {
        status: health.status === 'error' ? 'error' : 'warning',
        message: health.issues[0].message,
    };
}
