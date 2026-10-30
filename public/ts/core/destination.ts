import { stripSrtStreamId } from './srt.js';

// An output's destination as the edit form shows it: a server preset and the one
// value the preset needs (a stream key, an SRT URL, a pipeline id). These are the
// rules between that pair and the stored URL, in both directions. No DOM.

export const SERVERS = [
    {
        id: 'custom-rtmp',
        label: 'Custom RTMP',
        prefix: '',
        keyLabel: 'RTMP URL',
        placeholder: 'rtmp://...',
    },
    {
        id: 'custom-srt',
        label: 'Custom SRT',
        prefix: '',
        keyLabel: 'SRT Settings',
        placeholder: '',
    },
    {
        id: 'youtube',
        label: 'YT RTMP',
        prefix: 'rtmp://a.rtmp.youtube.com/live2/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    {
        id: 'youtube-backup',
        label: 'YT RTMP (Backup)',
        prefix: 'rtmp://b.rtmp.youtube.com/live2?backup=1/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    {
        id: 'facebook',
        label: 'Facebook RTMP',
        prefix: 'rtmps://live-api-s.facebook.com:443/rtmp/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    {
        id: 'instagram',
        label: 'Instagram RTMPS',
        prefix: '',
        keyLabel: 'Stream Key',
        placeholder: '1234567890?s_bl=1&s_prp=xxx-1&...',
    },
    {
        id: 'restream-rtmp',
        label: 'Restream RTMP',
        prefix: '',
        keyLabel: 'Pipeline',
        placeholder: '',
    },
    {
        id: 'restream-srt',
        label: 'Restream SRT',
        prefix: '',
        keyLabel: 'Pipeline',
        placeholder: '',
    },
] as const;

export type ServerId = (typeof SERVERS)[number]['id'];

export function serverById(id: ServerId): (typeof SERVERS)[number] {
    return SERVERS.find((s) => s.id === id)!;
}

// The pipelines a Restream destination can point at (their local publish URLs).
export interface RestreamTarget {
    id: string | number;
    rtmpPublishUrlLocal: string;
    srtPublishUrlLocal: string;
}

export interface DestinationChoice {
    server: ServerId;
    key: string;
}

export function isRestreamServer(server: ServerId): boolean {
    return server === 'restream-rtmp' || server === 'restream-srt';
}

export function buildInstagramUrl(key: string): string {
    const m = key.match(/[?&]s_prp=([^&]+)/);
    const sPrp = m ? m[1] : '';
    return `rtmps://edgetee-upload-${sPrp}.xx.fbcdn.net:443/rtmp/${key}`;
}

function detectInstagramKey(url: string): string | null {
    const m = url.match(/^rtmps:\/\/edgetee-upload-[^.]+\.xx\.fbcdn\.net:443\/rtmp\/(.+)$/);
    return m ? m[1] : null;
}

// The preset and value that produce a stored URL.
export function detectServer(url: string, pipelines: RestreamTarget[]): DestinationChoice {
    for (const p of pipelines) {
        if (url === p.rtmpPublishUrlLocal) return { server: 'restream-rtmp', key: String(p.id) };
        if (url === p.srtPublishUrlLocal) return { server: 'restream-srt', key: String(p.id) };
    }
    const instagramKey = detectInstagramKey(url);
    if (instagramKey !== null) return { server: 'instagram', key: instagramKey };
    for (const { id, prefix } of SERVERS) {
        if (prefix && url.startsWith(prefix)) return { server: id, key: url.slice(prefix.length) };
    }
    return { server: url.startsWith('srt://') ? 'custom-srt' : 'custom-rtmp', key: url };
}

// The URL a preset and its (trimmed) value produce, or an error when the value is
// empty, names no pipeline, or is not a URL of the preset's scheme. Custom SRT is
// built from its own fields (srtUrlFromForm), not here.
export function buildDestinationUrl(
    server: ServerId,
    key: string,
    pipelines: RestreamTarget[],
): { url: string } | { error: true } {
    if (isRestreamServer(server)) {
        const pipeline = pipelines.find((p) => String(p.id) === key);
        if (!pipeline) return { error: true };
        return {
            url:
                server === 'restream-rtmp'
                    ? pipeline.rtmpPublishUrlLocal
                    : pipeline.srtPublishUrlLocal,
        };
    }
    if (!key) return { error: true };
    if (server === 'instagram') return { url: buildInstagramUrl(key) };
    const url = serverById(server).prefix + key;
    if (server === 'custom-rtmp' && !/^rtmps?:\/\//.test(url)) return { error: true };
    if (server === 'custom-srt' && !url.startsWith('srt://')) return { error: true };
    return { url };
}

export function isDestinationUrl(text: string): boolean {
    return /^(rtmps?|srt):\/\//i.test(text);
}

// Drops the trailing path segment (the stream key) from a custom RTMP URL,
// keeping only the server/app portion so it can be prefilled without leaking
// the previous output's key. Leaves the URL untouched if it has no path
// segment to strip (e.g. bare "rtmp://host").
function stripRtmpStreamKey(url: string): string {
    const m = url.match(/^([a-z]+:\/\/)(.*)$/i);
    if (!m) return url;
    const [, scheme, rest] = m;
    const slashIdx = rest.lastIndexOf('/');
    if (slashIdx === -1) return url;
    return scheme + rest.slice(0, slashIdx + 1);
}

// Sanitizes a previous output's server/key for prefill so the unique-per-stream
// identifier isn't silently reused: RTMP stream keys, SRT stream IDs, and the
// selected Restream target pipeline are all dropped (blank), while the
// server/connection settings around them are kept.
export function sanitizedDestinationFor(
    previousUrl: string,
    pipelines: RestreamTarget[],
): DestinationChoice {
    const { server, key } = detectServer(previousUrl, pipelines);
    if (server === 'custom-srt') return { server, key: stripSrtStreamId(key) };
    if (server === 'custom-rtmp') return { server, key: stripRtmpStreamKey(key) };
    return { server, key: '' };
}
