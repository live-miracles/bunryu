import { alertHint } from './hints.js';
import {
    LOW_BITRATE_KBPS,
    STATUS_COLOR_ERROR,
    STATUS_COLOR_GOOD,
    STATUS_COLOR_OFF,
    STATUS_COLOR_WARN,
} from './utils.js';
import type { InputHealth, OutputView } from '../types.js';

// The verdict on an output or an input: its status, and the problems behind it.
// Pure functions of what the server reported, so the Overview, the pipeline panel,
// the output cards, the filters and the sound alerts all say the same thing.

export type OutStatus = 'good' | 'warn' | 'error' | 'off';
export type InputStatus = 'good' | 'warn' | 'error' | 'off';

export interface StatusIssue {
    severity: 'warning' | 'error';
    message: string;
    // What to do about it, when known (see core/hints.ts).
    hint?: string;
    // When it began, for an issue that is still going on.
    sinceMs?: number;
}

export function inputStatusMessage(input: InputHealth): string {
    if (input.mediaError) return input.mediaError;
    if (input.mediaOk === null)
        return 'Waiting for ffprobe to finish and return the input encoding.';
    return 'Input connected, waiting for valid media.';
}

export function lastErrorLine(output: OutputView): string {
    return (
        (output.lastError ?? '')
            .split('\n')
            .filter((line) => line.trim())
            .slice(-1)[0] ?? ''
    );
}

// True if the most recent error is still relevant to what's on screen right
// now. A watchdog/exit path always records the error before the process dies,
// so once a fresh restart happens (o.startedAtMs moves past lastErrorAt) the
// error belongs to a prior, already-resolved incarnation. When there's no
// current process at all (startedAtMs null), that's either an actual
// between-retries gap after a real ffmpeg failure (failures > 0 — keep
// showing it) or a manual start that hasn't spawned yet / is waiting on the
// input to come ready (start() resets failures to 0 before attempting to
// spawn) — in that case any old error is a stale prior incarnation, not the
// reason ffmpeg isn't running yet, so don't resurrect it.
export function hasCurrentError(o: OutputView): boolean {
    if (o.lastError === null || o.lastErrorAt === null) return false;
    if (o.startedAtMs === null) return o.failures > 0;
    return o.lastErrorAt >= o.startedAtMs;
}

export function summarizeOutputError(error: string | null | undefined, fallback: string): string {
    if (!error) return fallback;

    const lastLine =
        error
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .pop() ?? '';
    if (!lastLine) return fallback;

    const singleLine = lastLine.replace(/\s+/g, ' ');
    return singleLine.length > 160 ? `${singleLine.slice(0, 157)}...` : singleLine;
}

// SRS reports a zero receive bitrate until its rolling bitrate statistics are
// populated. Do not turn that startup placeholder into a low-bitrate warning.
const INPUT_BITRATE_STATS_WARMUP_MS = 30_000;

export function inputBitrateStatsReady(input: InputHealth): boolean {
    return input.uptimeMs !== null && input.uptimeMs >= INPUT_BITRATE_STATS_WARMUP_MS;
}

// The bitrate to show for an input, or null while it has not run long enough to
// have a meaningful one.
export function displayInputBitrateKbps(input: InputHealth): number | null {
    if (input.live && input.recvBitrateKbps === 0 && !inputBitrateStatsReady(input)) {
        return null;
    }
    return input.recvBitrateKbps;
}

// The colour of a status dot or a status in a table row.
export function statusColor(status: OutStatus | InputStatus): string {
    if (status === 'good') return STATUS_COLOR_GOOD;
    if (status === 'warn') return STATUS_COLOR_WARN;
    if (status === 'error') return STATUS_COLOR_ERROR;
    return STATUS_COLOR_OFF;
}

// What an output that pulls a shared encode should say while it is not running
// because the encode is not up yet. The output restarts by itself once the
// encode is ready, so this is a warning, not an error.
export function sharedEncodeIssue(
    output: OutputView,
): { severity: 'warning'; message: string } | null {
    const rendition = output.sharedEncode;
    if (!rendition || output.desiredState !== 'running' || output.status === 'running') {
        return null;
    }
    if (rendition.ready) return null;
    if (rendition.status === 'failed' || hasCurrentError(rendition)) {
        const line = lastErrorLine(rendition);
        return {
            severity: 'warning',
            message: line ? `Shared encode failed: ${line}` : 'Shared encode failed.',
        };
    }
    return { severity: 'warning', message: `Waiting for ${rendition.name}` };
}

