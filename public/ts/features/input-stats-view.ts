import { audioSpecLines, videoSpec } from '../core/media-spec.js';
import {
    LOW_BITRATE_KBPS,
    escapeHtml,
    formatBitrate,
    formatClockTime,
    formatLocalTime,
} from '../core/utils.js';
import type { InputHealth } from '../types.js';

type InputStatsDeps = {
    displayInputBitrateKbps: (input: InputHealth) => number | null;
    // Overrides the publisher IP when SRS only sees the relay (loopback).
    sourceIp?: string | null;
    // Plain SRT sent straight to SRS (not through the relay): SRS exposes no
    // loss/retransmit counters for it, so the card says so and where to get them.
    directSrt?: boolean;
    relayPort?: number;
};

export function formatUptime(ms: number | null): string {
    if (ms === null) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatMediaProbeStatus(input: InputHealth): string | null {
    if (input.mediaCheckedAt) {
        return `Last ffprobe ${formatLocalTime(input.mediaCheckedAt)}`;
    }
    if (input.mediaProbeStartedAt) {
        return `ffprobe started ${formatLocalTime(input.mediaProbeStartedAt)}`;
    }
    if (input.connected && !input.live) return 'ffprobe not run yet';
    return null;
}

export function inputStatusMessage(input: InputHealth): string {
    if (input.mediaError) return input.mediaError;
    if (input.mediaOk === null)
        return 'Waiting for ffprobe to finish and return the input encoding.';
    return 'Input connected, waiting for valid media.';
}

function renderMediaProbeNotice(input: InputHealth): string {
    const message = inputStatusMessage(input);
    const toneClass = input.mediaError ? 'text-error' : input.live ? 'opacity-50' : 'text-warning';
    const probeStatus = input.mediaError ? null : formatMediaProbeStatus(input);
    return `<p class="text-xs ${toneClass} mt-2">${escapeHtml(message)}${probeStatus ? ` <span class="opacity-60">${escapeHtml(probeStatus)}</span>` : ''}</p>`;
}

function renderDirectSrtNotice(relayPort: number | undefined): string {
    const port = relayPort ? ` (port ${relayPort})` : '';
    return `<p class="text-xs opacity-50 mt-2">Sent straight to SRS: no packet loss or retransmit stats or alerts. Send plain SRT to the bonding input${port} to get them.</p>`;
}

export function renderInputStats(input: InputHealth, deps: InputStatsDeps): string {
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
    const bitrateKbps = deps.displayInputBitrateKbps(input);
    const lowBitrate = bitrateKbps !== null && bitrateKbps < LOW_BITRATE_KBPS;
    const ip = deps.sourceIp ?? input.publisherIp;
    const source = [
        ip ? escapeHtml(ip) : null,
        `<span class="${lowBitrate ? 'text-warning' : ''}"${lowBitrate ? ` title="Below ${LOW_BITRATE_KBPS} kbps"` : ''}>${formatBitrate(bitrateKbps)}</span>`,
    ]
        .filter(Boolean)
        .join(' · ');
    const probed = input.mediaCheckedAt
        ? `<span class="opacity-40 shrink-0" title="When ffprobe last read the input">probed ${formatClockTime(input.mediaCheckedAt)}</span>`
        : '';
    const row = (label: string, value: string) =>
        `<span class="opacity-60">${label}</span><div class="min-w-0 font-mono break-words">${value}</div>`;

    // Same one-line video and audio descriptions as the Overview's Stream
    // Specification column, labelled by row.
    return `
        <div class="my-1 grid grid-cols-[3.5rem_1fr] gap-x-3 gap-y-1 text-xs">
            <span class="opacity-60">Source</span>
            <div class="flex min-w-0 justify-between gap-2"><span class="font-mono">${source}</span>${probed}</div>
            ${row('Video', v ? escapeHtml(v) : '—')}
            ${audioLines.length > 0 ? row('Audio', audioLines.join('<br>')) : ''}
        </div>
        ${v ? '' : renderMediaProbeNotice(input)}
        ${deps.directSrt ? renderDirectSrtNotice(deps.relayPort) : ''}
    `;
}

export function renderCompactMetaRow(
    items: Array<{
        label: string;
        labelTitle?: string;
        value: string | number | null | undefined;
    }>,
    className = '',
): string {
    return `<div class="input-meta-row ${className}">${items
        .map(
            (item) =>
                `<span class="input-meta-item"><span class="input-meta-label"${
                    item.labelTitle ? ` title="${escapeHtml(item.labelTitle)}"` : ''
                }>${item.label}</span><span class="input-meta-value">${item.value == null ? '—' : escapeHtml(String(item.value))}</span></span>`,
        )
        .join('')}</div>`;
}
