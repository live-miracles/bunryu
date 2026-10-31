import { formatBitrate, formatBytes, formatCpuPercent, LOW_BITRATE_KBPS } from '../core/utils.js';
import type { InputHealth, OutputView } from '../types.js';

// Pieces shared by the output card and the Shared encodes card, kept in a leaf
// module so the two can use each other's building blocks without importing in a
// circle.

const METRIC_WARN_PERCENT = 70;
const METRIC_ERROR_PERCENT = 90;
// Speed (x realtime) is shown only outside this band; inside it, it is not shown at all.
// Below is the falling-behind signal (the server warns at 0.9); above
// is a backlog draining after a stall or a fast clock, informative rather than a fault.
const SPEED_BADGE_LOW = 0.95;
const SPEED_BADGE_HIGH = 1.05;
// An output that copies the video carries about the input's bitrate, so its bitrate is
// shown only outside this band around the input's. Wide on purpose: a copy output reads
// 8 to 10% below an SRT input (FLV carries less container overhead than MPEG-TS), and
// FFmpeg reports an average since the output started, not the current rate.
const BITRATE_BADGE_LOW = 0.6;
const BITRATE_BADGE_HIGH = 1.4;
// A copy output costs 1 to 4% of a core (docs/1-getting-started/4-sizing.md), so CPU is
// shown only from this much. An output with a video encode is expected to be busy: no CPU.
const CPU_BADGE_PERCENT = 50;

export const ICON_PENCIL = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
export const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-1 2-1h4c1 0 2 1 2 2v1"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;
export const ICON_COPY = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
export const ICON_HISTORY = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 7v5l3 2"/></svg>`;
export const ICON_PLAY = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>`;
export const ICON_STOP = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>`;
export const ICON_RESTART = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`;
export const ICON_ITERATION_CW = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`;

// The sidebar's Outputs badges: each status is counted on its own, so a warning
// output is not also a running one.
export function outputStatusCounts(statuses: Array<'good' | 'warn' | 'error' | 'off'>): {
    running: number;
    warnings: number;
    errors: number;
} {
    const count = (status: string) => statuses.filter((s) => s === status).length;
    return { running: count('good'), warnings: count('warn'), errors: count('error') };
}

function outputMemoryPercent(output: OutputView): number | null {
    if (output.memoryUsageBytes == null || !output.memoryLimitBytes) return null;
    return (output.memoryUsageBytes / output.memoryLimitBytes) * 100;
}

function formatOutputMemory(output: OutputView): string | null {
    if (output.memoryUsageBytes == null) return null;
    return formatBytes(output.memoryUsageBytes);
}

// The badges of a running output: one per figure that is off, so a healthy output has
// none and the Overview's Outputs table is where the full set is read. The bitrate shows
// when it is below the minimum or, for a copy of a live input with a known rate, outside the
// band around it (see BITRATE_BADGE_LOW); the CPU when a copy output uses CPU_BADGE_PERCENT
// or more; the memory from the warning level; the speed when off realtime. A shared
// encode is judged the same way. Empty when nothing is shown.
export function outputMetricsBadge(output: OutputView, input?: InputHealth): string {
    if (
        output.status !== 'running' ||
        (output.bitrateKbps === null &&
            output.cpuPercent === null &&
            output.memoryUsageBytes === null)
    ) {
        return '';
    }
    const memPercent = outputMemoryPercent(output);
    const memCls =
        memPercent !== null && memPercent >= METRIC_ERROR_PERCENT
            ? 'badge-error'
            : memPercent !== null && memPercent >= METRIC_WARN_PERCENT
              ? 'badge-warning'
              : '';
    const speed = output.speed ?? null;
    const slow = speed !== null && speed < SPEED_BADGE_LOW;
    const offRealtime = speed !== null && (slow || speed > SPEED_BADGE_HIGH);
    const copiesVideo = output.videoEncoding === 'copy';
    const expected =
        copiesVideo && input?.live && input.recvBitrateKbps ? input.recvBitrateKbps : null;
    const bitrateAsExpected =
        output.bitrateKbps !== null &&
        expected !== null &&
        output.bitrateKbps >= LOW_BITRATE_KBPS &&
        output.bitrateKbps >= expected * BITRATE_BADGE_LOW &&
        output.bitrateKbps <= expected * BITRATE_BADGE_HIGH;
    const bitrateOff =
        output.bitrateKbps !== null &&
        (output.bitrateKbps < LOW_BITRATE_KBPS || (expected !== null && !bitrateAsExpected));
    const cpuOff =
        output.cpuPercent !== null && copiesVideo && output.cpuPercent >= CPU_BADGE_PERCENT;
    const memoryOff =
        output.memoryUsageBytes !== null &&
        memPercent !== null &&
        memPercent >= METRIC_WARN_PERCENT;
    const shown: Array<{ text: string | null; label: string; cls: string }> = [
        {
            text: bitrateOff ? formatBitrate(output.bitrateKbps as number) : null,
            label: 'bitrate',
            cls: '',
        },
        {
            text: cpuOff ? formatCpuPercent(output.cpuPercent as number) : null,
            label: 'CPU (% of a core)',
            cls: '',
        },
        { text: memoryOff ? formatOutputMemory(output) : null, label: 'memory', cls: memCls },
        {
            text: offRealtime ? `${speed.toFixed(2)}x` : null,
            label: 'speed (x realtime)',
            cls: slow ? 'badge-warning' : '',
        },
    ];
    const present = shown.filter((part) => part.text !== null);
    if (present.length === 0) return '';
    // One badge per figure, each with its own colour and tooltip.
    return present
        .map(
            (part) =>
                `<span class="badge badge-sm whitespace-nowrap ${part.cls}" title="${part.label}">${part.text}</span>`,
        )
        .join('');
}
