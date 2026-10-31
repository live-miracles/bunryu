import { audioSpecLines, keyframeSpec, videoSpec } from '../core/media-spec.js';
import { healthNowMs } from '../core/state.js';
import {
    LOW_BITRATE_KBPS,
    escapeHtml,
    formatAgo,
    formatBitrate,
    formatLocalTime,
} from '../core/utils.js';
import { displayInputBitrateKbps, inputStatusMessage } from '../core/status.js';
import type { InputHealth } from '../types.js';

type InputStatsOptions = {
    // Overrides the publisher IP when SRS only sees the relay (loopback).
    sourceIp?: string | null;
    // Plain SRT sent straight to SRS (not through the relay): SRS exposes no
    // loss/retransmit counters for it, so the card says so and where to get them.
    directSrt?: boolean;
    relayPort?: number;
};

function formatMediaProbeStatus(input: InputHealth): string | null {
    if (input.mediaCheckedAt) {
        return `Last ffprobe ${formatAgo(input.mediaCheckedAt, healthNowMs())}`;
    }
    if (input.mediaProbeStartedAt) {
        return `ffprobe started ${formatAgo(input.mediaProbeStartedAt, healthNowMs())}`;
    }
    if (input.connected && !input.live) return 'ffprobe not run yet';
    return null;
}

function renderMediaProbeNotice(input: InputHealth): string {
    const message = inputStatusMessage(input);
    const toneClass = input.mediaError ? 'text-error' : input.live ? 'text-muted' : 'text-warning';
    const probeStatus = input.mediaError ? null : formatMediaProbeStatus(input);
    return `<p class="text-xs ${toneClass} mt-2">${escapeHtml(message)}${probeStatus ? ` <span class="text-muted">${escapeHtml(probeStatus)}</span>` : ''}</p>`;
}

function renderDirectSrtNotice(relayPort: number | undefined): string {
    const port = relayPort ? ` (port ${relayPort})` : '';
    return `<p class="text-xs text-muted mt-2">Sent straight to SRS: no packet loss or retransmit stats or alerts. Send plain SRT to the SRT relay input${port} to get them.</p>`;
}

export function renderInputStats(input: InputHealth, options: InputStatsOptions): string {
    if (!input.connected) return '';
    // mediaError takes priority over `!live` below: for RTMP inputs, SRS keeps
    // reporting its own (stale) demuxed video/audio metadata even while our
    // ffprobe re-check is actively failing, so falling through to the stats
    // row below on video-truthy would silently hide a live ffprobe failure.
    // SRT inputs never populate that fallback (srt_to_rtmp is off), which is
    // why this only ever masked errors on RTMP-sourced pipelines.
    if (!input.live || input.mediaError || input.mediaOk === null) {
        return renderMediaProbeNotice(input);
    }

    const v = videoSpec(input.video);
    const audioLines = audioSpecLines(input.audioTracks, input.audio);
    const bitrateKbps = displayInputBitrateKbps(input);
    const lowBitrate = bitrateKbps !== null && bitrateKbps < LOW_BITRATE_KBPS;
    const ip = options.sourceIp ?? input.publisherIp;
    const source = [
        ip ? escapeHtml(ip) : null,
        `<span class="${lowBitrate ? 'text-warning' : ''}"${lowBitrate ? ` title="Below ${LOW_BITRATE_KBPS} kbps"` : ''}>${formatBitrate(bitrateKbps)}</span>`,
    ]
        .filter(Boolean)
        .join(' · ');
    const probed = input.mediaCheckedAt
        ? `<span class="text-muted shrink-0" title="When ffprobe last read the input: ${formatLocalTime(input.mediaCheckedAt)}">probed ${formatAgo(input.mediaCheckedAt, healthNowMs())}</span>`
        : '';
    const keyframes = input.keyframes;
    const keyframesTooLong = (input.alerts ?? []).some((a) => a.code === 'input-keyframe-interval');
    const row = (label: string, value: string) =>
        `<span class="text-muted">${label}</span><div class="min-w-0 font-mono break-words">${value}</div>`;

    // Same one-line video and audio descriptions as the Overview's Stream
    // Specification column, labelled by row.
    return `
        <div class="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-0.5 text-xs">
            <span class="text-muted">Source</span>
            <div class="flex min-w-0 justify-between gap-2"><span class="font-mono">${source}</span>${probed}</div>
            ${row('Video', v ? escapeHtml(v) : '—')}
            ${audioLines.length > 0 ? row('Audio', audioLines.join('<br>')) : ''}
            ${keyframes ? row('Keyframes', `<span class="${keyframesTooLong ? 'text-warning' : ''}" title="Measured over ${keyframes.windowSec} s of video about a minute after the publisher connected. Platforms need a keyframe at least every 4 s; 2 s is recommended.">${escapeHtml(keyframeSpec(keyframes))}</span>`) : ''}
        </div>
        ${v ? '' : renderMediaProbeNotice(input)}
        ${options.directSrt ? renderDirectSrtNotice(options.relayPort) : ''}
    `;
}

export function renderCompactMetaRow(
    items: Array<{
        label: string;
        labelTitle?: string;
        value: string | number | null | undefined;
        valueClass?: string;
        valueTitle?: string;
    }>,
    className = '',
): string {
    return `<div class="input-meta-row ${className}">${items
        .map(
            (item) =>
                `<span class="input-meta-item"><span class="input-meta-label"${
                    item.labelTitle ? ` title="${escapeHtml(item.labelTitle)}"` : ''
                }>${item.label}</span><span class="input-meta-value${item.valueClass ? ` ${item.valueClass}` : ''}"${
                    item.valueTitle ? ` title="${escapeHtml(item.valueTitle)}"` : ''
                }>${item.value == null ? '—' : escapeHtml(String(item.value))}</span></span>`,
        )
        .join('')}</div>`;
}
