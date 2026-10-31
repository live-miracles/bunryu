import {
    setInnerText,
    setBadgeCount,
    escapeHtml,
    copyText,
    formatBitrate,
    formatBytes,
    formatCpuPercent,
    formatBitrateAxis,
    getUrlParam,
    fmtMs,
    fmtMbpsValue,
    formatAgo,
    formatClockTime,
    formatLocalDateTime,
    setHtmlKeepScroll,
    STATUS_COLOR_GOOD,
    STATUS_COLOR_WARN,
    STATUS_COLOR_ERROR,
    STATUS_COLOR_OFF,
    formatUptime,
} from '../core/utils.js';
import { healthNowMs, saveCollapsedGroups, state } from '../core/state.js';
import {
    PUBLISH_MODES,
    livePublishMode,
    publishRows,
    type PublishMode,
} from '../core/publish-modes.js';
import { rejectedVia, rejectedWhy } from '../core/rejected.js';
import type {
    AudioInfo,
    AudioTrackInfo,
    InputHealth,
    LayoutOrderEntry,
    OutputView,
    PipelineGroup,
    PipelineView,
    SrtBondingLeg,
    VideoInfo,
} from '../types.js';
import { updateLayoutOrder, updatePipeline, updatePipelineGroups } from '../core/api.js';
import {
    dupTooltip,
    formatOutputName,
    outputSeverity,
    renderOutputCard,
    type DupRef,
} from './output-card.js';
import { ICON_PENCIL, ICON_TRASH, outputStatusCounts } from './output-badges.js';
import { renderSharedEncodes, sharedEncodeUsage } from './shared-encodes.js';
import { sharedEncodeLabel } from '../core/renditions.js';
import { buildOverviewModel, type OverviewTable, type UsageRow } from '../core/overview-model.js';
import {
    hasCurrentRelayError,
    inputAggregateStatsAreDropOnly,
    recentFigure,
    renderBondedLegs,
    renderBondingStats,
} from './srt-bonding-view.js';
import {
    legHealthColor,
    legHealthLabel,
    relayHealth,
    relayIssueList,
    type RelayHealth,
} from '../core/relay-status.js';
import { audioSpecLines, videoSpec } from '../core/media-spec.js';
import {
    displayInputBitrateKbps,
    inputHealth,
    outputHealth,
    statusColor,
    type InputStatus,
    type OutStatus,
    type StatusIssue,
} from '../core/status.js';
import { issueLinesHtml, renderStatusTooltip, splitDotGradient } from './status-tooltip.js';
import {
    countOutputs,
    matchesOutputFilter,
    noMatchingOutputsText,
    outputSummaryHtml,
} from '../core/outputs-filter.js';
import { srtPassphraseResetBlock } from '../core/pipeline.js';
import { countLabel, searchBoxHtml, tallyStatuses, worstOfTally } from '../core/overview-filter.js';
import { CHART_SCROLL_STEP_MS, CHART_WINDOW_MS, chartCard, drawChart } from './dashboard-charts.js';
import { renderInputStats } from './input-stats-view.js';
import { renderStatusView } from './status-view.js';
import { renderMetrics as renderMetricsView, renderPreview } from './metrics-view.js';

declare global {
    interface Window {
        selectPipeline: (id: string | null) => void;
    }
}

const STATUS_RANK: Record<OutStatus, number> = { error: 3, warn: 2, good: 1, off: 0 };
function worstStatus(a: OutStatus, b: OutStatus): OutStatus {
    return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}
function statusBadge(n: number, cls: string): string {
    return n > 0 ? `<div class="badge badge-sm ${cls} px-2">${n}</div>` : '';
}
type OverviewIssue = StatusIssue;
type BondingIndicator = {
    leftColor: string;
    rightColor: string;
    tooltip: string;
};

type OutputVideoResolution = { width: number; height: number };
type OutputVideoContext = { input: InputHealth; output: OutputView };
type OutputVideoValue<T> = T | 'copy' | ((ctx: OutputVideoContext) => T | null);
type OutputVideoDisplayPreset = {
    codec: OutputVideoValue<string>;
    resolution?: OutputVideoValue<OutputVideoResolution>;
    fps?: OutputVideoValue<number | null>;
    fieldOrder?: OutputVideoValue<string | null>;
};

const OUTPUT_VIDEO_PRESETS: Record<string, OutputVideoDisplayPreset> = {
    copy: { codec: 'copy', resolution: 'copy', fps: 'copy', fieldOrder: 'copy' },
    '720p': { codec: 'h264', resolution: { width: 1280, height: 720 }, fps: 'copy' },
    '1080p': { codec: 'h264', resolution: { width: 1920, height: 1080 }, fps: 'copy' },
    vertical_rotate: {
        codec: 'h264',
        resolution: ({ input }) => rotatedScaleResolution(input.video, 720),
        fps: 'copy',
        fieldOrder: 'copy',
    },
};

const pendingOutputs = new Map<string, 'start' | 'stop'>();
const METRIC_WARN_PERCENT = 70;
const METRIC_ERROR_PERCENT = 90;

// ── Drag-and-drop reordering ───────────────────────────
//
// The pipeline list and outputs list are rebuilt (innerHTML) on every 5s
// poll tick regardless of whether anything changed, which would yank a
// dragged element out from under the user mid-gesture. While a drag is in
// progress, renderPipelineList/renderOutputsList skip rebuilding entirely —
// the module-level element refs below double as that "don't touch the DOM
// right now" flag, and are always cleared by the drag's `dragend`, which
// the browser guarantees fires whether the drop succeeded or was cancelled.
let draggingPipelineEl: HTMLElement | null = null;
let draggingGroupEl: HTMLElement | null = null;
let draggingOutputEl: HTMLElement | null = null;
// The pipeline the Outputs list's filter was set for, and whether it hides anything.
// The saved order covers every output, so cards cannot be dragged while it does.
let outputsListPipelineId: string | null = null;
let outputsListFiltered = false;
// Updated on every dragover while a pipeline is being dragged, to whichever
// group (or 'ungrouped') the cursor is currently over — read once at dragend
// to decide whether the pipeline's group membership actually changed.
let currentDropGroupKey: string | null = null;

// The order actually being displayed right now (post drag-and-drop, or as
// last loaded from the server) — the baseline `persist*Order` helpers below
// patch one dimension of before writing back, so an in-flight drag on one
// pipeline's outputs doesn't clobber another pipeline's already-saved order.
function currentLayoutOrder(): LayoutOrderEntry[] {
    return state.pipelines.map((p) => ({ id: Number(p.id), outs: p.outs.map((o) => o.id) }));
}

async function persistLayoutOrderOnly(newPipelineOrder: string[]): Promise<void> {
    const byId = new Map(currentLayoutOrder().map((e) => [String(e.id), e]));
    const order = newPipelineOrder
        .map((id) => byId.get(id))
        .filter((e): e is LayoutOrderEntry => !!e);
    await updateLayoutOrder(order);
}

// Persists a pipeline drag that may have also moved the pipeline into a
// different group (or out to ungrouped) — the drop position's group is
// tracked live in `currentDropGroupKey` as the user drags, since the flat
// list mixes group headers and pipeline rows and there's no other way to
// tell "the pipeline landed in group X" from the final DOM order alone.
async function persistPipelineDrop(
    newPipelineOrder: string[],
    movedId: string,
    newGroupKey: string,
): Promise<void> {
    await persistLayoutOrderOnly(newPipelineOrder);
    const pipeline = state.pipelines.find((p) => p.id === movedId);
    if (pipeline) {
        const newGroupId = newGroupKey === 'ungrouped' ? null : Number(newGroupKey);
        if (newGroupId !== pipeline.groupId) {
            await updatePipeline(movedId, pipeline.name, undefined, newGroupId);
        }
    }
    const { refreshAfterMutation } = await import('./dashboard.js');
    await refreshAfterMutation();
}

// Persists a reordering of the groups themselves — a whole-collection
// replace (the same endpoint the group controls use), keeping each group's id/name and
// just resubmitting them in the new order so `position` follows array index.
async function persistGroupOrder(groupIds: number[]): Promise<void> {
    const byId = new Map((state.config.groups ?? []).map((g) => [g.id, g]));
    const groups = groupIds
        .map((id) => byId.get(id))
        .filter((g): g is PipelineGroup => !!g)
        .map((g) => ({ id: g.id, name: g.name }));
    await updatePipelineGroups(groups);
    const { refreshAfterMutation } = await import('./dashboard.js');
    await refreshAfterMutation();
}

async function persistOutputOrder(pipelineId: string, newOutputOrder: string[]): Promise<void> {
    const order = currentLayoutOrder().map((e) =>
        String(e.id) === pipelineId ? { ...e, outs: newOutputOrder } : e,
    );
    await updateLayoutOrder(order);
    const { refreshAfterMutation } = await import('./dashboard.js');
    await refreshAfterMutation();
}

function outputMemoryPercent(o: OutputView): number | null {
    if (o.memoryUsageBytes == null || !o.memoryLimitBytes) return null;
    return (o.memoryUsageBytes / o.memoryLimitBytes) * 100;
}

function formatOutputMemory(o: OutputView): string | null {
    if (o.memoryUsageBytes == null) return null;
    return formatBytes(o.memoryUsageBytes);
}

function memorySeverityClass(percent: number | null): string {
    if (percent !== null && percent >= METRIC_ERROR_PERCENT) return 'text-error font-semibold';
    if (percent !== null && percent >= METRIC_WARN_PERCENT) return 'text-warning font-semibold';
    return '';
}

function setMetricSeverity(id: string, percent: number | null): void {
    const el = document.getElementById(id);
    if (!el) return;

    const isError = percent !== null && percent >= METRIC_ERROR_PERCENT;
    const isWarning =
        percent !== null && percent >= METRIC_WARN_PERCENT && percent < METRIC_ERROR_PERCENT;

    el.classList.toggle('text-error', isError);
    el.classList.toggle('text-warning', isWarning);
    el.classList.toggle('font-semibold', isError || isWarning);
}

function outStatus(o: OutputView, input: InputHealth): OutStatus {
    return outputHealth(o, input).status;
}

function inputStatus(input: InputHealth): InputStatus {
    return inputHealth(input).status;
}

function overviewStatusBadge(st: InputStatus | OutStatus): string {
    if (st === 'error') return '<span class="badge badge-sm badge-error">ERROR</span>';
    if (st === 'warn') return '<span class="badge badge-sm badge-warning">WARNING</span>';
    if (st === 'off') return '<span class="tabular-nums text-xs text-muted">—</span>';
    return '<span class="badge badge-sm badge-success">OK</span>';
}

