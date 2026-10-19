import { setInnerText, formatBitrate, formatBytes } from '../core/utils.js';
import { state } from '../core/state.js';
import type { PipelineView } from '../types.js';
import {
    getPreviewPipelineId,
    populatePreviewTrackSelect,
    stopCurrentPreview,
    syncPreviewControls,
} from './preview.js';

type MetricsViewDeps = {
    setMetricSeverity: (id: string, value: number | null) => void;
};

export function renderMetrics(deps: MetricsViewDeps): void {
    const metrics = state.metrics;
    const cpu = metrics.cpu ?? null;
    const ram = metrics.ram ?? null;
    const disk = metrics.disk ?? null;
    const net = metrics.net ?? null;
    const cpuPercent = cpu ? cpu.percent : null;
    const ramPercent = ram ? Math.round((ram.usedBytes / ram.totalBytes) * 100) : null;
    const diskPercent = disk ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : null;

    // The navbar shows only live usage; the machine's size lives in Settings.
    setInnerText('navbar-cpu-value', cpu ? `CPU ${cpuPercent}%` : 'CPU —');
    deps.setMetricSeverity('navbar-cpu-value', cpuPercent);
    setInnerText('navbar-ram-value', ram ? `RAM ${ramPercent}%` : 'RAM —');
    deps.setMetricSeverity('navbar-ram-value', ramPercent);
    setInnerText('navbar-disk-value', disk ? `Disk ${diskPercent}%` : 'Disk —');
    deps.setMetricSeverity('navbar-disk-value', diskPercent);
    setInnerText(
        'navbar-net-rx',
        net ? `↓ ${formatBitrate((net.rxBytesPerSec * 8) / 1000)}` : '↓ —',
    );
    setInnerText(
        'navbar-net-tx',
        net ? `↑ ${formatBitrate((net.txBytesPerSec * 8) / 1000)}` : '↑ —',
    );

    setInnerText('v-cpu', cpu ? `${cpu.cores} cores` : '—');
    setInnerText('v-ram', ram ? formatBytes(ram.totalBytes) : '—');
    setInnerText('v-disk', disk ? formatBytes(disk.totalBytes) : '—');
}

export function renderPreview(pipeline: PipelineView): void {
    const section = document.getElementById('preview-section');
    if (!section) return;

    if (!pipeline.input.live) {
        section.classList.add('hidden');
        if (getPreviewPipelineId() === pipeline.id) stopCurrentPreview();
        return;
    }

    section.classList.remove('hidden');

    const activePid = getPreviewPipelineId();
    if (activePid && activePid !== pipeline.id) stopCurrentPreview();

    populatePreviewTrackSelect(pipeline);
    syncPreviewControls(getPreviewPipelineId() === pipeline.id);
}
