import {
    setInnerText,
    setBadgeCount,
    escapeHtml,
    formatBitrate,
    formatBytes,
    formatCpuPercent,
    formatBitrateAxis,
    getUrlParam,
    fmtMs,
    fmtMbpsValue,
    formatClockTime,
    setHtmlKeepScroll,
    LOW_BITRATE_KBPS,
    STATUS_COLOR_GOOD,
    STATUS_COLOR_WARN,
    STATUS_COLOR_ERROR,
    STATUS_COLOR_OFF,
} from '../core/utils.js';
import { healthNowMs, saveCollapsedGroups, state } from '../core/state.js';
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
    SrtBondingInputStatus,
    VideoInfo,
} from '../types.js';
import { updateLayoutOrder, updatePipeline, updatePipelineGroups } from '../core/api.js';
import { dupTooltip, formatOutputName, renderOutputCard, type DupRef } from './output-card.js';
import { outputStatusCounts } from './output-badges.js';
import { renderSharedEncodes, sharedEncodeIssue } from './shared-encodes.js';
import { renderBondedLegs, renderBondingStats } from './srt-bonding-view.js';
import { audioSpecLines, videoSpec } from '../core/media-spec.js';
import { alertHint } from '../core/hints.js';
import { INPUT_ALERT_CODES } from '../core/pipeline.js';
import {
    affectedOutputCount,
    countLabel,
    matchesName,
    noMatchRowHtml,
    searchBoxHtml,
} from '../core/overview-filter.js';
import { CHART_SCROLL_STEP_MS, CHART_WINDOW_MS, chartCard, drawChart } from './dashboard-charts.js';
import {
    formatUptime,
    inputStatusMessage,
    renderCompactMetaRow,
    renderInputStats,
} from './input-stats-view.js';
import { renderMetrics as renderMetricsView, renderPreview } from './metrics-view.js';

declare global {
    interface Window {
        selectPipeline: (id: string | null) => void;
    }
}

type OutStatus = 'good' | 'warn' | 'error' | 'off';
type InputStatus = 'good' | 'warn' | 'error' | 'off';
const STATUS_RANK: Record<OutStatus, number> = { error: 3, warn: 2, good: 1, off: 0 };
function worstStatus(a: OutStatus, b: OutStatus): OutStatus {
    return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}
function statusColor(st: OutStatus): string {
    if (st === 'good') return STATUS_COLOR_GOOD;
    if (st === 'warn') return STATUS_COLOR_WARN;
    if (st === 'error') return STATUS_COLOR_ERROR;
    return STATUS_COLOR_OFF;
}
function statusBadge(n: number, cls: string): string {
    return n > 0 ? `<div class="badge badge-sm ${cls} px-2">${n}</div>` : '';
}
type OverviewIssue = {
    severity: 'warning' | 'error';
    message: string;
    // What to do about it, when known (see core/hints.ts).
    hint?: string;
    // When it began, for an issue that is still going on.
    sinceMs?: number;
};
type BondingIndicator = {
    leftColor: string;
    rightColor: string;
    issues: OverviewIssue[];
    offMessage: string | null;
};
type RelayFlowStatus = 'good' | 'warn' | 'error' | 'off';

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
const RELAY_FLOW_STALE_MS = 15000;
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
// replace (same endpoint Settings uses), keeping each group's id/name and
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

function formatCompactCount(n: number): string {
    if (!Number.isFinite(n)) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
    return String(Math.round(n));
}

function fmtLossRexmitDrop(
    loss: number | null | undefined,
    rexmit: number | null | undefined,
    drop: number | null | undefined,
): string {
    return `${loss != null ? formatCompactCount(loss) : '—'} / ${rexmit != null ? formatCompactCount(rexmit) : '—'} / ${drop != null ? formatCompactCount(drop) : '—'}`;
}