function renderOverviewIssues(issues: OverviewIssue[]): string {
    if (issues.length === 0) return '<span class="text-muted">—</span>';
    return issueLinesHtml(issues);
}

function inputIssues(input: InputHealth): OverviewIssue[] {
    return inputHealth(input).issues;
}

function outputIssues(o: OutputView, input: InputHealth): OverviewIssue[] {
    return outputHealth(o, input).issues;
}

function selectedAudioTrack(
    tracks: AudioTrackInfo[],
    audioEncoding: string | null | undefined,
): AudioTrackInfo | null {
    if (tracks.length === 0) return null;
    if (!audioEncoding || audioEncoding === 'copy') return tracks[0];

    const firstTrack = audioEncoding
        .split(',')
        .map((part) => Number(part.trim()))
        .find((idx) => Number.isInteger(idx) && idx >= 0);
    return firstTrack == null ? tracks[0] : (tracks[firstTrack] ?? null);
}

function rotatedScaleResolution(
    video: VideoInfo | null,
    scaleWidth: number,
): { width: number; height: number } | null {
    if (!video?.width || !video.height) return null;
    const scaledHeight = Math.max(2, Math.round((video.height * scaleWidth) / video.width / 2) * 2);
    return { width: scaledHeight, height: scaleWidth };
}

function inputResolution(video: VideoInfo | null): OutputVideoResolution | null {
    return video ? { width: video.width, height: video.height } : null;
}

function resolveOutputVideoValue<T>(
    value: OutputVideoValue<T> | undefined,
    copyValue: T | null,
    ctx: OutputVideoContext,
): T | null {
    if (value === undefined) return null;
    if (value === 'copy') return copyValue;
    if (typeof value === 'function') return (value as (ctx: OutputVideoContext) => T | null)(ctx);
    return value;
}

function deriveOutputMedia(
    input: InputHealth,
    output: OutputView,
): {
    video: Pick<
        VideoInfo,
        'codec' | 'width' | 'height' | 'fps' | 'fieldOrder' | 'profile' | 'level'
    > | null;
    audio: Pick<AudioInfo, 'codec' | 'profile' | 'channel' | 'sample_rate'> | null;
} {
    const preset = OUTPUT_VIDEO_PRESETS[output.videoEncoding] ?? OUTPUT_VIDEO_PRESETS.copy;
    const ctx = { input, output };
    const codec = resolveOutputVideoValue(preset.codec, input.video?.codec ?? null, ctx);
    const resolution = resolveOutputVideoValue(
        preset.resolution ?? 'copy',
        inputResolution(input.video),
        ctx,
    );
    const fps = resolveOutputVideoValue(preset.fps ?? 'copy', input.video?.fps ?? null, ctx);
    const fieldOrder = resolveOutputVideoValue(
        preset.fieldOrder ?? 'copy',
        input.video?.fieldOrder ?? null,
        ctx,
    );
    const copiesInputVideo = output.videoEncoding === 'copy';
    const video = codec
        ? {
              codec,
              width: resolution?.width ?? 0,
              height: resolution?.height ?? 0,
              fps,
              fieldOrder,
              profile: copiesInputVideo ? (input.video?.profile ?? '') : '',
              level: copiesInputVideo ? (input.video?.level ?? '') : '',
          }
        : null;

    if (!output.url) return { video, audio: null };

    if (!output.url.startsWith('srt://')) {
        return {
            video,
            audio: {
                codec: 'aac',
                profile: 'LC',
                channel: 2,
                sample_rate: 48000,
            },
        };
    }

    const track = selectedAudioTrack(input.audioTracks, output.audioEncoding);
    if (track) {
        return {
            video,
            audio: {
                codec: track.codec,
                profile: track.profile,
                channel: track.channels,
                sample_rate: track.sampleRate,
            },
        };
    }

    return { video, audio: input.audio };
}

// SRS only sees the relay on loopback for a relay-fed input, so the encoder's
// own address (known for a plain input) is what the input stats should show.
function relaySourceIp(pipeline: PipelineView): string | null {
    const { acceptedBySrs, input } = pipeline.srtBonding;
    return acceptedBySrs && !input.bonded ? (input.peer?.ip ?? null) : null;
}

function relayTypeLabel(pipeline: PipelineView): string {
    return pipeline.srtBonding.input.bonded ? 'Bonded' : 'Relay';
}

// A failed leg leaves the relay's legs[] instead of being reported as broken, so
// legs that are down are the ones the group had (`expectedLegs`) and no longer has.
function getBondingIndicator(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
): BondingIndicator {
    const tooltip = (
        inputIssues: OverviewIssue[],
        outputIssues: OverviewIssue[],
        idle?: string,
    ): string =>
        renderStatusTooltip(
            {
                label: 'SRT input',
                issues: inputIssues,
                active: true,
                ok: `${pipeline.srtBonding.input.bonded ? 'Bonded SRT input' : 'SRT input via relay'} receiving.`,
                off: '',
            },
            {
                label: 'Forward to SRS',
                issues: outputIssues,
                active: true,
                ok: 'Forwarding to SRS.',
                off: '',
            },
            idle,
        );

    if (!relayProcessRunning) {
        return {
            leftColor: STATUS_COLOR_OFF,
            rightColor: STATUS_COLOR_OFF,
            tooltip: tooltip([], [], 'SRT relay is not running; relay SRT input unavailable.'),
        };
    }

    if (!pipeline.srtBonding.inputActive) {
        return {
            leftColor: STATUS_COLOR_OFF,
            rightColor: STATUS_COLOR_OFF,
            tooltip: tooltip([], [], 'No relay SRT input for this stream key.'),
        };
    }

    const health = relayHealth(pipeline, relayProcessRunning, healthNowMs());
    const onSide = (side: 'input' | 'output'): OverviewIssue[] =>
        health.issues.filter((i) => i.side === side).map(({ issue }) => issue);

    return {
        leftColor: statusColor(health.input),
        rightColor: statusColor(health.output),
        tooltip: tooltip(onSide('input'), onSide('output')),
    };
}

function relayInputSeverityColor(
    pipeline: PipelineView,
    relay: RelayHealth,
    inputColor: string,
): string {
    if (inputStatus(pipeline.input) !== 'good') return inputColor;
    if (relay.input === 'error' || relay.output === 'error') return STATUS_COLOR_ERROR;
    if (relay.input === 'warn' || relay.output === 'warn') return STATUS_COLOR_WARN;
    return inputColor;
}

// ── Pipeline list (left column) ───────────────────────

