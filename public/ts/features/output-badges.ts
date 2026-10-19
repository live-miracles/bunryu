import { formatBitrate, formatBytes, formatCpuPercent } from '../core/utils.js';
import type { OutputView } from '../types.js';

// Pieces shared by the output card and the Shared encodes card, kept in a leaf
// module so the two can use each other's building blocks without importing in a
// circle.

const METRIC_WARN_PERCENT = 70;
const METRIC_ERROR_PERCENT = 90;

export const ICON_HISTORY = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 7v5l3 2"/></svg>`;
export const ICON_PLAY = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>`;
export const ICON_STOP = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>`;
export const ICON_RESTART = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`;
export const ICON_ITERATION_CW = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 3 3-3 3"/><path d="M15 5a9 9 0 1 1-3 16.9"/></svg>`;

function outputMemoryPercent(output: OutputView): number | null {
    if (output.memoryUsageBytes == null || !output.memoryLimitBytes) return null;
    return (output.memoryUsageBytes / output.memoryLimitBytes) * 100;
}

function formatOutputMemory(output: OutputView): string | null {
    if (output.memoryUsageBytes == null) return null;
    return formatBytes(output.memoryUsageBytes);
}

// "bitrate | CPU | RSS" badge of a running output; empty when nothing is known.
export function outputMetricsBadge(output: OutputView): string {
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
    const parts = [
        output.bitrateKbps !== null ? formatBitrate(output.bitrateKbps) : null,
        output.cpuPercent !== null ? formatCpuPercent(output.cpuPercent) : null,
        output.memoryUsageBytes !== null ? formatOutputMemory(output) : null,
    ].filter((value): value is string => value !== null);
    return `<span class="badge badge-sm whitespace-nowrap ${memCls}" title="Bitrate / ffmpeg CPU (% of one core) / ffmpeg RSS">${parts.join(' | ')}</span>`;
}