function inputAggregateStatsAreDropOnly(input: SrtBondingInputStatus): boolean {
    return input.recvLossTotal === null && input.retransTotal === null;
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
function hasCurrentOutputError(o: OutputView): boolean {
    if (o.lastError === null || o.lastErrorAt === null) return false;
    if (o.startedAtMs === null) return o.failures > 0;
    return o.lastErrorAt >= o.startedAtMs;
}

// SRS reports a zero receive bitrate until its rolling bitrate statistics are
// populated. Do not turn that startup placeholder into a low-bitrate warning.
const INPUT_BITRATE_STATS_WARMUP_MS = 30_000;

function inputBitrateStatsReady(input: InputHealth): boolean {
    return input.uptimeMs !== null && input.uptimeMs >= INPUT_BITRATE_STATS_WARMUP_MS;
}

function displayInputBitrateKbps(input: InputHealth): number | null {
    if (input.live && input.recvBitrateKbps === 0 && !inputBitrateStatsReady(input)) {
        return null;
    }
    return input.recvBitrateKbps;
}

interface OutputHealth {
    status: OutStatus;
    issues: OverviewIssue[];
}

interface DerivedInputHealth {
    status: InputStatus;
    issues: OverviewIssue[];
}

function outputHealth(o: OutputView, input: InputHealth): OutputHealth {
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
        if (!input.live) {
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
        if (o.bitrateKbps === null && hasCurrentOutputError(o)) {
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
    if (hasCurrentOutputError(o)) {
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

function outStatus(o: OutputView, input: InputHealth): OutStatus {
    return outputHealth(o, input).status;
}

function inputHealth(input: InputHealth): DerivedInputHealth {
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

    const issues: OverviewIssue[] = [];
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

function inputStatus(input: InputHealth): InputStatus {
    return inputHealth(input).status;
}

function inputStatusColor(input: InputHealth): string {
    const st = inputStatus(input);
    if (st === 'good') return STATUS_COLOR_GOOD;
    if (st === 'warn') return STATUS_COLOR_WARN;
    if (st === 'error') return STATUS_COLOR_ERROR;
    return STATUS_COLOR_OFF;
}

function overviewStatusBadge(st: InputStatus | OutStatus): string {
    if (st === 'error') return '<span class="badge badge-sm badge-error">ERROR</span>';
    if (st === 'warn') return '<span class="badge badge-sm badge-warning">WARNING</span>';
    if (st === 'off') return '<span class="font-mono text-xs opacity-40">—</span>';
    return '<span class="badge badge-sm badge-success">OK</span>';
}

function issueLinesHtml(issues: OverviewIssue[]): string {
    return issues
        .map((issue) => {
            const cls = issue.severity === 'error' ? 'text-error' : 'text-warning';
            const hint = issue.hint
                ? `<div class="text-xs leading-snug opacity-60">Hint: ${escapeHtml(issue.hint)}</div>`
                : '';
            const since = issue.sinceMs
                ? ` <span class="opacity-60">since ${formatClockTime(issue.sinceMs)}</span>`
                : '';
            return `<div class="${cls} text-xs leading-snug">${escapeHtml(issue.message)}${since}</div>${hint}`;
        })
        .join('');
}

function renderOverviewIssues(issues: OverviewIssue[]): string {
    if (issues.length === 0) return '<span class="opacity-40">—</span>';
    return issueLinesHtml(issues);
}

// Content for a `.js-tooltip-content` popup: one colored line per issue (error/warning),
// or a single muted line when there's nothing wrong but a status is still worth explaining.
function renderIssueTooltip(issues: OverviewIssue[], offMessage?: string | null): string {
    if (issues.length > 0) return issueLinesHtml(issues);
    if (offMessage) {
        return `<div class="text-xs leading-snug opacity-70">${escapeHtml(offMessage)}</div>`;
    }
    return '';
}

function inputIssues(input: InputHealth): OverviewIssue[] {
    return inputHealth(input).issues;
}

function summarizeOutputError(error: string | null | undefined, fallback: string): string {
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

function relayIssues(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
    inputSt: RelayFlowStatus,
    outputSt: RelayFlowStatus,
): OverviewIssue[] {
    const issues: OverviewIssue[] = [];
    for (const alert of pipeline.alerts) {
        // The leg-specific version below includes the address and the precise
        // reason, so avoid showing per-leg alerts twice in the combined list.
        if (alert.code === 'bonded-leg-no-flow' || alert.code === 'bonded-leg-quality') {
            continue;
        }
        // Input alerts are shown with the input (see inputHealth).
        if (INPUT_ALERT_CODES.has(alert.code)) continue;
        issues.push({
            severity: alert.severity,
            message: alert.message,
            hint: alertHint(alert.code) ?? undefined,
            sinceMs: alert.sinceMs,
        });
    }
    const inputSeverity = inputSt === 'error' ? 'error' : 'warning';
    const outputSeverity = outputSt === 'error' ? 'error' : 'warning';

    if (inputSt === 'warn' || inputSt === 'error') {
        for (const reason of relayInputReasons(pipeline, relayProcessRunning)) {
            issues.push({ severity: inputSeverity, message: `Input: ${reason}` });
        }
    }
    if (outputSt === 'warn' || outputSt === 'error') {
        for (const reason of relayOutputReasons(pipeline, relayProcessRunning)) {
            issues.push({
                severity: outputSeverity,
                message: `Output: ${summarizeOutputError(reason, reason)}`,
            });
        }
    }

    return issues;
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
function downLegCount(pipeline: PipelineView): number {
    const { bonded, legs, expectedLegs } = pipeline.srtBonding.input;
    return bonded ? Math.max(0, expectedLegs - legs.length) : 0;
}

function flowStatusColor(status: RelayFlowStatus): string {
    if (status === 'good') return STATUS_COLOR_GOOD;
    if (status === 'warn') return STATUS_COLOR_WARN;
    if (status === 'error') return STATUS_COLOR_ERROR;
    return STATUS_COLOR_OFF;
}

// Every independent problem on the input (upstream encoder → relay) side,
// collected rather than short-circuited on the first match — a leg outage and
// a stalled feed are unrelated causes and both deserve to show up in the
// tooltip instead of one hiding the other.
function relayInputReasons(pipeline: PipelineView, relayProcessRunning: boolean): string[] {
    if (!relayProcessRunning || !pipeline.srtBonding.inputActive) return [];
    const { bonded, legs, expectedLegs } = pipeline.srtBonding.input;
    const down = downLegCount(pipeline);
    const reasons: string[] = [];

    for (const leg of legs) {
        if (leg.health && leg.health !== 'ok' && leg.healthReason) {
            reasons.push(`${bonded ? 'Leg ' : 'Input '}${leg.ip}: ${leg.healthReason}`);
        }
    }

    if (bonded) {
        if (legs.length === 0) reasons.push('No bonded legs reporting');
        else if (down > 0) reasons.push(`${down} of ${expectedLegs} bonded legs down`);
        else if (legs.length === 1) reasons.push('Only 1 leg connected — no redundancy');
    }

    if (!relayHasRecentInputFlow(pipeline)) {
        reasons.push('No input packets received recently');
    }

    return reasons;
}

// Same collect-don't-shortcircuit approach for the output (relay → SRS) side.
function relayOutputReasons(pipeline: PipelineView, relayProcessRunning: boolean): string[] {
    if (!relayProcessRunning || !pipeline.srtBonding.inputActive) return [];
    const { srtBonding } = pipeline;
    const reasons: string[] = [];

    if (srtBonding.publishConflict) {
        reasons.push(
            srtBonding.localSrtPublisherConflict
                ? 'A local pipeline output is already publishing to this stream key in SRS'
                : 'SRS is already using another publisher for this stream key',
        );
    }

    if (!srtBonding.outputConnected) {
        reasons.push(
            srtBonding.lastError
                ? `Relay output reconnecting: ${srtBonding.lastError}`
                : srtBonding.retryFailures > 0
                  ? `Relay output reconnecting (${srtBonding.retryFailures} retries)`
                  : 'Relay output reconnecting',
        );
    } else {
        if (!srtBonding.acceptedBySrs) {
            reasons.push('SRS has not reported this as the active pipeline input');
        }
        if (!relayHasRecentOutputFlow(pipeline)) {
            reasons.push(
                srtBonding.forwardedPackets > 0
                    ? 'Media forwarding to SRS has stalled'
                    : 'No media has been forwarded to SRS yet',
            );
        }
    }

    return reasons;
}

function getBondingIndicator(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
): BondingIndicator {
    if (!relayProcessRunning) {
        return {
            leftColor: STATUS_COLOR_OFF,
            rightColor: STATUS_COLOR_OFF,
            issues: [],
            offMessage: 'SRT relay is not running; relay SRT input unavailable',
        };
    }

    if (!pipeline.srtBonding.inputActive) {
        return {
            leftColor: STATUS_COLOR_OFF,
            rightColor: STATUS_COLOR_OFF,
            issues: [],
            offMessage: 'No relay SRT input for this stream key',
        };
    }

    const inputSt = relayInputStatus(pipeline, relayProcessRunning);
    const outputSt = relayOutputStatus(pipeline, relayProcessRunning);
    const issues = relayIssues(pipeline, relayProcessRunning, inputSt, outputSt);

    return {
        leftColor: flowStatusColor(inputSt),
        rightColor: flowStatusColor(outputSt),
        issues,
        offMessage:
            issues.length > 0
                ? null
                : `${pipeline.srtBonding.input.bonded ? 'Bonded SRT input' : 'SRT input via relay'} active and forwarding to downstream output`,
    };
}

function relayHasRecentInputFlow(pipeline: PipelineView): boolean {
    return (
        pipeline.srtBonding.lastInputPacketAt != null &&
        healthNowMs() - pipeline.srtBonding.lastInputPacketAt <= RELAY_FLOW_STALE_MS
    );
}

function relayHasRecentOutputFlow(pipeline: PipelineView): boolean {
    return (
        pipeline.srtBonding.lastPacketAt != null &&
        healthNowMs() - pipeline.srtBonding.lastPacketAt <= RELAY_FLOW_STALE_MS
    );
}

function relayInputStatus(pipeline: PipelineView, relayProcessRunning: boolean): RelayFlowStatus {
    if (!relayProcessRunning) return 'off';
    if (!pipeline.srtBonding.inputActive) return 'off';
    if (pipeline.srtBonding.input.legs.some((leg) => leg.health === 'error')) return 'error';
    if (pipeline.srtBonding.input.legs.some((leg) => leg.health === 'warn')) return 'warn';
    const { bonded, legs, expectedLegs } = pipeline.srtBonding.input;
    // A bonded group that had legs and has none left is a total input failure,
    // worse than reduced redundancy.
    if (bonded && legs.length === 0 && expectedLegs > 0) return 'error';
    if (!relayHasRecentInputFlow(pipeline)) return 'warn';
    // A plain input has no redundancy by design. A bonded group has it only while
    // it has two or more legs, and a leg that dropped out is redundancy lost.
    if (bonded && legs.length < Math.max(2, expectedLegs)) return 'warn';
    return 'good';
}

function relayOutputStatus(pipeline: PipelineView, relayProcessRunning: boolean): RelayFlowStatus {
    if (!relayProcessRunning) return 'off';
    if (!pipeline.srtBonding.inputActive) return 'off';
    if (pipeline.srtBonding.publishConflict) return 'error';
    if (!pipeline.srtBonding.outputConnected) return 'error';
    if (!pipeline.srtBonding.acceptedBySrs) return 'warn';
    return relayHasRecentOutputFlow(pipeline) ? 'good' : 'warn';
}

function legHealthColor(leg: SrtBondingLeg): string {
    if (leg.health === 'error') return STATUS_COLOR_ERROR;
    if (leg.health === 'warn') return STATUS_COLOR_WARN;
    return STATUS_COLOR_GOOD;
}

function legHealthLabel(leg: SrtBondingLeg): string {
    return (leg.health ?? (leg.state === 'running' ? 'ok' : 'warn')).toUpperCase();
}

function relayInputSeverityColor(
    pipeline: PipelineView,
    relayProcessRunning: boolean,
    inputColor: string,
): string {
    if (inputStatus(pipeline.input) !== 'good') return inputColor;

    const relayInput = relayInputStatus(pipeline, relayProcessRunning);
    const relayOutput = relayOutputStatus(pipeline, relayProcessRunning);
    if (relayInput === 'error' || relayOutput === 'error') return STATUS_COLOR_ERROR;
    if (relayInput === 'warn' || relayOutput === 'warn') return STATUS_COLOR_WARN;
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
        const outGood = p.outs.filter((o) => outStatus(o, p.input) === 'good').length;
        const outWarn = p.outs.filter((o) => outStatus(o, p.input) === 'warn').length;
        const outFailed = p.outs.filter((o) => outStatus(o, p.input) === 'error').length;
        const outOff = p.outs.filter((o) => outStatus(o, p.input) === 'off').length;

        const inColor = relayInputSeverityColor(p, relayProcessRunning, inputStatusColor(p.input));
        const outColor =
            outFailed > 0
                ? STATUS_COLOR_ERROR
                : outWarn > 0
                  ? STATUS_COLOR_WARN
                  : outGood > 0
                    ? STATUS_COLOR_GOOD
                    : STATUS_COLOR_OFF;
        const selected = p.id === selectedId ? 'bg-base-100' : '';
        const relayInputSt = relayInputStatus(p, relayProcessRunning);
        const relayOutputSt = relayOutputStatus(p, relayProcessRunning);
        const statusIssues: OverviewIssue[] = [
            ...inputIssues(p.input),
            ...p.outs.flatMap((o) =>
                outputIssues(o, p.input).map((issue) => ({
                    severity: issue.severity,
                    message: `${o.name}: ${issue.message}`,
                })),
            ),
            ...relayIssues(p, relayProcessRunning, relayInputSt, relayOutputSt),
        ];
        const statusTooltip = renderIssueTooltip(statusIssues);

        const uptimeSpan =
            p.input.live && p.input.uptimeMs !== null
                ? `<span class="font-mono text-xs opacity-60 shrink-0">${formatUptime(p.input.uptimeMs)}</span>`
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
                    <div class="rounded-box h-5 w-5" style="background:linear-gradient(90deg,${inColor},${inColor} 45%,#242933 45%,#242933 55%,${outColor} 55%)"></div>
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
    // configured in Settings, followed by ungrouped pipelines. A pipeline
    // whose group no longer exists (deleted in Settings) falls back to
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
    let outGood = 0;
    let outWarn = 0;
    let outFailed = 0;
    let outOff = 0;
    for (const p of members) {
        inSt = worstStatus(inSt, inputStatus(p.input));
        for (const o of p.outs) {
            const st = outStatus(o, p.input);
            if (st === 'good') outGood++;
            else if (st === 'warn') outWarn++;
            else if (st === 'error') outFailed++;
            else if (st === 'off') outOff++;
        }
    }
    const outSt: OutStatus =
        outFailed > 0 ? 'error' : outWarn > 0 ? 'warn' : outGood > 0 ? 'good' : 'off';
    const inColor = statusColor(inSt);
    const outColor = statusColor(outSt);

    const summary = collapsed
        ? `<div class="rounded-box h-5 w-5 shrink-0" style="background:linear-gradient(90deg,${inColor},${inColor} 45%,#242933 45%,#242933 55%,${outColor} 55%)"></div>
           ${statusBadge(outGood, 'badge-success')}
           ${statusBadge(outWarn, 'badge-warning')}
           ${statusBadge(outFailed, 'badge-error')}
           ${statusBadge(outOff, 'badge-ghost')}`
        : '';

    return `<li data-group-id="${group.id}">
        <div class="flex items-center gap-2 cursor-pointer js-toggle-group font-semibold opacity-90" data-group-id="${group.id}">
            ${collapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN}
            ${summary}
            <span class="js-group-drag-handle cursor-grab truncate min-w-0" draggable="true" title="Drag to reorder">${escapeHtml(group.name)}</span>
        </div>
    </li>`;
}

// ── Pipeline info (middle column) ─────────────────────

function renderOverview(): void {
    const overviewEl = document.getElementById('overview-col');
    if (!overviewEl) return;

    const td = (val: string | number | null | undefined): string =>
        `<td class="font-mono text-xs">${val ?? '—'}</td>`;

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
            ? 'style="background:color-mix(in oklch, var(--color-error) 15%, transparent)"'
            : warn
              ? 'style="background:color-mix(in oklch, var(--color-warning) 15%, transparent)"'
              : '';

    const totalOuts = state.pipelines.reduce((s, p) => s + p.outs.length, 0);
    const relayProcessRunning = state.health.srtRelay?.status === 'running';
    const activeOnly = state.overviewFilter === 'active';
    const problemsOnly = state.overviewFilter === 'problems';
    const isProblem = (st: string): boolean => st === 'warn' || st === 'error';
    const isOffline = (st: string): boolean => st === 'off';

    // ── Goryu ───────────────────────────────
    const activeRelayPipelines = state.pipelines.filter(
        (p) =>
            p.srtBonding.inputActive ||
            p.srtBonding.outputConnected ||
            p.srtBonding.forwardedPackets > 0 ||
            (p.srtBonding.input.recvPacketsTotal ?? 0) > 0 ||
            p.srtBonding.input.recvUniquePacketsTotal > 0 ||
            (p.srtBonding.input.retransTotal ?? 0) > 0 ||
            (p.srtBonding.input.recvLossTotal ?? 0) > 0 ||
            (p.srtBonding.input.recvDropTotal ?? 0) > 0,
    );
    const relayProblemCount = activeRelayPipelines.filter(
        (p) =>
            isProblem(relayInputStatus(p, relayProcessRunning)) ||
            isProblem(relayOutputStatus(p, relayProcessRunning)),
    ).length;
    const relayActiveCount = activeRelayPipelines.filter(
        (p) =>
            !isOffline(relayInputStatus(p, relayProcessRunning)) ||
            !isOffline(relayOutputStatus(p, relayProcessRunning)),
    ).length;
    const legCells = (leg: SrtBondingLeg | null): string => {
        if (!leg) return `${td(null)}${td(null)}${td(null)}${td(null)}${td(null)}${td(null)}`;
        const color = legHealthColor(leg);
        const health = legHealthLabel(leg);
        const title = leg.healthReason ?? `Transport state: ${leg.state}`;
        return `
            <td title="${escapeHtml(title)}"><span class="inline-flex items-center gap-1"><span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style="background:${color}"></span>${health}<span class="opacity-60">(${escapeHtml(leg.state)})</span></span></td>
            <td class="font-mono text-xs">${escapeHtml(leg.ip)}</td>
            <td class="font-mono text-xs">${fmtMs(leg.latencyMs)}</td>
            <td class="font-mono text-xs">${fmtMs(leg.rttMs)}</td>
            <td class="font-mono text-xs">${fmtMbpsValue(leg.recvRateMbps)}</td>
            <td class="font-mono text-xs" title="Loss / Rexmit / Drop">${fmtLossRexmitDrop(leg.recvLossTotal, leg.retransTotal, leg.recvDropTotal)}</td>`;
    };

    let relayRows = '';
    if (activeRelayPipelines.length > 0) {
        for (const p of activeRelayPipelines) {
            const inputSt = relayInputStatus(p, relayProcessRunning);
            const outputSt = relayOutputStatus(p, relayProcessRunning);
            const rowWarn = inputSt === 'warn' || outputSt === 'warn';
            const rowError = inputSt === 'error' || outputSt === 'error';
            if (problemsOnly && !rowWarn && !rowError) continue;
            if (activeOnly && isOffline(inputSt) && isOffline(outputSt)) continue;

            const legs = p.srtBonding.input.legs;
            const rowspan = legs.length > 1 ? ` rowspan="${legs.length}"` : '';
            const rowAttr = `class="hover" ${statusBg(rowError, rowWarn)}`;
            const aggregateStatsAreDropOnly = inputAggregateStatsAreDropOnly(p.srtBonding.input);
            const sharedCells = `
                <td class="font-semibold cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}"${rowspan}>${escapeHtml(p.name)}</td>
                <td${rowspan}>${overviewStatusBadge(inputSt)}</td>
                <td${rowspan}>${overviewStatusBadge(outputSt)}</td>
                <td${rowspan}>${renderOverviewIssues(relayIssues(p, relayProcessRunning, inputSt, outputSt))}</td>
                <td class="font-mono text-xs"${rowspan}>${p.input.live ? formatUptime(p.input.uptimeMs) : '—'}</td>`;
            const totalsCells = `
                <td class="font-mono text-xs" title="${aggregateStatsAreDropOnly ? 'Deduplicated drop packets on the bonded group input. Loss and receive retransmission are unavailable for the bonded aggregate.' : 'Loss / Rexmit / Drop on the input connection.'}"${rowspan}>${aggregateStatsAreDropOnly ? fmtLossRexmitDrop(null, null, p.srtBonding.input.recvDropTotal) : fmtLossRexmitDrop(p.srtBonding.input.recvLossTotal, p.srtBonding.input.retransTotal, p.srtBonding.input.recvDropTotal)}</td>`;

            if (legs.length > 1) {
                relayRows += legs
                    .map(
                        (leg, i) =>
                            `<tr ${rowAttr}>${i === 0 ? sharedCells : ''}${i === 0 ? totalsCells : ''}${legCells(leg)}</tr>`,
                    )
                    .join('');
            } else {
                relayRows += `<tr ${rowAttr}>${sharedCells}${totalsCells}${legCells(legs[0] ?? null)}</tr>`;
            }
        }
        if (problemsOnly && relayRows === '') {
            relayRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No relay issues.</td></tr>`;
        } else if (activeOnly && relayRows === '') {
            relayRows = `<tr><td colspan="12" class="py-4 text-center opacity-50">No active relay sessions.</td></tr>`;
        }
    }

    // ── Inputs ────────────────────────────────────────────
    // An input nobody publishes to is "off". With outputs in trouble because of it, it
    // is also an issue, so the Issues view lists the cause beside its affected outputs.
    const affectedOutputs = (p: PipelineView): number =>
        affectedOutputCount(
            inputStatus(p.input),
            p.outs.map((o) => outStatus(o, p.input)),
        );
    const inputProblemCount = state.pipelines.filter(
        (p) => isProblem(inputStatus(p.input)) || affectedOutputs(p) > 0,
    ).length;
    const inputActiveCount = state.pipelines.filter((p) => !isOffline(inputStatus(p.input))).length;
    let inputRows = '';
    let inputsShown = 0;
    if (state.pipelines.length === 0) {
        inputRows = `<tr><td colspan="7" class="py-4 text-center opacity-50">No pipelines yet.</td></tr>`;
    } else {
        for (const p of state.pipelines) {
            const inp = p.input;
            const st = inputStatus(inp);
            const affected = affectedOutputs(p);
            const isWarn = st === 'warn' || affected > 0;
            const isError = st === 'error';
            if (problemsOnly && !isWarn && !isError) continue;
            if (activeOnly && isOffline(st)) continue;
            if (!matchesName(state.inputSearch, p.name)) continue;
            inputsShown += 1;
            const protocolLabel = inp.connected
                ? p.srtBonding.acceptedBySrs
                    ? relayTypeLabel(p)
                    : inp.isSrt
                      ? 'SRT'
                      : 'RTMP'
                : null;
            const audioTracks = inp.audioTracks.length > 0 ? inp.audioTracks : null;
            const spec = streamSpec(inp.video, audioTracks, inp.audio);
            inputRows += `<tr class="hover" ${statusBg(isError, isWarn)}>
                <td class="overview-name-col font-semibold cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}">${escapeHtml(p.name)}</td>
                <td>${overviewStatusBadge(st)}</td>
                <td>${renderOverviewIssues(affected > 0 ? [{ severity: 'warning', message: `No publisher is connected; ${affected} output${affected === 1 ? '' : 's'} affected.` }] : inputIssues(inp))}</td>
                <td class="font-mono text-xs">${inp.live ? formatUptime(inp.uptimeMs) : '—'}</td>
                <td class="font-mono text-xs">${inp.connected ? formatBitrate(displayInputBitrateKbps(inp)) : '—'}</td>
                <td>${typeBadge(protocolLabel)}</td>
                <td class="font-mono text-xs">${spec}</td>
            </tr>`;
        }
        if (inputRows === '' && state.inputSearch.trim() !== '') {
            inputRows = noMatchRowHtml(7, 'inputs', state.inputSearch);
        } else if (problemsOnly && inputRows === '') {
            inputRows = `<tr><td colspan="7" class="py-4 text-center opacity-50">No input issues.</td></tr>`;
        } else if (activeOnly && inputRows === '') {
            inputRows = `<tr><td colspan="7" class="py-4 text-center opacity-50">No active inputs.</td></tr>`;
        }
    }

    // ── Outputs ───────────────────────────────────────────
    const outputProblemCount = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => isProblem(outStatus(o, p.input))).length,
        0,
    );
    const outputActiveCount = state.pipelines.reduce(
        (s, p) => s + p.outs.filter((o) => !isOffline(outStatus(o, p.input))).length,
        0,
    );
    let outputRows = '';
    let outputsShown = 0;
    if (totalOuts === 0) {
        outputRows = `<tr><td colspan="9" class="py-4 text-center opacity-50">No outputs yet.</td></tr>`;
    } else {
        for (const p of state.pipelines) {
            for (const o of p.outs) {
                const st = outStatus(o, p.input);
                if (problemsOnly && !isProblem(st)) continue;
                if (activeOnly && isOffline(st)) continue;
                if (!matchesName(state.outputSearch, p.name, o.name)) continue;
                outputsShown += 1;
                const badge = overviewStatusBadge(st);

                const isOn = o.status === 'running';
                const media = isOn ? deriveOutputMedia(p.input, o) : null;
                const outUptimeMs = o.startedAtMs !== null ? Date.now() - o.startedAtMs : null;
                const errorBadge =
                    o.failures > 0
                        ? `<span class="text-error inline-flex items-center align-middle" title="${o.failures} error${o.failures === 1 ? '' : 's'} since this output was last started">${ICON_ERROR}</span>`
                        : '';
                const protocolLabel = o.url ? (o.url.startsWith('srt://') ? 'SRT' : 'RTMP') : null;
                const spec = streamSpec(media?.video ?? null, null, media?.audio ?? null);
                outputRows += `<tr class="hover" ${statusBg(st === 'error', st === 'warn')}>
                    <td class="overview-name-col cursor-pointer hover:underline js-select-pipeline" data-id="${p.id}" title="${escapeHtml(o.name)}"><span class="opacity-40 text-xs">${escapeHtml(p.name)} ·</span> ${escapeHtml(formatOutputName(o.name))} ${errorBadge}</td>
                    <td>${badge}</td>
                    <td>${renderOverviewIssues(outputIssues(o, p.input))}</td>
                    <td class="font-mono text-xs">${outUptimeMs !== null ? formatUptime(outUptimeMs) : '—'}</td>
                    ${td(formatBitrate(o.bitrateKbps))}
                    <td class="font-mono text-xs">${o.cpuPercent != null ? formatCpuPercent(o.cpuPercent) : '—'}</td>
                    <td class="font-mono text-xs ${memorySeverityClass(outputMemoryPercent(o))}">${formatOutputMemory(o) ?? '—'}</td>
                    <td>${typeBadge(protocolLabel)}</td>
                    <td class="font-mono text-xs">${spec}</td>
                </tr>`;
            }
        }
        if (outputRows === '' && state.outputSearch.trim() !== '') {
            outputRows = noMatchRowHtml(9, 'outputs', state.outputSearch);
        } else if (problemsOnly && outputRows === '') {
            outputRows = `<tr><td colspan="9" class="py-4 text-center opacity-50">No output issues.</td></tr>`;
        } else if (activeOnly && outputRows === '') {
            outputRows = `<tr><td colspan="9" class="py-4 text-center opacity-50">No active outputs.</td></tr>`;
        }
    }

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
            : `<span class="font-mono text-xs opacity-60">${formatClockTime(windowStart)} – ${formatClockTime(windowEnd)}</span>`
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

    const m = state.metrics;
    const fmtProcCpu = (percent: number | null | undefined): string =>
        percent == null ? '—' : formatCpuPercent(percent);
    const fmtProcRam = (bytes: number | null | undefined): string =>
        bytes != null ? formatBytes(bytes) : '—';
    const isLoopbackHost = (host: string | null | undefined): boolean =>
        host === 'localhost' || host === '127.0.0.1';
    const outputHost = (url: string): string | null => {
        try {
            return new URL(url).hostname;
        } catch {
            return null;
        }
    };

    // Sum of every tracked process's own %CPU (single-core-relative — see
    // ProcCpuTracker) and RSS: node + SRS + relay + every running ffmpeg
    // output. Independent of the Issues/Active row filter below — this is
    // whole-system resource usage, not a count of displayed rows.
    let totalCpuPercent = 0;
    let totalCpuKnown = false;
    let totalRamBytes = 0;
    let totalRamKnown = false;
    let outsCpuPercent = 0;
    let outsCpuKnown = false;
    let outsRamBytes = 0;
    let outsRamKnown = false;
    const addCpu = (v: number | null | undefined): void => {
        if (v != null) {
            totalCpuPercent += v;
            totalCpuKnown = true;
        }
    };
    const addRam = (v: number | null | undefined): void => {
        if (v != null) {
            totalRamBytes += v;
            totalRamKnown = true;
        }
    };
    addCpu(m.node?.cpuPercent);
    addRam(m.node?.ramBytes);
    addCpu(m.srs?.cpuPercent);
    addRam(m.srs?.ramBytes);
    addCpu(m.relay?.cpuPercent);
    addRam(m.relay?.ramBytes);
    // Downlink is what SRS receives directly from publishers (excluding
    // loopback — those are locally fed by the relay or a chained pipeline
    // output) plus what Goryu pulls in across its bonded
    // legs. Uplink is what the ffmpeg outputs push out (excluding loopback
    // chaining into another pipeline).
    let srsDownlinkKbps = 0;
    let srsDownlinkKnown = false;
    let relayDownlinkKbps = 0;
    let relayDownlinkKnown = false;
    let outsUplinkKbps = 0;
    let outsUplinkKnown = false;
    for (const p of state.pipelines) {
        if (p.input.recvBitrateKbps != null && !isLoopbackHost(p.input.publisherIp)) {
            srsDownlinkKbps += p.input.recvBitrateKbps;
            srsDownlinkKnown = true;
        }
        for (const o of p.outs) {
            addCpu(o.cpuPercent);
            addRam(o.memoryUsageBytes);
            if (o.cpuPercent != null) {
                outsCpuPercent += o.cpuPercent;
                outsCpuKnown = true;
            }
            if (o.memoryUsageBytes != null) {
                outsRamBytes += o.memoryUsageBytes;
                outsRamKnown = true;
            }
            if (o.bitrateKbps != null && o.url && !isLoopbackHost(outputHost(o.url))) {
                outsUplinkKbps += o.bitrateKbps;
                outsUplinkKnown = true;
            }
        }
    }
    for (const p of activeRelayPipelines) {
        for (const leg of p.srtBonding.input.legs) {
            if (leg.recvRateMbps != null) {
                relayDownlinkKbps += leg.recvRateMbps * 1000;
                relayDownlinkKnown = true;
            }
        }
    }
    const totalDownlinkKbps = srsDownlinkKbps + relayDownlinkKbps;
    const totalDownlinkKnown = srsDownlinkKnown || relayDownlinkKnown;
    const totalUplinkKbps = outsUplinkKbps;
    const totalUplinkKnown = outsUplinkKnown;

    // m.cpu.percent is already normalized across all cores (0–100 = whole
    // machine). Scale it up to the same single-core-relative basis as the
    // per-process percentages above (100% = one core) so App and Total are
    // comparable.
    const sysCpuPercent = m.cpu ? m.cpu.percent * m.cpu.cores : null;
    const sysRamUsedBytes = m.ram?.usedBytes ?? null;
    const sysDownlinkKbps = m.net ? (m.net.rxBytesPerSec * 8) / 1000 : null;
    const sysUplinkKbps = m.net ? (m.net.txBytesPerSec * 8) / 1000 : null;
    const appColTitle =
        'App = node + SRS + relay + every running ffmpeg output (downlink: SRS direct inputs + SRT relay links; uplink: every running ffmpeg output).';
    const systemColTitle = 'System = whole-machine usage, including processes outside Bunryu.';
    const cpuRowTitle = 'CPU is relative to one core: 100% = one full core, so it can exceed 100%.';
    const downlinkRowTitle =
        'Per process: SRS = publishers sending directly to SRS; Relay = SRT links pulled in by the relay.';
    const uplinkRowTitle =
        'Per process: Outs = every running ffmpeg output pushing to a destination.';
    const cell = (value: string, title = ''): string =>
        `<td class="font-mono text-xs"${title ? ` title="${title}"` : ''}>${value}</td>`;

    const systemUsageHtml = `
    <div class="overflow-x-auto mb-6">
        <table class="table table-sm">
            <thead>
                <tr>
                    <th class="font-mono text-xs font-normal opacity-60" title="How long the dashboard process has been running">${m.uptimeSeconds != null ? `Up ${formatUptime(m.uptimeSeconds * 1000)}` : ''}</th>
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
                    <td class="text-xs opacity-60" title="${cpuRowTitle}">CPU</td>
                    ${cell(fmtProcCpu(m.node?.cpuPercent))}
                    ${cell(fmtProcCpu(m.srs?.cpuPercent))}
                    ${cell(fmtProcCpu(m.relay?.cpuPercent))}
                    ${cell(outsCpuKnown ? fmtProcCpu(outsCpuPercent) : '—')}
                    ${cell(totalCpuKnown ? fmtProcCpu(totalCpuPercent) : '—', appColTitle)}
                    ${cell(fmtProcCpu(sysCpuPercent), systemColTitle)}
                </tr>
                <tr>
                    <td class="text-xs opacity-60">RAM</td>
                    ${cell(fmtProcRam(m.node?.ramBytes))}
                    ${cell(fmtProcRam(m.srs?.ramBytes))}
                    ${cell(fmtProcRam(m.relay?.ramBytes))}
                    ${cell(outsRamKnown ? fmtProcRam(outsRamBytes) : '—')}
                    ${cell(totalRamKnown ? formatBytes(totalRamBytes) : '—', appColTitle)}
                    ${cell(fmtProcRam(sysRamUsedBytes), systemColTitle)}
                </tr>
                <tr>
                    <td class="text-xs opacity-60" title="${downlinkRowTitle}">Downlink ↓</td>
                    ${cell('—')}
                    ${cell(srsDownlinkKnown ? formatBitrate(srsDownlinkKbps) : '—')}
                    ${cell(relayDownlinkKnown ? formatBitrate(relayDownlinkKbps) : '—')}
                    ${cell('—')}
                    ${cell(totalDownlinkKnown ? formatBitrate(totalDownlinkKbps) : '—', appColTitle)}
                    ${cell(formatBitrate(sysDownlinkKbps), systemColTitle)}
                </tr>
                <tr>
                    <td class="text-xs opacity-60" title="${uplinkRowTitle}">Uplink ↑</td>
                    ${cell('—')}
                    ${cell('—')}
                    ${cell('—')}
                    ${cell(outsUplinkKnown ? formatBitrate(outsUplinkKbps) : '—')}
                    ${cell(totalUplinkKnown ? formatBitrate(totalUplinkKbps) : '—', appColTitle)}
                    ${cell(formatBitrate(sysUplinkKbps), systemColTitle)}
                </tr>
            </tbody>
        </table>
    </div>`;

    const totalAll = activeRelayPipelines.length + state.pipelines.length + totalOuts;
    const totalActive = relayActiveCount + inputActiveCount + outputActiveCount;
    const totalProblems = relayProblemCount + inputProblemCount + outputProblemCount;
    const filterChips = `
    <div role="tablist" class="tabs tabs-lift mb-4">
        <a role="tab" id="ov-filter-all" aria-selected="${state.overviewFilter === 'all'}" class="tab gap-1 ${state.overviewFilter === 'all' ? 'tab-active' : ''}">
            All
            <span class="badge badge-xs badge-ghost">${totalAll}</span>
        </a>
        <a role="tab" id="ov-filter-active" aria-selected="${activeOnly}" class="tab gap-1 ${activeOnly ? 'tab-active' : ''}">
            Active
            <span class="badge badge-xs badge-ghost">${totalActive}</span>
        </a>
        <a role="tab" id="ov-filter-problems" aria-selected="${problemsOnly}" class="tab gap-1 ${problemsOnly ? 'tab-active' : ''}">
            Issues
            <span class="badge badge-xs badge-ghost">${totalProblems}</span>
        </a>
    </div>`;

    // No relay pipelines at all: omit the section instead of an empty table. A
    // filter that merely hides every row keeps it, so its message still shows.
    const relaySectionHtml =
        activeRelayPipelines.length === 0
            ? ''
            : `
        <h2 class="mb-2 text-lg font-bold">SRT Relay <span class="badge badge-neutral badge-sm ml-1">${activeRelayPipelines.length}</span></h2>
        <div class="overflow-x-auto mb-6">
            <table class="table table-sm table-relay">
                ${thead(['Pipeline', 'Input', 'Output', 'Issues', 'Uptime', '<span title="Bonded group inputs show deduplicated Drop; non-bonded inputs show Loss / Rexmit / Drop">Input L / R / D</span>', 'State', 'Source IP', 'Latency', 'RTT', 'Rate', '<span title="Loss / Rexmit / Drop">L / R / D</span>'])}
                <tbody>${relayRows}</tbody>
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
            <h2 class="text-lg font-bold">Inputs <span class="badge badge-neutral badge-sm ml-1">${countLabel(inputsShown, state.pipelines.length)}</span></h2>
            ${searchBoxHtml('ov-search-inputs', 'Search inputs by name', state.inputSearch)}
        </div>
        <div class="overflow-x-auto mb-6">
            <table class="table table-sm">
                ${thead(['Pipeline', 'Status', 'Issues', 'Uptime', 'Bitrate', 'Type', 'Stream Specification'])}
                <tbody>${inputRows}</tbody>
            </table>
        </div>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-lg font-bold">Outputs <span class="badge badge-neutral badge-sm ml-1">${countLabel(outputsShown, totalOuts)}</span></h2>
            ${searchBoxHtml('ov-search-outputs', 'Search outputs by name', state.outputSearch)}
        </div>
        <div class="overflow-x-auto">
            <table class="table table-sm">
                ${thead(['Pipeline · Output', 'Status', 'Issues', 'Uptime', 'Bitrate', 'CPU', 'RAM', 'Type', 'Stream Specification'])}
                <tbody>${outputRows}</tbody>
            </table>
        </div>`,
    );

    if (typingIn) {
        const box = document.getElementById(typingIn.id);
        if (box instanceof HTMLInputElement) {
            box.focus();
            box.setSelectionRange(typingIn.start, typingIn.end);
        }
    }

    const fmtPct = (v: number) => `${Math.round(v)}%`;
    drawChart('chart-cpu', chartSamples, (s) => s.cpu, 100, '#3b82f6', fmtPct);
    drawChart(
        'chart-ram',
        chartSamples,
        (s) => (s.ramUsed / s.ramTotal) * 100,
        100,
        '#a855f7',
        fmtPct,
    );
    // kbps with a 10 kbps floor, so an idle host still gets distinct tick labels.
    drawChart(
        'chart-rx',
        chartSamples,
        (s) => (s.rxBps * 8) / 1000,
        10,
        '#22c55e',
        formatBitrateAxis,
    );
    drawChart(
        'chart-tx',
        chartSamples,
        (s) => (s.txBps * 8) / 1000,
        10,
        '#f97316',
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

function renderPipelineInfo(selectedId: string | null): void {
    const pipeline = selectedId ? state.pipelines.find((p) => p.id === selectedId) : null;
    const col = document.getElementById('pipe-info-col');
    const outsCol = document.getElementById('outs-col');
    const overviewCol = document.getElementById('overview-col');
    const logsCol = document.getElementById('srs-logs-col');
    const settingsCol = document.getElementById('settings-col');
    const view = getUrlParam('view');
    const inLogsView = view === 'logs';
    const inSettingsView = view === 'settings';

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
        displayInputBitrateKbps,
        sourceIp: relaySourceIp(pipeline),
        directSrt: pipeline.input.isSrt && !pipeline.srtBonding.acceptedBySrs,
        relayPort: state.health.srtRelay?.port,
    });
    if (statsContainer) statsContainer.classList.toggle('hidden', !pipeline.input.connected);
    if (statsEl) statsEl.innerHTML = inputHtml;
    renderSharedEncodes(pipeline, { outStatus, formatUptime });
    const rtmpEl = document.getElementById('rtmp-publish-url');
    const srtEl = document.getElementById('srt-publish-url');
    if (rtmpEl) {
        rtmpEl.dataset.copy = pipeline.rtmpPublishUrl;
        const lastSlash = pipeline.rtmpPublishUrl.lastIndexOf('/');
        rtmpEl.dataset.serverUrl =
            lastSlash > -1
                ? pipeline.rtmpPublishUrl.substring(0, lastSlash)
                : pipeline.rtmpPublishUrl;
        rtmpEl.dataset.streamKey = pipeline.streamKey;
    }
    if (srtEl) {
        srtEl.dataset.copy = pipeline.srtPublishUrl;
        const hostStart = 6;
        const colonAfterHost = pipeline.srtPublishUrl.indexOf(':', hostStart);
        srtEl.dataset.ip = pipeline.srtPublishUrl.slice(hostStart, colonAfterHost);
        const portEnd = pipeline.srtPublishUrl.indexOf('?', colonAfterHost);
        srtEl.dataset.port =
            portEnd > -1
                ? pipeline.srtPublishUrl.slice(colonAfterHost + 1, portEnd)
                : pipeline.srtPublishUrl.slice(colonAfterHost + 1);
        srtEl.dataset.streamId = `#!::r=live/${pipeline.streamKey},m=publish`;
        srtEl.dataset.passphrase = state.config.srtPassphrase || '';
    }

    const bondingCard = document.getElementById('srt-bonding-card');
    const bondingDot = document.getElementById('srt-bonding-status-dot');
    const bondingDotFill = document.getElementById('srt-bonding-status-fill');
    const bondingTooltipContent = document.getElementById('srt-bonding-status-tooltip-content');
    const bondingUrl = document.getElementById('srt-bonding-url');
    const bondingStats = document.getElementById('srt-bonding-stats');
    const bondingLegs = document.getElementById('srt-bonding-legs');
    const bondingErrWrap = document.getElementById('srt-bonding-last-error-wrap');
    const bondingErrTs = document.getElementById('srt-bonding-last-error-ts');
    const bondingErr = document.getElementById('srt-bonding-last-error');
    const bondingErrInfoBtn = document.getElementById('srt-bonding-last-error-info');
    const bondingInputActive = pipeline.srtBonding.inputActive;
    const bondingOutputConnected = pipeline.srtBonding.outputConnected;
    const hasActiveBondingConnection = bondingInputActive || bondingOutputConnected;
    const showSrtInputGraphs = hasActiveBondingConnection;
    const relayProcessRunning = state.health.srtRelay?.status === 'running';
    const bondingHost = state.config.publicHost || 'localhost';
    const bondingPortValue = state.health.srtRelay?.port ?? 10081;
    const bondingStreamId = `#!::r=live/${pipeline.streamKey},m=publish`;
    const bondingUrlValue =
        `srt://${bondingHost}:${bondingPortValue}?mode=caller&grouptype=broadcast` +
        `&streamid=${bondingStreamId}` +
        (state.config.srtPassphrase
            ? `&passphrase=${encodeURIComponent(state.config.srtPassphrase)}&pbkeylen=16`
            : '');
    const bondingGraphs = document.getElementById('srt-bonding-graphs');
    const bondingStatsCard = document.getElementById('srt-bonding-stats-card');
    bondingGraphs?.classList.toggle('hidden', !showSrtInputGraphs);
    bondingStatsCard?.classList.toggle('hidden', !hasActiveBondingConnection);
    bondingCard?.classList.remove('opacity-60');
    if (bondingDot && bondingDotFill) {
        const indicator = getBondingIndicator(pipeline, relayProcessRunning);
        bondingDotFill.style.backgroundColor = 'transparent';
        bondingDotFill.style.backgroundImage =
            `linear-gradient(90deg, ` +
            `${indicator.leftColor} 0 45%, ` +
            `#242933 45% 55%, ` +
            `${indicator.rightColor} 55% 100%)`;
        if (bondingTooltipContent) {
            bondingTooltipContent.innerHTML = renderIssueTooltip(
                indicator.issues,
                indicator.offMessage,
            );
        }
    }
    if (bondingUrl) {
        bondingUrl.dataset.copy = bondingUrlValue;
        bondingUrl.dataset.port = String(bondingPortValue);
    }
    if (bondingStats) {
        bondingStats.innerHTML = renderBondingStats(pipeline.srtBonding, relayProcessRunning, {
            formatCompactCount,
            fmtMs,
            fmtMbpsValue,
            fmtLossRexmitDrop,
            inputAggregateStatsAreDropOnly,
            legHealthColor,
            legHealthLabel,
            renderCompactMetaRow,
        });
    }
    if (bondingLegs) {
        setHtmlKeepScroll(
            bondingLegs,
            renderBondedLegs(pipeline.srtBonding.input, {
                formatCompactCount,
                fmtMs,
                fmtMbpsValue,
                fmtLossRexmitDrop,
                inputAggregateStatsAreDropOnly,
                legHealthColor,
                legHealthLabel,
                renderCompactMetaRow,
            }),
        );
    }
    if (bondingErrWrap && bondingErr && bondingErrTs) {
        const msg = pipeline.srtBonding.lastError;
        const lastErrorLine = msg
            ? (msg
                  .split('\n')
                  .filter((l) => l.trim())
                  .slice(-1)[0] ?? '')
            : '';
        bondingErrWrap.classList.toggle('hidden', !msg);
        bondingErrTs.textContent = pipeline.srtBonding.lastErrorAt
            ? new Date(pipeline.srtBonding.lastErrorAt).toLocaleTimeString(undefined, {
                  hour12: false,
              })
            : '';
        bondingErr.textContent = lastErrorLine;
        if (bondingErrInfoBtn) {
            (bondingErrInfoBtn as HTMLButtonElement).onclick = () => {
                void import('../features/editor.js').then((ed) => ed.showRelayError(pipeline.id));
            };
        }
    }

    void import('../features/srt-bonding-details.js').then((ed) => {
        if (showSrtInputGraphs) {
            ed.renderSrtBondingDetailsInline(pipeline.id);
        } else {
            const details = document.getElementById('srt-bonding-details');
            if (details) {
                details.innerHTML = '';
                delete details.dataset.pipelineId;
            }
            if (bondingGraphs) bondingGraphs.innerHTML = '';
        }
    });

    renderPreview(pipeline);
    renderOutputsList(pipeline);
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

    if (pipeline.outs.length === 0) {
        listEl.innerHTML = '<p class="text-sm opacity-50">No outputs yet.</p>';
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

    listEl.innerHTML = pipeline.outs
        .map((o) =>
            renderOutputCard(o, pipeline.input, dupUrls, {
                pendingOutputs,
                outStatus,
                formatUptime,
            }),
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
        if (!target.closest('.js-output-drag-handle') || !card) {
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

// ── Entry point ───────────────────────────────────────

export function renderMetrics(): void {
    renderMetricsView({ setMetricSeverity });
}

export function renderPipelines(): void {
    const selectedId = getUrlParam('p');
    const view = getUrlParam('view');
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
                    <span class="min-w-0 truncate text-xs opacity-60" title="${escapeHtml(via)}">${escapeHtml(via)}</span>
                </div>
                <div class="flex items-center gap-2 pl-5">
                    ${streamsBadge}
                    <span class="badge badge-sm badge-error shrink-0 gap-1 px-2" title="${r.attempts} rejected attempt${r.attempts === 1 ? '' : 's'}">${ICON_CROSS}${r.attempts}</span>
                    <span class="font-mono text-xs opacity-60">${formatUptime(r.lastAttemptAgoMs)} ago</span>
                </div>
            </li>`;
        })
        .join('');
    el.innerHTML = `<div class="border-base-content/10 border-t pt-2">
        <div class="text-xs font-bold uppercase opacity-60">Rejected publish attempts</div>
        <div class="mb-1 text-xs opacity-50">Not pipelines — nothing here is being forwarded</div>
        <ul>${rows}</ul>
        ${state.rejectedOmitted > 0 ? `<div class="text-xs opacity-50">+${state.rejectedOmitted} more</div>` : ''}
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

    const hide = (): void => {
        portal.classList.add('hidden');
        activeTrigger = null;
    };

    const show = (trigger: Element, content: Element): void => {
        if (!content.innerHTML.trim()) return;
        portal.innerHTML = content.innerHTML;
        portal.classList.remove('hidden');
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