function renderPipelineList(): void {
    const listEl = document.getElementById('pipelines');
    if (!listEl) return;
    if (draggingPipelineEl || draggingGroupEl) return; // preserve the DOM while a drag is in progress

    const inputsOn = state.pipelines.filter((p) => inputStatus(p.input) === 'good').length;
    const inputsWarn = state.pipelines.filter((p) => inputStatus(p.input) === 'warn').length;
    const inputsFailed = state.pipelines.filter((p) => inputStatus(p.input) === 'error').length;
    const totalOutputs = state.pipelines.reduce((s, p) => s + p.outs.length, 0);
    const outputCounts = outputStatusCounts(
        state.pipelines.flatMap((p) => p.outs.map((o) => outStatus(o, p.input))),
    );
    const outputsOff = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => o.desiredState === 'stopped').length,
        0,
    );

    setInnerText('pipe-cnt', state.pipelines.length);
    setInnerText('pipe-cnt-label', state.pipelines.length === 1 ? 'Input' : 'Inputs');
    setBadgeCount('pipe-oks', inputsOn);
    setBadgeCount('pipe-warns', inputsWarn + inputsFailed);
    setBadgeCount(
        'pipe-offs',
        state.pipelines.filter((p) => inputStatus(p.input) === 'off').length,
    );
    setInnerText('out-cnt', totalOutputs);
    setInnerText('out-cnt-label', totalOutputs === 1 ? 'Output' : 'Outputs');
    setBadgeCount('out-oks', outputCounts.running);
    setBadgeCount('out-warns', outputCounts.warnings);
    setBadgeCount('out-errors', outputCounts.errors);
    setBadgeCount('out-offs', outputsOff);

    const selectedId = getUrlParam('p');
    const relayProcessRunning = state.health.srtRelay?.status === 'running';

    // Pipelines sharing a stream key can't both actually publish — flag it the
    // same way duplicate output destination URLs are flagged.
    const keyRefs = new Map<number, DupRef[]>();
    for (const p of state.pipelines) {
        const list = keyRefs.get(p.streamKeyId) ?? [];
        list.push({ pipelineName: p.name });
        keyRefs.set(p.streamKeyId, list);
    }
    const dupKeys = new Map<number, DupRef[]>();
    for (const [id, refs] of keyRefs) {
        if (refs.length > 1) dupKeys.set(id, refs);
    }

    const renderPipelineRow = (p: PipelineView, groupKey: string): string => {
        const {
            good: outGood,
            warn: outWarn,
            error: outFailed,
            off: outOff,
        } = tallyStatuses(p.outs.map((o) => outStatus(o, p.input)));

        const relay = relayHealth(p, relayProcessRunning, healthNowMs());
        const inColor = relayInputSeverityColor(p, relay, statusColor(inputStatus(p.input)));
        const outColor =
            outFailed > 0
                ? STATUS_COLOR_ERROR
                : outWarn > 0
                  ? STATUS_COLOR_WARN
                  : outGood > 0
                    ? STATUS_COLOR_GOOD
                    : STATUS_COLOR_OFF;
        const selected = p.id === selectedId ? 'bg-base-100' : '';
        // Same halves as the dot: everything on the way in (the input and, for SRT through
        // the relay, the relay), then the outputs.
        const statusTooltip = renderStatusTooltip(
            {
                label: 'Input',
                issues: [...inputIssues(p.input), ...relayIssueList(relay)],
                active: p.input.connected,
                ok: 'Input is live.',
                off: 'No input.',
            },
            {
                label: 'Outputs',
                issues: p.outs.flatMap((o) =>
                    outputIssues(o, p.input).map((issue) => ({
                        severity: issue.severity,
                        message: `${o.name}: ${issue.message}`,
                    })),
                ),
                active: outOff < p.outs.length,
                ok: 'Outputs are running normally.',
                off: 'No outputs running.',
            },
        );

        const uptimeSpan =
            p.input.live && p.input.uptimeMs !== null
                ? `<span class="tabular-nums text-xs text-muted shrink-0">${formatUptime(p.input.uptimeMs)}</span>`
                : '';
        const inputTypeBadge = p.input.connected
            ? `<span class="badge badge-sm badge-outline shrink-0">${p.srtBonding.acceptedBySrs ? relayTypeLabel(p) : p.input.isSrt ? 'SRT' : 'RTMP'}</span>`
            : '';
        const dupKeyRefs = dupKeys.get(p.streamKeyId);
        const nameClass = dupKeyRefs ? 'truncate min-w-0 text-warning' : 'truncate min-w-0';
        const dupKeyWarn = dupKeyRefs
            ? `<span class="js-tooltip text-warning shrink-0 inline-flex" tabindex="0">${ICON_WARN}<div class="js-tooltip-content hidden">${dupTooltip('Duplicate stream key — also used by:', dupKeyRefs)}</div></span>`
            : '';

        return `<li data-pipeline-id="${p.id}" data-group-key="${groupKey}">
            <div class="flex items-center gap-2 ${selected} cursor-pointer js-select-pipeline" data-id="${p.id}">
                <div class="js-tooltip shrink-0">
                    <div class="rounded-box h-5 w-5" style="background-image:${splitDotGradient(inColor, outColor)}"></div>
                    <div class="js-tooltip-content hidden">${statusTooltip}</div>
                </div>
                ${statusBadge(outGood, 'badge-success')}
                ${statusBadge(outWarn, 'badge-warning')}
                ${statusBadge(outFailed, 'badge-error')}
                ${statusBadge(outOff, 'badge-ghost')}
                <a class="js-pipeline-drag-handle cursor-grab ${nameClass}" draggable="true" title="Drag to reorder">${escapeHtml(p.name)}</a>
                ${dupKeyWarn}
                ${uptimeSpan}
                ${inputTypeBadge}
            </div>
        </li>`;
    };

    // Bucket pipelines by group — groups always render first, in the order
    // configured in the sidebar, followed by ungrouped pipelines. A pipeline
    // whose group no longer exists (deleted in another session) falls back to
    // ungrouped, self-healing the same way a stale layoutOrder id does.
    const groups = [...(state.config.groups ?? [])].sort((a, b) => a.position - b.position);
    const groupIds = new Set(groups.map((g) => g.id));
    const byGroup = new Map<number, PipelineView[]>();
    const ungrouped: PipelineView[] = [];
    for (const p of state.pipelines) {
        if (p.groupId !== null && groupIds.has(p.groupId)) {
            const list = byGroup.get(p.groupId) ?? [];
            list.push(p);
            byGroup.set(p.groupId, list);
        } else {
            ungrouped.push(p);
        }
    }

    // Marks where groups end and the ungrouped pipelines begin — without it,
    // the first ungrouped row reads as if it might still belong to the group
    // above it. Always shown (even with no groups or no ungrouped pipelines)
    // so the boundary stays a stable, predictable landmark rather than
    // popping in and out as membership changes.
    const groupToUngroupedDivider = '<li class="border-base-content/10 my-1 border-t"></li>';

    listEl.innerHTML =
        groups
            .map((g) => {
                const members = byGroup.get(g.id) ?? [];
                const collapsed = state.collapsedGroupIds.has(g.id);
                const header = renderGroupHeader(g, members, collapsed);
                const rows = collapsed
                    ? ''
                    : members.map((p) => renderPipelineRow(p, String(g.id))).join('');
                return header + rows;
            })
            .join('') +
        groupToUngroupedDivider +
        ungrouped.map((p) => renderPipelineRow(p, 'ungrouped')).join('');

    listEl.onclick = (e) => {
        const groupAction = (e.target as Element).closest(
            '.js-edit-group, .js-delete-group',
        ) as HTMLElement | null;
        if (groupAction?.dataset.groupId) {
            const groupId = Number(groupAction.dataset.groupId);
            if (groupAction.classList.contains('js-edit-group'))
                window.editPipelineGroupBtn(groupId);
            else void window.removePipelineGroupBtn(groupId);
            return;
        }
        const toggle = (e.target as Element).closest('.js-toggle-group') as HTMLElement | null;
        if (toggle?.dataset.groupId) {
            const groupId = Number(toggle.dataset.groupId);
            if (state.collapsedGroupIds.has(groupId)) state.collapsedGroupIds.delete(groupId);
            else state.collapsedGroupIds.add(groupId);
            saveCollapsedGroups();
            renderPipelineList();
            return;
        }
        const row = (e.target as Element).closest('.js-select-pipeline') as HTMLElement | null;
        if (row?.dataset.id) window.selectPipeline(row.dataset.id);
    };

    listEl.ondragstart = (e) => {
        const target = e.target as Element;
        const pipelineLi = target.closest('li[data-pipeline-id]') as HTMLElement | null;
        if (target.closest('.js-pipeline-drag-handle') && pipelineLi) {
            draggingPipelineEl = pipelineLi;
            currentDropGroupKey = null;
            pipelineLi.classList.add('opacity-40');
            e.dataTransfer!.effectAllowed = 'move';
            e.dataTransfer!.setData('text/plain', pipelineLi.dataset.pipelineId!);
            e.dataTransfer!.setDragImage(pipelineLi, 12, 12);
            return;
        }
        const groupLi = target.closest('li[data-group-id]') as HTMLElement | null;
        if (target.closest('.js-group-drag-handle') && groupLi) {
            draggingGroupEl = groupLi;
            groupLi.classList.add('opacity-40');
            e.dataTransfer!.effectAllowed = 'move';
            e.dataTransfer!.setData('text/plain', groupLi.dataset.groupId!);
            e.dataTransfer!.setDragImage(groupLi, 12, 12);
            return;
        }
        e.preventDefault();
    };

    listEl.ondragover = (e) => {
        if (draggingGroupEl) {
            // Groups only reorder among themselves — hovering a pipeline row
            // (or empty space) simply doesn't move the header.
            const overGroupLi = (e.target as Element).closest(
                'li[data-group-id]',
            ) as HTMLElement | null;
            if (!overGroupLi || overGroupLi === draggingGroupEl) return;
            e.preventDefault();
            e.dataTransfer!.dropEffect = 'move';
            const rect = overGroupLi.getBoundingClientRect();
            const before = e.clientY < rect.top + rect.height / 2;
            overGroupLi.parentElement?.insertBefore(
                draggingGroupEl,
                before ? overGroupLi : overGroupLi.nextElementSibling,
            );
            return;
        }

        if (!draggingPipelineEl) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        const overGroupLi = (e.target as Element).closest(
            'li[data-group-id]',
        ) as HTMLElement | null;
        if (overGroupLi) {
            // Dropping directly on a group's header moves the pipeline into
            // that group as its first member — the only way to target a
            // collapsed (or currently empty) group, which has no member rows
            // of its own to drop onto.
            currentDropGroupKey = overGroupLi.dataset.groupId!;
            overGroupLi.parentElement?.insertBefore(
                draggingPipelineEl,
                overGroupLi.nextElementSibling,
            );
            return;
        }
        const overPipelineLi = (e.target as Element).closest(
            'li[data-pipeline-id]',
        ) as HTMLElement | null;
        if (!overPipelineLi) {
            // Empty space below the last row — only reachable past the last
            // group's members or the ungrouped rows, so it always means "drop
            // into ungrouped, at the end" (also how an empty ungrouped bucket,
            // which otherwise has no row to drop onto, is reachable at all).
            currentDropGroupKey = 'ungrouped';
            listEl.appendChild(draggingPipelineEl);
            return;
        }
        if (overPipelineLi === draggingPipelineEl) return;
        currentDropGroupKey = overPipelineLi.dataset.groupKey!;
        const rect = overPipelineLi.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        overPipelineLi.parentElement?.insertBefore(
            draggingPipelineEl,
            before ? overPipelineLi : overPipelineLi.nextElementSibling,
        );
    };

    listEl.ondrop = (e) => e.preventDefault();

    listEl.ondragend = () => {
        if (draggingGroupEl) {
            draggingGroupEl.classList.remove('opacity-40');
            const groupOrder = Array.from(listEl.querySelectorAll('li[data-group-id]')).map((li) =>
                Number((li as HTMLElement).dataset.groupId),
            );
            draggingGroupEl = null;
            void persistGroupOrder(groupOrder);
            return;
        }
        if (draggingPipelineEl) {
            const movedId = draggingPipelineEl.dataset.pipelineId!;
            const newGroupKey = currentDropGroupKey ?? draggingPipelineEl.dataset.groupKey!;
            draggingPipelineEl.classList.remove('opacity-40');
            const order = Array.from(listEl.querySelectorAll('li[data-pipeline-id]')).map(
                (li) => (li as HTMLElement).dataset.pipelineId!,
            );
            draggingPipelineEl = null;
            currentDropGroupKey = null;
            void persistPipelineDrop(order, movedId, newGroupKey);
        }
    };
}

const ICON_CHEVRON_RIGHT = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="m9 18 6-6-6-6"/></svg>`;
const ICON_CHEVRON_DOWN = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="m6 9 6 6 6-6"/></svg>`;

// A group's aggregate status: the input half is the worst input status among
// its member pipelines, the output half is the same good/warn/error/off
// aggregation a single pipeline row already applies to its own outputs, just
// combined across every member's outputs. Collapsed, the header shows that
// swatch plus ok/warn/error/off counts of the members' outputs, the same counts
// a pipeline row shows for its own — the whole point of collapsing is keeping
// health visible without expanding. Expanded, the header shows just the name
// since the member rows underneath already show their own status individually.
function renderGroupHeader(
    group: PipelineGroup,
    members: PipelineView[],
    collapsed: boolean,
): string {
    let inSt: InputStatus = 'off';
    for (const p of members) inSt = worstStatus(inSt, inputStatus(p.input));
    const outs = tallyStatuses(members.flatMap((p) => p.outs.map((o) => outStatus(o, p.input))));
    const outSt: OutStatus = worstOfTally(outs);
    const inColor = statusColor(inSt);
    const outColor = statusColor(outSt);

    const summary = collapsed
        ? `<div class="rounded-box h-5 w-5 shrink-0" style="background-image:${splitDotGradient(inColor, outColor)}"></div>
           ${statusBadge(outs.good, 'badge-success')}
           ${statusBadge(outs.warn, 'badge-warning')}
           ${statusBadge(outs.error, 'badge-error')}
           ${statusBadge(outs.off, 'badge-ghost')}`
        : '';

    // Rename and delete show on hover or keyboard focus. A touch screen has no hover and
    // is for looking, not configuring, so it never shows them.
    const actionClass =
        'btn btn-xs btn-square btn-ghost opacity-0 focus-visible:opacity-100 group-hover/group:opacity-100 [@media(hover:none)]:hidden';
    const name = escapeHtml(group.name);

    return `<li data-group-id="${group.id}">
        <div class="group/group flex items-center gap-2 cursor-pointer js-toggle-group font-semibold opacity-90" data-group-id="${group.id}">
            ${collapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN}
            ${summary}
            <span class="js-group-drag-handle cursor-grab truncate min-w-0" draggable="true" title="Drag to reorder">${name}</span>
            <div class="flex items-center gap-1 ml-auto shrink-0">
                <button class="${actionClass} js-edit-group" data-group-id="${group.id}" title="Rename group" aria-label="Rename group ${name}">${ICON_PENCIL}</button>
                <button class="${actionClass} hover:text-error js-delete-group" data-group-id="${group.id}" title="Delete group" aria-label="Delete group ${name}">${ICON_TRASH}</button>
            </div>
        </div>
    </li>`;
}

