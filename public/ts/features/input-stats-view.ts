import { escapeHtml, formatBitrate, formatLocalTime } from '../core/utils.js';
import type { InputHealth } from '../types.js';

type InputStatsDeps = {
    displayInputBitrateKbps: (input: InputHealth) => number | null;
    fmtFieldOrder: (fieldOrder: string | null | undefined) => string | null;
    // Overrides the publisher IP when SRS only sees the relay (loopback).
    sourceIp?: string | null;
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

    const v = input.video;
    const a = input.audio;
    const compactStat = (label: string, val: string | number | null | undefined) =>
        `<span class="input-meta-item"><span class="input-meta-label">${label}</span><span class="input-meta-value">${val == null ? '—' : escapeHtml(String(val))}</span></span>`;

    return `
        ${
            v
                ? `
        <div class="input-meta-row input-meta-row-sm my-0.5">
            ${compactStat('IP', deps.sourceIp ?? input.publisherIp)}
            ${compactStat('In', formatBitrate(deps.displayInputBitrateKbps(input)))}
            ${compactStat('Codec', v.codec)}
            ${compactStat('Size', v.width && v.height ? `${v.width}×${v.height}` : null)}
            ${compactStat('FPS', v.fps != null ? v.fps : null)}
            ${compactStat('Scan', deps.fmtFieldOrder(v.fieldOrder))}
            ${compactStat('Prof', v.profile || null)}
            ${compactStat('Lvl', v.level || null)}
        </div>`
                : renderMediaProbeNotice(input)
        }
        ${
            input.audioTracks.length > 0
                ? `
        <h3 class="mt-3 text-sm font-semibold opacity-60">Audio <span class="font-normal">(${input.audioTracks.length} track${input.audioTracks.length > 1 ? 's' : ''})</span></h3>
        <table class="table table-xs mt-1">
            <thead><tr><th>#</th>${input.audioTracks.some((t) => t.pid != null) ? '<th>PID</th>' : ''}<th>Codec</th><th>Profile</th><th>Ch</th><th>Freq</th>${input.audioTracks.some((t) => t.language || t.title) ? '<th>Label</th>' : ''}</tr></thead>
            <tbody>
                ${input.audioTracks
                    .map((t) => {
                        const label = escapeHtml([t.language, t.title].filter(Boolean).join(' — '));
                        return `<tr>
                        <td class="font-mono">${t.index + 1}</td>
                        ${input.audioTracks.some((x) => x.pid != null) ? `<td class="font-mono">${t.pid ?? '—'}</td>` : ''}
                        <td>${escapeHtml(t.codec || '—')}</td>
                        <td>${escapeHtml(t.profile || '—')}</td>
                        <td>${t.channels || '—'}</td>
                        <td>${t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : '—'}</td>
                        ${input.audioTracks.some((x) => x.language || x.title) ? `<td class="opacity-60">${label || ''}</td>` : ''}
                    </tr>`;
                    })
                    .join('')}
            </tbody>
        </table>`
                : a
                  ? `
        <h3 class="mt-3 text-sm font-semibold opacity-60">Audio</h3>
        <div class="mt-1">
            ${renderCompactMetaRow([
                { label: 'Codec', value: a.codec },
                { label: 'Profile', value: a.profile || null },
                {
                    label: 'Sample Rate',
                    value: a.sample_rate ? `${(a.sample_rate / 1000).toFixed(1)} kHz` : null,
                },
                { label: 'Channels', value: a.channel },
            ])}
        </div>`
                  : ''
        }
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
