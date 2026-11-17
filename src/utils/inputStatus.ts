import type { PipelineAlert } from './srtLinkAlerts.js';
import type { ReportedStatus } from './outputStatus.js';

// The state of a pipeline's input, as the dashboard shows it (dot colour and Issues
// text), and what the Key Vault reporter sends from it. This is the server's twin of
// inputHealth in public/ts/core/status.ts (the dashboard cannot import backend code and
// the backend cannot import the dashboard's); test/inputStatusParity.test.js runs both
// on the same inputs and asserts they agree, so change them together.

// Same values as LOW_BITRATE_KBPS in public/ts/core/utils.ts and
// INPUT_BITRATE_STATS_WARMUP_MS in public/ts/core/status.ts.
const LOW_BITRATE_KBPS = 200;
const INPUT_BITRATE_STATS_WARMUP_MS = 30_000;

// Alerts about the input itself, which belong to its status; every other pipeline alert
// is about the SRT relay link. Same list as INPUT_ALERT_CODES in public/ts/core/pipeline.ts.
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
        issues.push({ severity: alert.severity, message: alert.message });
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