// ── Pipeline info (middle column) ─────────────────────

function renderOverview(): void {
    const overviewEl = document.getElementById('overview-col');
    if (!overviewEl) return;

    const td = (val: string | number | null | undefined): string =>
        `<td class="tabular-nums text-xs">${val ?? '—'}</td>`;

    // One "Stream specification" cell replaces the separate V.Codec/Resolution/FPS/Scan/
    // A.Codec/Ch/Sample Rate columns (protocol has its own Type column). Multiple audio
    // tracks stack as extra lines within the same cell instead of extra table rows.
    const streamSpec = (
        video: Parameters<typeof videoSpec>[0],
        audioTracks: AudioTrackInfo[] | null,
        fallbackAudio: Parameters<typeof audioSpecLines>[1],
    ): string => {
        const vSpec = videoSpec(video);
        const audioLines = audioSpecLines(audioTracks, fallbackAudio);
        if (!vSpec && audioLines.length === 0) return '—';
        if (audioLines.length === 0) return vSpec || '—';
        return [vSpec, ...audioLines].filter(Boolean).join('<br>');
    };

    const typeBadge = (protocol: string | null): string =>
        protocol ? `<span class="badge badge-sm badge-outline">${protocol}</span>` : '—';

    const statusBg = (error: boolean, warn: boolean): string =>
        error
            ? 'style="background:color-mix(in oklab, var(--dot-bad) 12%, transparent)"'
            : warn
              ? 'style="background:color-mix(in oklab, var(--dot-warn) 12%, transparent)"'
              : '';

    const model = buildOverviewModel({
        pipelines: state.pipelines,
        metrics: state.metrics,
        relayProcessRunning: state.health.srtRelay?.status === 'running',
        nowMs: healthNowMs(),
        filter: state.overviewFilter,
        inputSearch: state.inputSearch,
        outputSearch: state.outputSearch,
    });
    const activeOnly = state.overviewFilter === 'active';
    const problemsOnly = state.overviewFilter === 'problems';

    // A table with no row to draw shows the sentence its model gives instead.
    const emptyRow = (colspan: number, message: string): string =>
        `<tr><td colspan="${colspan}" class="py-4 text-center text-muted">${escapeHtml(message)}</td></tr>`;
    const tableRows = <Row>(
        table: OverviewTable<Row>,
        colspan: number,
        draw: (row: Row) => string,
    ): string =>
        table.rows.length > 0
            ? table.rows.map(draw).join('')
            : table.empty
              ? emptyRow(colspan, table.empty)
              : '';

    const legCells = (leg: SrtBondingLeg | null): string => {
        if (!leg)
            return `${td(null)}${td(null)}${td(null)}${td(null)}${td(null)}${td(null)}${td(null)}`;
        const color = legHealthColor(leg);
        const health = legHealthLabel(leg);
        const title = leg.healthReason ?? `Transport state: ${leg.state}`;
        const legFigure = recentFigure(leg.recent, false);
        return `
            <td title="${escapeHtml(title)}"><span class="inline-flex items-center gap-1"><span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style="background:${color}"></span>${health}<span class="text-muted">(${escapeHtml(leg.state)})</span></span></td>
            <td class="font-mono text-xs">${escapeHtml(leg.ip)}</td>
            <td class="tabular-nums text-xs${legFigure.quiet ? ' opacity-50' : ''}" title="${escapeHtml(legFigure.title)}">${legFigure.text}</td>
            <td class="tabular-nums text-xs">${fmtMs(leg.rttMs)}</td>
            <td class="tabular-nums text-xs">${fmtMbpsValue(leg.recvRateMbps)}</td>
            <td class="tabular-nums text-xs">${fmtMs(leg.rcvBufMs)}</td>
            <td class="tabular-nums text-xs">${fmtMs(leg.latencyMs)}</td>`;
    };

    // ── Goryu ───────────────────────────────
    const relayRows = tableRows(model.relay, 13, ({ pipeline: p, relay }) => {
        const inputSt = relay.input;
        const outputSt = relay.output;
        const rowWarn = inputSt === 'warn' || outputSt === 'warn';
        const rowError = inputSt === 'error' || outputSt === 'error';
        const legs = p.srtBonding.input.legs;
        const rowspan = legs.length > 1 ? ` rowspan="${legs.length}"` : '';
        const rowAttr = `class="hover" ${statusBg(rowError, rowWarn)}`;
        const aggregateStatsAreDropOnly = inputAggregateStatsAreDropOnly(p.srtBonding.input);
        const sharedCells = `
            <td class="font-semibold cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}"${rowspan}>${escapeHtml(p.name)}</td>
            <td${rowspan}>${overviewStatusBadge(inputSt)}</td>
            <td${rowspan}>${overviewStatusBadge(outputSt)}</td>
            <td${rowspan}>${renderOverviewIssues(relayIssueList(relay))}</td>
            <td class="tabular-nums text-xs"${rowspan}>${p.input.live ? formatUptime(p.input.uptimeMs) : '—'}</td>`;
        const inputFigure = recentFigure(p.srtBonding.input.recent, aggregateStatsAreDropOnly);
        const inputFigureClass = inputFigure.dropped
            ? ' text-warning font-semibold'
            : inputFigure.quiet
              ? ' opacity-50'
              : '';
        const totalsCells = `
            <td class="tabular-nums text-xs${inputFigureClass}" title="${escapeHtml(inputFigure.title)}"${rowspan}>${inputFigure.text}</td>`;

        if (legs.length > 1) {
            return legs
                .map(
                    (leg, i) =>
                        `<tr ${rowAttr}>${i === 0 ? sharedCells : ''}${i === 0 ? totalsCells : ''}${legCells(leg)}</tr>`,
                )
                .join('');
        }
        return `<tr ${rowAttr}>${sharedCells}${totalsCells}${legCells(legs[0] ?? null)}</tr>`;
    });

    // ── Inputs ────────────────────────────────────────────
    const inputRows = tableRows(
        model.inputs,
        7,
        ({ pipeline: p, status: st, affectedOutputs: affected }) => {
            const inp = p.input;
            const isWarn = st === 'warn' || affected > 0;
            const isError = st === 'error';
            const protocolLabel = inp.connected
                ? p.srtBonding.acceptedBySrs
                    ? relayTypeLabel(p)
                    : inp.isSrt
                      ? 'SRT'
                      : 'RTMP'
                : null;
            const audioTracks = inp.audioTracks.length > 0 ? inp.audioTracks : null;
            const spec = streamSpec(inp.video, audioTracks, inp.audio);
            return `<tr class="hover" ${statusBg(isError, isWarn)}>
                <td class="overview-name-col font-semibold cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}">${escapeHtml(p.name)}</td>
                <td>${overviewStatusBadge(st)}</td>
                <td>${renderOverviewIssues(affected > 0 ? [{ severity: 'warning', message: `No publisher is connected; ${affected} output${affected === 1 ? '' : 's'} affected.` }] : inputIssues(inp))}</td>
                <td class="tabular-nums text-xs">${inp.live ? formatUptime(inp.uptimeMs) : '—'}</td>
                <td class="tabular-nums text-xs">${inp.connected ? formatBitrate(displayInputBitrateKbps(inp)) : '—'}</td>
                <td>${typeBadge(protocolLabel)}</td>
                <td class="font-mono text-xs">${spec}</td>
            </tr>`;
        },
    );

    // ── Outputs ───────────────────────────────────────────
    const outputRows = tableRows(model.outputs, 9, ({ pipeline: p, output: o, status: st }) => {
        const isOn = o.status === 'running';
        const media = isOn ? deriveOutputMedia(p.input, o) : null;
        const outUptimeMs = o.startedAtMs !== null ? Date.now() - o.startedAtMs : null;
        const errorBadge =
            o.failures > 0
                ? `<span class="text-error inline-flex items-center align-middle" title="${o.failures} error${o.failures === 1 ? '' : 's'} since this output was last started">${ICON_ERROR}</span>`
                : '';
        const protocolLabel = o.url ? (o.url.startsWith('srt://') ? 'SRT' : 'RTMP') : null;
        const spec = streamSpec(media?.video ?? null, null, media?.audio ?? null);
        return `<tr class="hover" ${statusBg(st === 'error', st === 'warn')}>
            <td class="overview-name-col cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}" title="${escapeHtml(o.name)}"><span class="text-muted text-xs">${escapeHtml(p.name)} ·</span> ${escapeHtml(formatOutputName(o.name))} ${errorBadge}</td>
            <td>${overviewStatusBadge(st)}</td>
            <td>${renderOverviewIssues(outputIssues(o, p.input))}</td>
            <td class="tabular-nums text-xs">${outUptimeMs !== null ? formatUptime(outUptimeMs) : '—'}</td>
            ${td(formatBitrate(o.bitrateKbps))}
            <td class="tabular-nums text-xs">${o.cpuPercent != null ? formatCpuPercent(o.cpuPercent) : '—'}</td>
            <td class="tabular-nums text-xs ${memorySeverityClass(outputMemoryPercent(o))}">${formatOutputMemory(o) ?? '—'}</td>
            <td>${typeBadge(protocolLabel)}</td>
            <td class="font-mono text-xs">${spec}</td>
        </tr>`;
    });

    // ── Shared encodes ────────────────────────────────────
    const encodeRows = tableRows(
        model.sharedEncodes,
        9,
        ({ pipeline: p, output: r, status: st }) => {
            const media = r.status === 'running' ? deriveOutputMedia(p.input, r) : null;
            const uptimeMs = r.startedAtMs !== null ? Date.now() - r.startedAtMs : null;
            const errorBadge =
                r.failures > 0
                    ? `<span class="text-error inline-flex items-center align-middle" title="${r.failures} error${r.failures === 1 ? '' : 's'} since this encode was last started">${ICON_ERROR}</span>`
                    : '';
            return `<tr class="hover" ${statusBg(st === 'error', st === 'warn')}>
            <td class="overview-name-col cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}"><span class="text-muted text-xs">${escapeHtml(p.name)} ·</span> ${escapeHtml(sharedEncodeLabel(r))} ${errorBadge}</td>
            <td>${overviewStatusBadge(st)}</td>
            <td>${renderOverviewIssues(outputIssues(r, p.input))}</td>
            <td class="tabular-nums text-xs">${uptimeMs !== null ? formatUptime(uptimeMs) : '—'}</td>
            ${td(formatBitrate(r.bitrateKbps))}
            <td class="tabular-nums text-xs">${r.cpuPercent != null ? formatCpuPercent(r.cpuPercent) : '—'}</td>
            <td class="tabular-nums text-xs ${memorySeverityClass(outputMemoryPercent(r))}">${formatOutputMemory(r) ?? '—'}</td>
            <td class="tabular-nums text-xs">${sharedEncodeUsage(r)}</td>
            <td class="font-mono text-xs">${streamSpec(media?.video ?? null, null, media?.audio ?? null)}</td>
        </tr>`;
        },
    );

    const thead = (cols: string[]) =>
        `<thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;

    const offset = state.chartOffsetMs;
    const windowEnd = Date.now() - offset;
    const windowStart = windowEnd - CHART_WINDOW_MS;
    const chartSamples = state.metricsHistory.filter(
        (s) => s.ts >= windowStart && s.ts <= windowEnd,
    );
    const last = chartSamples[chartSamples.length - 1];
    const fmtBps = (bps: number) => formatBitrate((bps * 8) / 1000);

    const oldest = state.metricsHistory[0];
    const maxOffset = oldest ? Math.max(0, Date.now() - oldest.ts - CHART_WINDOW_MS) : 0;
    const atLive = offset === 0;
    const atStart = offset >= maxOffset && maxOffset > 0;

    const rangeLabel = `<span class="inline-flex justify-center w-28">${
        atLive
            ? `<span class="badge badge-success badge-xs gap-1">LIVE</span>`
            : `<span class="tabular-nums text-xs text-muted">${formatClockTime(windowStart)} – ${formatClockTime(windowEnd)}</span>`
    }</span>`;

    const chartsHtml = `
    <div class="mb-2 flex items-center justify-center gap-2 px-1">
        <button id="chart-back" class="btn btn-xs btn-ghost" ${atStart || maxOffset === 0 ? 'disabled' : ''}>&#8592; 10 min</button>
        ${rangeLabel}
        <button id="chart-fwd" class="btn btn-xs btn-ghost" ${atLive ? 'disabled' : ''}>10 min &#8594;</button>
    </div>
    <div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        ${chartCard('chart-cpu', 'CPU', last ? `${last.cpu}%` : '—')}
        ${chartCard('chart-ram', 'RAM', last ? `${Math.round((last.ramUsed / last.ramTotal) * 100)}%` : '—')}
        ${chartCard('chart-rx', 'Downlink', last ? fmtBps(last.rxBps) : '—')}
        ${chartCard('chart-tx', 'Uplink', last ? fmtBps(last.txBps) : '—')}
    </div>`;

    const usage = model.usage;
    const fmtProcCpu = (percent: number | null): string =>
        percent == null ? '—' : formatCpuPercent(percent);
    const fmtProcRam = (bytes: number | null): string => (bytes != null ? formatBytes(bytes) : '—');
    const appColTitle =
        'App = node + SRS + relay + every running ffmpeg output and shared encode (downlink: SRS direct inputs + SRT relay links; uplink: every running ffmpeg output).';
    const systemColTitle = 'System = whole-machine usage, including processes outside Bunryu.';
    const cpuRowTitle = 'CPU is relative to one core: 100% = one full core, so it can exceed 100%.';
    const downlinkRowTitle =
        'Per process: SRS = publishers sending directly to SRS; Relay = SRT links pulled in by the relay.';
    const uplinkRowTitle =
        'Per process: Outs = every running ffmpeg output pushing to a destination (CPU and RAM also count shared encodes).';
    const cell = (value: string, title = ''): string =>
        `<td class="tabular-nums text-xs"${title ? ` title="${title}"` : ''}>${value}</td>`;
    const usageCells = (row: UsageRow, fmt: (value: number | null) => string): string =>
        cell(fmt(row.node)) +
        cell(fmt(row.srs)) +
        cell(fmt(row.relay)) +
        cell(fmt(row.outs)) +
        cell(fmt(row.app), appColTitle) +
        cell(fmt(row.system), systemColTitle);

    const systemUsageHtml = `
    <div class="overflow-x-auto mb-6">
        <table class="table table-sm">
            <thead>
                <tr>
                    <th class="tabular-nums text-xs font-normal text-muted" title="How long the dashboard process has been running">${usage.uptimeSeconds != null ? `Up ${formatUptime(usage.uptimeSeconds * 1000)}` : ''}</th>
                    <th>Node</th>
                    <th>SRS</th>
                    <th>Relay</th>
                    <th>Outs</th>
                    <th title="${appColTitle}">App total</th>
                    <th title="${systemColTitle}">System</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td class="text-xs text-muted" title="${cpuRowTitle}">CPU</td>
                    ${usageCells(usage.cpuPercent, fmtProcCpu)}
                </tr>
                <tr>
                    <td class="text-xs text-muted">RAM</td>
                    ${usageCells(usage.ramBytes, fmtProcRam)}
                </tr>
                <tr>
                    <td class="text-xs text-muted" title="${downlinkRowTitle}">Downlink ↓</td>
                    ${usageCells(usage.downlinkKbps, formatBitrate)}
                </tr>
                <tr>
                    <td class="text-xs text-muted" title="${uplinkRowTitle}">Uplink ↑</td>
                    ${usageCells(usage.uplinkKbps, formatBitrate)}
                </tr>
            </tbody>
        </table>
    </div>`;

    const filterChips = `
    <div role="tablist" class="tabs tabs-lift mb-4">
        <a role="tab" id="ov-filter-all" aria-selected="${state.overviewFilter === 'all'}" class="tab gap-1 ${state.overviewFilter === 'all' ? 'tab-active' : ''}">
            All
            <span class="badge badge-xs badge-ghost">${model.totals.all}</span>
        </a>
        <a role="tab" id="ov-filter-active" aria-selected="${activeOnly}" class="tab gap-1 ${activeOnly ? 'tab-active' : ''}">
            Active
            <span class="badge badge-xs badge-ghost">${model.totals.active}</span>
        </a>
        <a role="tab" id="ov-filter-problems" aria-selected="${problemsOnly}" class="tab gap-1 ${problemsOnly ? 'tab-active' : ''}">
            Issues
            <span class="badge badge-xs badge-ghost">${model.totals.problems}</span>
        </a>
    </div>`;

    // No relay pipelines at all: omit the section instead of an empty table. A
    // filter that merely hides every row keeps it, so its message still shows.
    const relaySectionHtml =
        model.relay.total === 0
            ? ''
            : `
        <h2 class="mb-2 text-lg font-bold">SRT Relay <span class="badge badge-neutral badge-sm ml-1">${model.relay.total}</span></h2>
        <div class="overflow-x-auto mb-6">
            <table class="table table-sm table-relay">
                ${thead(['Pipeline', 'Input', 'Output', 'Issues', 'Uptime', '<span title="Over the last 10 minutes. Bonded group inputs show the packets still missing after the legs backed each other up (Drop); non-bonded inputs show Loss / Rexmit / Drop">In L / R / D <span class="font-normal text-muted">10 min</span></span>', 'State', model.relay.legIpHeader, '<span title="Loss / Rexmit / Drop on this link over the last 10 minutes">L / R / D <span class="font-normal text-muted">10 min</span></span>', 'RTT', 'Rate', 'Buffer', 'Latency'])}
                <tbody>${relayRows}</tbody>
            </table>
        </div>`;

    // No shared encodes at all: omit the section, like the SRT Relay's. The Outputs search
    // box filters it too, so it has none of its own.
    const encodesSectionHtml =
        model.sharedEncodes.total === 0
            ? ''
            : `
        <h2 class="mt-6 mb-2 text-lg font-bold">Shared encodes <span class="badge badge-neutral badge-sm ml-1">${countLabel(model.sharedEncodes.rows.length, model.sharedEncodes.total)}</span></h2>
        <div class="overflow-x-auto">
            <table class="table table-sm">
                ${thead(['Pipeline · Encode', 'Status', 'Issues', 'Uptime', 'Bitrate', 'CPU', 'RAM', 'Used by', 'Stream Specification'])}
                <tbody>${encodeRows}</tbody>
            </table>
        </div>`;

    // The whole Overview is rebuilt on every refresh, so a search box being typed in
    // would lose focus and caret: remember them and put them back afterwards.
    const focused = document.activeElement;
    const typingIn =
        focused instanceof HTMLInputElement && overviewEl.contains(focused) && focused.id
            ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd }
            : null;

    setHtmlKeepScroll(
        overviewEl,
        `
        ${chartsHtml}
        ${systemUsageHtml}
        ${filterChips}
        ${relaySectionHtml}
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-lg font-bold">Inputs <span class="badge badge-neutral badge-sm ml-1">${countLabel(model.inputs.rows.length, model.inputs.total)}</span></h2>
            ${searchBoxHtml('ov-search-inputs', 'Search by name, key or URL', state.inputSearch)}
        </div>
        <div class="overflow-x-auto mb-6">
            <table class="table table-sm">
                ${thead(['Pipeline', 'Status', 'Issues', 'Uptime', 'Bitrate', 'Type', 'Stream Specification'])}
                <tbody>${inputRows}</tbody>
            </table>
        </div>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-lg font-bold">Outputs <span class="badge badge-neutral badge-sm ml-1">${countLabel(model.outputs.rows.length, model.outputs.total)}</span></h2>
            ${searchBoxHtml('ov-search-outputs', 'Search by name or URL', state.outputSearch)}
        </div>
        <div class="overflow-x-auto">
            <table class="table table-sm">
                ${thead(['Pipeline · Output', 'Status', 'Issues', 'Uptime', 'Bitrate', 'CPU', 'RAM', 'Type', 'Stream Specification'])}
                <tbody>${outputRows}</tbody>
            </table>
        </div>
        ${encodesSectionHtml}`,
    );

    if (typingIn) {
        const box = document.getElementById(typingIn.id);
        if (box instanceof HTMLInputElement) {
            box.focus();
            box.setSelectionRange(typingIn.start, typingIn.end);
        }
    }

    const fmtPct = (v: number) => `${Math.round(v)}%`;
    drawChart('chart-cpu', chartSamples, (s) => s.cpu, 100, 'var(--chart-cpu)', fmtPct);
    drawChart(
        'chart-ram',
        chartSamples,
        (s) => (s.ramUsed / s.ramTotal) * 100,
        100,
        'var(--chart-ram)',
        fmtPct,
    );
    // kbps with a 10 kbps floor, so an idle host still gets distinct tick labels.
    drawChart(
        'chart-rx',
        chartSamples,
        (s) => (s.rxBps * 8) / 1000,
        10,
        'var(--chart-rx)',
        formatBitrateAxis,
    );
    drawChart(
        'chart-tx',
        chartSamples,
        (s) => (s.txBps * 8) / 1000,
        10,
        'var(--chart-tx)',
        formatBitrateAxis,
    );

    document.getElementById('chart-back')?.addEventListener('click', () => {
        state.chartOffsetMs = Math.min(state.chartOffsetMs + CHART_SCROLL_STEP_MS, maxOffset);
        renderOverview();
    });
    document.getElementById('chart-fwd')?.addEventListener('click', () => {
        state.chartOffsetMs = Math.max(0, state.chartOffsetMs - CHART_SCROLL_STEP_MS);
        renderOverview();
    });
    document.getElementById('ov-filter-all')?.addEventListener('click', () => {
        state.overviewFilter = 'all';
        renderOverview();
    });
    document.getElementById('ov-filter-active')?.addEventListener('click', () => {
        state.overviewFilter = 'active';
        renderOverview();
    });
    document.getElementById('ov-filter-problems')?.addEventListener('click', () => {
        state.overviewFilter = 'problems';
        renderOverview();
    });
    // Search boxes filter their own table by name as you type. Text being composed
    // (an IME) is applied when the composition ends, since a re-render would break it.
    const wireSearch = (id: string, apply: (value: string) => void): void => {
        const box = document.getElementById(id);
        if (!(box instanceof HTMLInputElement)) return;
        const update = (): void => {
            apply(box.value);
            renderOverview();
        };
        box.addEventListener('input', (e) => {
            if (!(e as InputEvent).isComposing) update();
        });
        box.addEventListener('compositionend', update);
    };
    wireSearch('ov-search-inputs', (value) => {
        state.inputSearch = value;
    });
    wireSearch('ov-search-outputs', (value) => {
        state.outputSearch = value;
    });
    // Assignment (not addEventListener) since overviewEl itself persists across
    // renders while its contents are fully replaced above — addEventListener
    // would stack a new listener on every render.
    overviewEl.onclick = (e) => {
        const cell = (e.target as Element).closest('.js-select-pipeline') as HTMLElement | null;
        if (cell?.dataset.id) window.selectPipeline(cell.dataset.id);
    };
}

// Disables the SRT passphrase Reset button while the server would refuse it, and says
// why. Runs on every poll of the settings view: it only touches this button and hint.
export function renderSrtPassphraseReset(): void {
    const btn = document.getElementById('reset-srt-passphrase-btn') as HTMLButtonElement | null;
    const hint = document.getElementById('reset-srt-passphrase-hint');
    if (!btn || !hint) return;
    const block = srtPassphraseResetBlock(state.health);
    btn.disabled = block !== null;
    hint.textContent =
        block ??
        'A new one applies after the server or container restarts, and it can only be reset while nothing is live or running.';
}

function renderPipelineInfo(selectedId: string | null): void {
    const pipeline = selectedId ? state.pipelines.find((p) => p.id === selectedId) : null;
    const col = document.getElementById('pipe-info-col');
    const outsCol = document.getElementById('outs-col');
    const overviewCol = document.getElementById('overview-col');
    const logsCol = document.getElementById('srs-logs-col');
    const settingsCol = document.getElementById('settings-col');
    const statusCol = document.getElementById('status-col');
    const view = getUrlParam('view');
    const inLogsView = view === 'logs';
    const inSettingsView = view === 'settings';
    const inStatusView = view === 'status';
    // `hidden` and `flex` together: the Status panel is a flex column when shown.
    statusCol?.classList.toggle('hidden', !inStatusView);
    statusCol?.classList.toggle('flex', inStatusView);
    // The Status view has the whole width: the pipeline list goes, and the panels' column
    // (a wrapper between md and xl) takes the full row.
    document.getElementById('pipelines-col')?.classList.toggle('hidden', inStatusView);
    document.getElementById('main-panels')?.classList.toggle('md:col-span-full', inStatusView);

    // Logs/Settings content is populated once on navigation (see
    // dashboard-entry.ts), not on every poll — re-rendering here would wipe out
    // in-progress edits (e.g. a half-typed password) every 5 seconds.
    if (inLogsView) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.add('hidden');
        settingsCol?.classList.add('hidden');
        logsCol?.classList.remove('hidden');
        return;
    }

    if (inSettingsView) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.add('hidden');
        logsCol?.classList.add('hidden');
        settingsCol?.classList.remove('hidden');
        renderSrtPassphraseReset();
        return;
    }

    if (inStatusView) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.add('hidden');
        logsCol?.classList.add('hidden');
        settingsCol?.classList.add('hidden');
        renderStatusView();
        return;
    }

    if (!pipeline) {
        col?.classList.add('hidden');
        outsCol?.classList.add('hidden');
        overviewCol?.classList.remove('hidden');
        logsCol?.classList.add('hidden');
        settingsCol?.classList.add('hidden');
        renderOverview();
        return;
    }

    overviewCol?.classList.add('hidden');
    logsCol?.classList.add('hidden');
    settingsCol?.classList.add('hidden');

    col?.classList.remove('hidden');
    outsCol?.classList.remove('hidden');

    setInnerText('pipe-name', pipeline.name);
    const readersBadge = document.getElementById('pipe-readers-badge');
    if (readersBadge) {
        readersBadge.textContent = `${pipeline.input.readers} reader${pipeline.input.readers === 1 ? '' : 's'}`;
        readersBadge.classList.toggle('hidden', !pipeline.input.connected);
    }
    const hasActiveOutputs = pipeline.outs.some((o) => o.desiredState !== 'stopped');
    const deleteBtn = document.getElementById('pipe-delete-btn');
    deleteBtn?.classList.toggle('btn-disabled', hasActiveOutputs);
    deleteBtn?.classList.toggle('opacity-40', hasActiveOutputs);
    if (deleteBtn) deleteBtn.title = hasActiveOutputs ? 'Stop all outputs before deleting' : '';

    const statsContainer = document.getElementById('input-stats-container');
    const statsEl = document.getElementById('input-stats');
    const inputHtml = renderInputStats(pipeline.input, {
        sourceIp: relaySourceIp(pipeline),
        directSrt: pipeline.input.isSrt && !pipeline.srtBonding.acceptedBySrs,
        relayPort: state.health.srtRelay?.port,
    });
    if (statsContainer) statsContainer.classList.toggle('hidden', !pipeline.input.connected);
    if (statsEl) statsEl.innerHTML = inputHtml;
    renderSharedEncodes(pipeline, {
        ffmpegHealth: (rendition) => outputHealth(rendition, pipeline.input, false),
        inputHealth,
    });
    const bondingCard = document.getElementById('srt-bonding-card');
    const bondingDot = document.getElementById('srt-bonding-status-dot');
    const bondingDotFill = document.getElementById('srt-bonding-status-fill');
    const bondingTooltipContent = document.getElementById('srt-bonding-status-tooltip-content');
    const bondingStats = document.getElementById('srt-bonding-stats');
    const bondingLegs = document.getElementById('srt-bonding-legs');
    const bondingErrWrap = document.getElementById('srt-bonding-last-error-wrap');
    const bondingErrTs = document.getElementById('srt-bonding-last-error-ts');
    const bondingErr = document.getElementById('srt-bonding-last-error');
    const bondingHistoryBtn = document.getElementById(
        'srt-bonding-history-btn',
    ) as HTMLButtonElement | null;
    const bondingInputActive = pipeline.srtBonding.inputActive;
    const bondingOutputConnected = pipeline.srtBonding.outputConnected;
    const hasActiveBondingConnection = bondingInputActive || bondingOutputConnected;
    const relayProcessRunning = state.health.srtRelay?.status === 'running';
    const bondingHost = state.config.publicHost || 'localhost';
    const bondingPortValue = state.health.srtRelay?.port ?? 10081;
    const bondingStreamId = `#!::r=live/${pipeline.streamKey},m=publish`;
    const relayUrlTail =
        `&streamid=${bondingStreamId}` +
        (state.config.srtPassphrase
            ? `&passphrase=${encodeURIComponent(state.config.srtPassphrase)}&pbkeylen=16`
            : '');
    const relayUrlBase = `srt://${bondingHost}:${bondingPortValue}?mode=caller`;
    const bondingDetailsToggle = document.getElementById(
        'srt-bonding-details-toggle',
    ) as HTMLButtonElement | null;
    bondingDetailsToggle?.classList.toggle('hidden', !hasActiveBondingConnection);
    if (bondingDetailsToggle) {
        bondingDetailsToggle.onclick = () =>
            void import('../features/srt-bonding-details.js').then((ed) =>
                ed.showSrtBondingDetails(pipeline.id),
            );
    }
    renderPublishCard(pipeline, {
        passphrase: state.config.srtPassphrase || '',
        relayPort: bondingPortValue,
        relayUrl: relayUrlBase + relayUrlTail,
        relayBondedUrl: `${relayUrlBase}&grouptype=broadcast${relayUrlTail}`,
    });
    // Shown whenever relay input is arriving, whichever Publish mode is selected.
    bondingCard?.classList.toggle('hidden', !bondingInputActive);
    bondingCard?.classList.remove('text-muted');
    if (bondingDot && bondingDotFill) {
        const indicator = getBondingIndicator(pipeline, relayProcessRunning);
        bondingDotFill.style.backgroundColor = 'transparent';
        bondingDotFill.style.backgroundImage = splitDotGradient(
            indicator.leftColor,
            indicator.rightColor,
        );
        if (bondingTooltipContent) bondingTooltipContent.innerHTML = indicator.tooltip;
    }
    if (bondingStats) {
        bondingStats.innerHTML = renderBondingStats(pipeline.srtBonding, relayProcessRunning);
    }
    if (bondingLegs) {
        setHtmlKeepScroll(bondingLegs, renderBondedLegs(pipeline.srtBonding.input));
    }
    if (bondingErrWrap && bondingErr && bondingErrTs) {
        const msg = pipeline.srtBonding.lastError;
        const currentError = hasCurrentRelayError(pipeline.srtBonding);
        const lastErrorLine = msg
            ? (msg
                  .split('\n')
                  .filter((l) => l.trim())
                  .slice(-1)[0] ?? '')
            : '';
        bondingErrWrap.classList.toggle('hidden', !currentError);
        const errorAt = pipeline.srtBonding.lastErrorAt;
        bondingErrTs.textContent = errorAt ? formatAgo(errorAt, healthNowMs()) : '';
        bondingErrTs.title = errorAt ? formatLocalDateTime(errorAt) : '';
        bondingErr.textContent = lastErrorLine;
        // Always there once the relay has recorded an error; red only while it is unresolved.
        if (bondingHistoryBtn) {
            bondingHistoryBtn.classList.toggle('hidden', !msg);
            bondingHistoryBtn.classList.toggle('text-error', currentError);
            bondingHistoryBtn.onclick = () => {
                void import('../features/editor.js').then((ed) => ed.showRelayError(pipeline.id));
            };
        }
    }

    void import('../features/srt-bonding-details.js').then((ed) =>
        ed.refreshSrtBondingDetailsModal(pipeline.id),
    );

    renderPreview(pipeline);
    renderOutputsList(pipeline);
}