export interface OutputHealth {
    status: OutStatus;
    issues: StatusIssue[];
}

export interface DerivedInputHealth {
    status: InputStatus;
    issues: StatusIssue[];
}

// `includeInput` false leaves out "the input is not live", which a shared encode's
// status shows on its own side of the dot (see sharedEncodeIndicator).
export function outputHealth(o: OutputView, input: InputHealth, includeInput = true): OutputHealth {
    if (o.desiredState === 'stopped') return { status: 'off', issues: [] };

    // An output that pulls a shared encode which is not up yet is waiting, not
    // failing: it restarts by itself once the encode is ready.
    const sharedIssue = sharedEncodeIssue(o);
    if (sharedIssue) return { status: 'warn', issues: [sharedIssue] };

    const withFailures = (message: string): string =>
        o.failures > 0
            ? `${o.failures} error${o.failures === 1 ? '' : 's'} since last start. ${message}`
            : message;

    if (o.status === 'failed') {
        return {
            status: 'error',
            issues: [
                {
                    severity: 'error',
                    message: withFailures(
                        summarizeOutputError(o.lastError, 'Output process failed.'),
                    ),
                },
            ],
        };
    }

    if (o.status === 'running') {
        if (includeInput && !input.live) {
            return {
                status: 'warn',
                issues: [
                    { severity: 'warning', message: 'Output is running but input is not live.' },
                ],
            };
        }
        if (o.warningReason !== null) {
            return { status: 'warn', issues: [{ severity: 'warning', message: o.warningReason }] };
        }
        if (o.bitrateKbps !== null && o.bitrateKbps >= LOW_BITRATE_KBPS) {
            return { status: 'good', issues: [] };
        }
        if (o.bitrateKbps === null && hasCurrentError(o)) {
            return {
                status: 'error',
                issues: [
                    {
                        severity: 'error',
                        message: withFailures(
                            summarizeOutputError(
                                o.lastError,
                                'Output has no bitrate after an error.',
                            ),
                        ),
                    },
                ],
            };
        }
        if (o.bitrateKbps === null) {
            return {
                status: 'warn',
                issues: [
                    {
                        severity: 'warning',
                        message: 'Output is running but no bitrate is reported yet.',
                    },
                ],
            };
        }
        return {
            status: 'warn',
            issues: [
                {
                    severity: 'warning',
                    message: `Output bitrate is below ${LOW_BITRATE_KBPS} kb/s.`,
                },
            ],
        };
    }

    // status === 'stopped' but desiredState === 'running': between retries
    if (hasCurrentError(o)) {
        return {
            status: 'error',
            issues: [
                {
                    severity: 'error',
                    message: withFailures(
                        summarizeOutputError(o.lastError, 'Output failed and is waiting to retry.'),
                    ),
                },
            ],
        };
    }
    return {
        status: 'warn',
        issues: [{ severity: 'warning', message: 'Output is waiting to start or retry.' }],
    };
}

export function inputHealth(input: InputHealth): DerivedInputHealth {
    if (!input.connected) return { status: 'off', issues: [] };
    // A failed probe takes precedence over the transient pending state. This
    // also keeps an error visible if a later retry has not begun or completed.
    if (input.mediaOk === false || input.mediaError) {
        return {
            status: 'error',
            issues: [{ severity: 'error', message: inputStatusMessage(input) }],
        };
    }
    // A connected publisher is not fully ready until ffprobe has returned the
    // media details used to validate and display its encoding.
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

    const issues: StatusIssue[] = [];
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
    // Only report missing audio after ffprobe has confirmed usable media;
    // otherwise every new input briefly appears unhealthy during startup.
    if (input.audioTracks.length === 0 && input.audio === null) {
        issues.push({ severity: 'warning', message: 'No audio track detected in input.' });
    }
    for (const alert of input.alerts ?? []) {
        issues.push({
            severity: alert.severity,
            message: alert.message,
            hint: alertHint(alert.code) ?? undefined,
            sinceMs: alert.sinceMs,
        });
    }
    if (issues.some((issue) => issue.severity === 'error')) return { status: 'error', issues };
    return { status: issues.length > 0 ? 'warn' : 'good', issues };
}
