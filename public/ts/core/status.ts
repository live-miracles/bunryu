import { alertHint } from './hints.js';
import {
    STATUS_COLOR_ERROR,
    STATUS_COLOR_GOOD,
    STATUS_COLOR_OFF,
    STATUS_COLOR_WARN,
} from './utils.js';
import type {
    InputHealth,
    OutputStatusVerdict,
    OutputVerdict,
    OutputView,
    StatusVerdict,
    Verdict,
} from '../types.js';

// What the dashboard does with a status. The verdict itself, the status of an output or an
// input and the problems behind it, is worked out by the server (src/utils/healthVerdicts.ts)
// and arrives in the health response; the dashboard shows it, so the Overview, the pipeline
// panel, the output cards, the filters and Key Vault all say the same thing.

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

// The server's verdict as the views hold it: the same status and issues, with the hint for an
// input alert's code added. A verdict the server did not send (an output or pipeline newer
// than the last health response, or a database it could not read) is unknown, not fine.
export function toStatusVerdict(verdict: Verdict | undefined): StatusVerdict {
    if (!verdict) {
        return {
            status: 'warn',
            issues: [{ severity: 'warning', message: 'The status is not available yet.' }],
        };
    }
    return {
        status: verdict.status,
        issues: verdict.issues.map((issue) => {
            const hint = issue.code ? alertHint(issue.code) : null;
            return {
                severity: issue.severity,
                message: issue.message,
                ...(hint ? { hint } : {}),
                ...(issue.sinceMs !== undefined ? { sinceMs: issue.sinceMs } : {}),
            };
        }),
    };
}

export function toOutputStatusVerdict(verdict: OutputVerdict | undefined): OutputStatusVerdict {
    const view: OutputStatusVerdict = toStatusVerdict(verdict);
    if (verdict?.withoutInput) view.withoutInput = toStatusVerdict(verdict.withoutInput);
    return view;
}

export function lastErrorLine(output: OutputView): string {
    return (
        (output.lastError ?? '')
            .split('\n')
            .filter((line) => line.trim())
            .slice(-1)[0] ?? ''
    );
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
// populated. Do not show that startup placeholder as a bitrate. (The server holds the
// same 30 s for the input's low-bitrate warning; test/statusConstants.test.ts pins it.)
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