// ── Publish card ──────────────────────────────────────

const ICON_COPY = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

const ICON_EYE = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EYE_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path d="m3 3 18 18"/></svg>`;

// The mode each pipeline's card shows. It follows the encoder: when the live mode
// changes the card switches to it, and until then a mode picked by hand stays.
const publishModeChoice = new Map<string, PublishMode>();
const publishModeLive = new Map<string, PublishMode | null>();
let publishCopyValues: string[] = [];
let publishCardWired = false;
let publishCardPipelineId: string | null = null;
// Secret rows revealed with the eye button, until the time given.
const PUBLISH_REVEAL_MS = 15_000;
const publishRevealUntil = new Map<string, number>();

function renderPublishCard(
    pipeline: PipelineView,
    relay: { passphrase: string; relayPort: number; relayUrl: string; relayBondedUrl: string },
): PublishMode {
    publishCardPipelineId = pipeline.id;
    const live = livePublishMode(pipeline);
    if (live && live !== publishModeLive.get(pipeline.id)) publishModeChoice.set(pipeline.id, live);
    publishModeLive.set(pipeline.id, live);
    const mode = publishModeChoice.get(pipeline.id) ?? 'rtmp';

    const modesEl = document.getElementById('publish-modes');
    const rowsEl = document.getElementById('publish-rows');
    if (!modesEl || !rowsEl) return mode;
    if (!publishCardWired) {
        publishCardWired = true;
        modesEl.addEventListener('click', (e) => {
            const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
            if (!btn || !publishCardPipelineId) return;
            publishModeChoice.set(publishCardPipelineId, btn.dataset.mode as PublishMode);
            renderPipelineInfo(publishCardPipelineId);
        });
        rowsEl.addEventListener('click', (e) => {
            const eye = (e.target as HTMLElement).closest<HTMLElement>('[data-reveal]');
            if (eye && publishCardPipelineId) {
                const rowKey = `${publishCardPipelineId}:${eye.dataset.reveal}`;
                const open = (publishRevealUntil.get(rowKey) ?? 0) > Date.now();
                if (open) publishRevealUntil.delete(rowKey);
                else {
                    publishRevealUntil.set(rowKey, Date.now() + PUBLISH_REVEAL_MS);
                    const id = publishCardPipelineId;
                    setTimeout(() => renderPipelineInfo(id), PUBLISH_REVEAL_MS + 50);
                }
                renderPipelineInfo(publishCardPipelineId);
                return;
            }
            const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-copy-idx]');
            const value = btn ? publishCopyValues[Number(btn.dataset.copyIdx)] : undefined;
            if (value !== undefined) void copyText(value);
        });
    }

    setHtmlKeepScroll(
        modesEl,
        PUBLISH_MODES.map(({ mode: m, label }) => {
            const dot =
                m === live
                    ? `<div aria-label="live" class="status mr-1 shrink-0" style="background-color: ${STATUS_COLOR_GOOD}"></div>`
                    : '';
            return `<button type="button" role="tab" aria-selected="${m === mode}" data-mode="${m}" class="btn btn-xs join-item ${m === mode ? 'btn-accent btn-soft' : ''}">${dot}${label}</button>`;
        }).join(''),
    );

    const rows = publishRows(mode, {
        rtmpUrl: pipeline.rtmpPublishUrl,
        srtUrl: pipeline.srtPublishUrl,
        streamKey: pipeline.streamKey,
        ...relay,
    });
    publishCopyValues = rows.map((r) => r.value);
    setHtmlKeepScroll(
        rowsEl,
        rows
            .map((r, i) => {
                const rowKey = `${pipeline.id}:${mode}:${r.label}`;
                const revealed = r.secret && (publishRevealUntil.get(rowKey) ?? 0) > Date.now();
                const text = revealed ? r.value : r.shown;
                const title = r.secret ? '' : ` title="${escapeHtml(r.shown)}"`;
                const eye = r.secret
                    ? `<button type="button" data-reveal="${mode}:${r.label}" class="btn btn-xs btn-ghost btn-square shrink-0" title="${revealed ? 'Hide' : 'Show'} ${r.label.toLowerCase()} for ${PUBLISH_REVEAL_MS / 1000} s" aria-label="${revealed ? 'Hide' : 'Show'} ${r.label.toLowerCase()}" aria-pressed="${revealed}">${revealed ? ICON_EYE_OFF : ICON_EYE}</button>`
                    : '';
                return `<div class="flex min-w-0 items-center gap-2">
                    <span class="w-28 shrink-0 text-xs text-muted">${r.label}</span>
                    <code class="min-w-0 flex-1 truncate text-xs"${title}>${escapeHtml(text)}</code>${eye}
                    <button type="button" data-copy-idx="${i}" class="btn btn-xs btn-square ${r.primary ? 'btn-accent' : 'btn-ghost'} btn-outline shrink-0" title="Copy ${r.label.toLowerCase()}" aria-label="Copy ${r.label.toLowerCase()}">${ICON_COPY}</button>
                </div>`;
            })
            .join(''),
    );
    return mode;
}

// ── Outputs list (right column) ───────────────────────

const ICON_WARN = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;
const ICON_CROSS = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
const ICON_ERROR = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;

function renderOutputsList(pipeline: PipelineView): void {
    const listEl = document.getElementById('outputs-list');
    if (!listEl) return;
    if (draggingOutputEl) return; // preserve the DOM while a drag is in progress

    const hasActive = pipeline.outs.some((o) => o.desiredState !== 'stopped');
    const noStopped =
        pipeline.outs.length === 0 || pipeline.outs.every((o) => o.desiredState !== 'stopped');
    const allStopped =
        pipeline.outs.length === 0 || pipeline.outs.every((o) => o.desiredState === 'stopped');

    const pasteBtn = document.getElementById('outputs-paste-btn') as HTMLButtonElement | null;
    pasteBtn?.classList.toggle('btn-disabled', hasActive);
    pasteBtn?.classList.toggle('opacity-40', hasActive);
    if (pasteBtn) {
        pasteBtn.disabled = hasActive;
        pasteBtn.title = hasActive
            ? 'Stop all outputs before pasting'
            : 'Paste outputs from clipboard';
    }

    const startAllBtn = document.getElementById(
        'outputs-start-all-btn',
    ) as HTMLButtonElement | null;
    startAllBtn?.classList.toggle('btn-disabled', noStopped);
    startAllBtn?.classList.toggle('opacity-40', noStopped);
    if (startAllBtn) startAllBtn.disabled = noStopped;

    const stopAllBtn = document.getElementById('outputs-stop-all-btn') as HTMLButtonElement | null;
    stopAllBtn?.classList.toggle('btn-disabled', allStopped);
    stopAllBtn?.classList.toggle('opacity-40', allStopped);
    if (stopAllBtn) stopAllBtn.disabled = allStopped;

    // The filter belongs to one pipeline: selecting another starts unfiltered.
    if (outputsListPipelineId !== pipeline.id) {
        outputsListPipelineId = pipeline.id;
        state.outputsListSearch = '';
        state.outputsListProblemsOnly = false;
    }
    const toolbar = document.getElementById('outputs-toolbar');
    toolbar?.classList.toggle('hidden', pipeline.outs.length === 0);
    toolbar?.classList.toggle('flex', pipeline.outs.length > 0);

    if (pipeline.outs.length === 0) {
        listEl.innerHTML = '<p class="text-sm text-muted">No outputs yet.</p>';
        return;
    }

    // Clear pending state once the output's actual status has settled into the
    // desired state (or for outputs that no longer exist, e.g. deleted).
    const presentIds = new Set(pipeline.outs.map((o) => o.id));
    for (const id of pendingOutputs.keys()) {
        if (!presentIds.has(id)) pendingOutputs.delete(id);
    }
    for (const o of pipeline.outs) {
        const action = pendingOutputs.get(o.id);
        if (!action) continue;
        const settled =
            (action === 'start' && o.desiredState === 'running') ||
            (action === 'stop' && o.desiredState === 'stopped');
        if (settled) pendingOutputs.delete(o.id);
    }

    // Build a URL → [{pipelineName, outputName}] map across all pipelines to detect duplicates.
    const urlRefs = new Map<string, DupRef[]>();
    for (const p of state.pipelines) {
        for (const o of p.outs) {
            if (o.url) {
                const list = urlRefs.get(o.url) ?? [];
                list.push({ pipelineName: p.name, outputName: o.name, outputId: o.id });
                urlRefs.set(o.url, list);
            }
        }
    }
    const dupUrls = new Map<string, DupRef[]>();
    for (const [url, refs] of urlRefs) {
        if (refs.length > 1) dupUrls.set(url, refs);
    }

    const rows = pipeline.outs.map((output) => {
        const status = outStatus(output, pipeline.input);
        return {
            output,
            status,
            severity: outputSeverity(output, pipeline.input, dupUrls),
        };
    });
    const { outputsListSearch: query, outputsListProblemsOnly: problemsOnly } = state;
    const visible = rows.filter((row) =>
        matchesOutputFilter(row.output, row.severity, query, problemsOnly),
    );
    outputsListFiltered = visible.length !== rows.length || query.trim() !== '' || problemsOnly;

    const searchBox = document.getElementById('outputs-search') as HTMLInputElement | null;
    if (searchBox && searchBox.value !== query) searchBox.value = query;
    const problemsBtn = document.getElementById('outputs-problems-btn');
    problemsBtn?.classList.toggle('btn-primary', problemsOnly);
    problemsBtn?.classList.toggle('btn-outline', !problemsOnly);
    problemsBtn?.setAttribute('aria-pressed', String(problemsOnly));
    const summary = document.getElementById('outputs-summary');
    if (summary) {
        summary.innerHTML = outputSummaryHtml(
            countOutputs(
                rows.map(({ output, severity }) => ({
                    severity,
                    stopped: output.desiredState === 'stopped',
                })),
            ),
            visible.length,
            rows.length,
        );
    }

    listEl.innerHTML =
        visible.length === 0
            ? `<p class="text-sm text-muted">${escapeHtml(noMatchingOutputsText(query, problemsOnly))}</p>`
            : visible
                  .map(({ output }) =>
                      renderOutputCard(output, pipeline.input, dupUrls, { pendingOutputs }),
                  )
                  .join('');

    listEl.onclick = (e) => {
        const btn = (e.target as Element).closest('[data-action]') as HTMLButtonElement | null;
        if (!btn || btn.disabled || btn.classList.contains('btn-disabled')) return;
        const action = btn.dataset.action!;
        const outId = btn.dataset.outId!;
        if (action === 'start' || action === 'stop') {
            pendingOutputs.set(outId, action);
            btn.disabled = true;
        }
        void import('../features/editor.js').then((ed) => {
            if (action === 'start') void ed.startOutput(pipeline.id, outId);
            else if (action === 'stop') void ed.stopOutput(pipeline.id, outId);
            else if (action === 'edit') ed.openEditOutput(pipeline.id, outId);
            else if (action === 'delete') void ed.confirmDeleteOutput(pipeline.id, outId);
            else if (action === 'error-info') void ed.showOutputError(pipeline.id, outId);
        });
    };

    listEl.ondragstart = (e) => {
        const target = e.target as Element;
        const card = target.closest('[data-output-card]') as HTMLElement | null;
        if (outputsListFiltered || !target.closest('.js-output-drag-handle') || !card) {
            e.preventDefault();
            return;
        }
        draggingOutputEl = card;
        card.classList.add('opacity-40');
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', card.dataset.outputCard!);
        e.dataTransfer!.setDragImage(card, 12, 12);
    };

    listEl.ondragover = (e) => {
        if (!draggingOutputEl) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        const overCard = (e.target as Element).closest('[data-output-card]') as HTMLElement | null;
        if (!overCard || overCard === draggingOutputEl) return;
        const rect = overCard.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        overCard.parentElement?.insertBefore(
            draggingOutputEl,
            before ? overCard : overCard.nextElementSibling,
        );
    };

    listEl.ondrop = (e) => e.preventDefault();

    listEl.ondragend = () => {
        if (!draggingOutputEl) return;
        draggingOutputEl.classList.remove('opacity-40');
        draggingOutputEl = null;
        const order = Array.from(listEl.querySelectorAll('[data-output-card]')).map(
            (el) => (el as HTMLElement).dataset.outputCard!,
        );
        void persistOutputOrder(pipeline.id, order);
    };
}

// The Outputs list's filter box and "Problems only" toggle.
export function setOutputsListFilter(change: { search?: string; problemsOnly?: boolean }): void {
    if (change.search !== undefined) state.outputsListSearch = change.search;
    if (change.problemsOnly !== undefined) state.outputsListProblemsOnly = change.problemsOnly;
    const pipeline = state.pipelines.find((p) => p.id === getUrlParam('p'));
    if (pipeline) renderOutputsList(pipeline);
}

// ── Entry point ───────────────────────────────────────

export function renderMetrics(): void {
    renderMetricsView({ setMetricSeverity });
}

export function renderPipelines(): void {
    const selectedId = getUrlParam('p');
    const view = getUrlParam('view');
    const overviewBtn = document.getElementById('overview-nav-btn');
    overviewBtn?.classList.toggle(
        'btn-active',
        !view && !state.pipelines.some((p) => p.id === selectedId),
    );
    const statusBtn = document.getElementById('status-nav-btn');
    statusBtn?.classList.toggle('btn-active', view === 'status');
    const logsBtn = document.getElementById('srs-logs-nav-btn');
    logsBtn?.classList.toggle('btn-active', view === 'logs');
    const settingsBtn = document.getElementById('settings-nav-btn');
    settingsBtn?.classList.toggle('btn-active', view === 'settings');
    renderPipelineList();
    renderRejectedPublishes();
    renderPipelineInfo(selectedId);
}

// Publish/play attempts SRS refused (key with no pipeline, unrecognized name, or
// a play request from an encoder whose SRT stream id lacks m=publish). Shown apart
// from the pipeline list (below a divider) so it is clear these are not
// pipelines and nothing is being forwarded — an encoder on such a key can look
// healthy on its own side. Hidden when there is nothing recent.
function renderRejectedPublishes(): void {
    const el = document.getElementById('rejected-publishes');
    if (!el) return;
    const rejected = state.rejectedPublishes;
    el.classList.toggle('hidden', rejected.length === 0);
    if (rejected.length === 0) {
        el.innerHTML = '';
        return;
    }
    const rows = rejected
        .map((r) => {
            const via = rejectedVia(r);
            const why = rejectedWhy(r);
            const playBadge =
                r.kind === 'play'
                    ? `<span class="badge badge-sm badge-warning badge-outline shrink-0">Play request</span>`
                    : '';
            const streamsBadge =
                r.reason === 'unrecognized'
                    ? `<span class="badge badge-sm badge-ghost shrink-0" title="Distinct unrecognized stream names combined in this row">${r.streams}${r.streamsCapped ? '+' : ''} stream${r.streams === 1 && !r.streamsCapped ? '' : 's'}</span>`
                    : '';
            const recent = r.lastAttemptAgoMs < 60_000;
            return `<li class="flex flex-col gap-1 py-1.5 ${recent ? '' : 'opacity-50'}">
                <div class="flex items-center gap-2">
                    <span class="js-tooltip text-warning shrink-0 inline-flex" tabindex="0">${ICON_WARN}<div class="js-tooltip-content hidden"><div class="text-sm">${escapeHtml(why)}. Nothing is being forwarded.</div></div></span>
                    <span class="font-mono text-sm">${r.reason === 'unrecognized' ? 'Unrecognized' : escapeHtml(r.label)}</span>
                    <span class="badge badge-sm badge-outline shrink-0">${r.protocol === 'srt' ? 'SRT' : 'RTMP'}</span>
                    ${playBadge}
                    <span class="min-w-0 truncate text-xs text-muted" title="${escapeHtml(via)}">${escapeHtml(via)}</span>
                </div>
                <div class="flex items-center gap-2 pl-5">
                    ${streamsBadge}
                    <span class="badge badge-sm badge-error shrink-0 gap-1 px-2" title="${r.attempts} rejected attempt${r.attempts === 1 ? '' : 's'}">${ICON_CROSS}${r.attempts}</span>
                    <span class="tabular-nums text-xs text-muted">${formatUptime(r.lastAttemptAgoMs)} ago</span>
                </div>
            </li>`;
        })
        .join('');
    el.innerHTML = `<div class="border-base-content/10 border-t pt-2">
        <div class="text-xs font-bold uppercase text-muted">Rejected publish attempts</div>
        <div class="mb-1 text-xs text-muted">Not pipelines — nothing here is being forwarded</div>
        <ul>${rows}</ul>
        ${state.rejectedOmitted > 0 ? `<div class="text-xs text-muted">+${state.rejectedOmitted} more</div>` : ''}
    </div>`;
}

// ── Hover tooltips ────────────────────────────────────
//
// Status circles live inside columns with overflow-y-auto (for scrolling long
// pipeline/output lists), which clips any absolutely-positioned popup that
// tries to overflow the column's edge — the popup would show as scroll-clipped
// or blend into the column background instead of floating over neighboring
// columns. Rather than positioning content in place, we reparent the hovered
// element's `.js-tooltip-content` into a single fixed-position portal (see
// #hover-tooltip in index.html) that lives outside all scroll containers, and
// position that portal from the trigger's viewport rect. Trigger elements are
// re-rendered constantly (innerHTML swaps), so this is wired once via
// delegation on `document` rather than per-element listeners.
function initHoverTooltips(): void {
    const portal = document.getElementById('hover-tooltip');
    if (!portal) return;
    let activeTrigger: Element | null = null;

    // A popover, so it shows above an open modal dialog (the SRT bonding details have
    // tooltips of their own); a dialog's top layer would otherwise cover it.
    const hide = (): void => {
        try {
            portal.hidePopover?.();
        } catch {
            /* already hidden */
        }
        portal.classList.add('hidden');
        activeTrigger = null;
    };

    const show = (trigger: Element, content: Element): void => {
        if (!content.innerHTML.trim()) return;
        portal.innerHTML = content.innerHTML;
        portal.classList.remove('hidden');
        try {
            portal.showPopover?.();
        } catch {
            /* already showing */
        }
        const rect = trigger.getBoundingClientRect();
        const pw = portal.offsetWidth;
        const ph = portal.offsetHeight;
        let left = rect.right + 8;
        if (left + pw > window.innerWidth - 8) left = rect.left - pw - 8;
        left = Math.max(8, left);
        const top = Math.max(
            8,
            Math.min(rect.top + rect.height / 2 - ph / 2, window.innerHeight - ph - 8),
        );
        portal.style.left = `${left}px`;
        portal.style.top = `${top}px`;
        activeTrigger = trigger;
    };

    document.addEventListener('mouseover', (e) => {
        const trigger = (e.target as Element | null)?.closest?.('.js-tooltip');
        if (!trigger || trigger === activeTrigger) return;
        const content = trigger.querySelector(':scope > .js-tooltip-content');
        if (!content) return;
        show(trigger, content);
    });

    document.addEventListener('mouseout', (e) => {
        const trigger = (e.target as Element | null)?.closest?.('.js-tooltip');
        if (!trigger || trigger !== activeTrigger) return;
        const related = (e as MouseEvent).relatedTarget as Node | null;
        if (related && trigger.contains(related)) return;
        hide();
    });

    // Pipeline/output lists re-render on every poll by swapping innerHTML,
    // which can detach the currently-hovered trigger without ever firing a
    // mouseout — leaving the portal stuck open with stale content. Catch that
    // by checking connectivity whenever the DOM churns.
    new MutationObserver(() => {
        if (activeTrigger && !activeTrigger.isConnected) hide();
    }).observe(document.body, { childList: true, subtree: true });
}

initHoverTooltips();
