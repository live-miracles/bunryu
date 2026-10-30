export type SrtMode = 'caller' | 'listener';

export interface SrtOutputSettings {
    mode: SrtMode;
    host: string;
    port: number;
    latencyMs: number | null;
    passphrase: string;
    pbKeyLen: 16 | 24 | 32 | null;
    streamId: string;
}

// What the edit form shows for a stored URL: the settings as far as the URL has
// them.
export type SrtFormSettings = Omit<SrtOutputSettings, 'port'> & { port: number | null };

// What the edit form holds when it is saved: the raw text of each field.
export interface SrtFormValues {
    mode: string;
    host: string;
    port: string;
    latency: string;
    passphrase: string;
    keyLen: string;
    streamId: string;
}

export type SrtFormField = 'host' | 'port' | 'latency' | 'passphrase' | 'keyLen';

const DEFAULT_SRT_SETTINGS: SrtFormSettings = {
    mode: 'caller',
    host: '',
    port: null,
    latencyMs: null,
    passphrase: '',
    pbKeyLen: null,
    streamId: '',
};

export function isSrtHostRequired(mode: SrtMode): boolean {
    return mode !== 'listener';
}

// The passphrase is percent-encoded and the stream ID is written as typed, because
// FFmpeg reads the stream ID as it is in the URL. parseSrtUrl reads both back the
// same way.
export function buildSrtOutputUrl(settings: SrtOutputSettings): string {
    const params = [`mode=${settings.mode}`];
    if (settings.latencyMs !== null) params.push(`latency=${settings.latencyMs * 1000}`);
    if (settings.passphrase) {
        params.push(`passphrase=${encodeURIComponent(settings.passphrase)}`);
        params.push(`pbkeylen=${settings.pbKeyLen ?? 32}`);
    }
    if (settings.streamId) params.push(`streamid=${settings.streamId}`);
    return `srt://${settings.host}:${settings.port}?${params.join('&')}`;
}

// Checks the form's fields and builds the URL, or names the fields that are wrong.
export function srtUrlFromForm(
    values: SrtFormValues,
): { url: string } | { invalid: SrtFormField[] } {
    const mode = values.mode === 'listener' ? 'listener' : 'caller';
    const host = values.host.trim();
    const port = Number(values.port.trim());
    const latencyRaw = values.latency.trim();
    const latencyMs = latencyRaw ? Number(latencyRaw) : null;
    const passphrase = values.passphrase.trim();
    const pbKeyLen = values.keyLen ? (Number(values.keyLen) as 16 | 24 | 32) : null;
    const streamId = values.streamId.trim();

    const invalid: SrtFormField[] = [];
    if (isSrtHostRequired(mode) && !host) invalid.push('host');
    if (!(Number.isInteger(port) && port >= 1 && port <= 65535)) invalid.push('port');
    if (!(latencyMs === null || (Number.isInteger(latencyMs) && latencyMs > 0))) {
        invalid.push('latency');
    }
    if (passphrase && (passphrase.length < 10 || passphrase.length > 79)) {
        invalid.push('passphrase');
    }
    if (passphrase && pbKeyLen === null) invalid.push('keyLen');
    if (invalid.length > 0) return { invalid };

    return {
        url: buildSrtOutputUrl({ mode, host, port, latencyMs, passphrase, pbKeyLen, streamId }),
    };
}

function decodeSrtParam(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, '%20'));
    } catch {
        return value;
    }
}

function parseSrtParams(query: string): Map<string, string> {
    const params = new Map<string, string>();
    for (const part of query.split('&')) {
        if (!part) continue;
        const eqIdx = part.indexOf('=');
        const rawKey = eqIdx === -1 ? part : part.slice(0, eqIdx);
        const rawValue = eqIdx === -1 ? '' : part.slice(eqIdx + 1);
        const key = decodeSrtParam(rawKey);
        // The stream ID is stored as typed (see buildSrtOutputUrl), so it is not decoded.
        params.set(key, key === 'streamid' ? rawValue : decodeSrtParam(rawValue));
    }
    return params;
}

export function parseSrtUrl(url: string): SrtFormSettings {
    if (!url.startsWith('srt://')) return { ...DEFAULT_SRT_SETTINGS };
    try {
        const queryIdx = url.indexOf('?');
        const base = queryIdx === -1 ? url : url.slice(0, queryIdx);
        // A listener has no host ("srt://:9000"), which URL refuses to parse.
        const noHost = base.startsWith('srt://:');
        const parsed = new URL(noHost ? base.replace('srt://', 'srt://placeholder') : base);
        const params =
            queryIdx === -1 ? new Map<string, string>() : parseSrtParams(url.slice(queryIdx + 1));
        const latency = Number(params.get('latency') ?? '');
        const port = Number(parsed.port || '');
        const pbKeyLen = Number(params.get('pbkeylen') ?? '');
        return {
            mode: params.get('mode') === 'listener' ? 'listener' : 'caller',
            host: noHost ? '' : parsed.hostname,
            port: Number.isInteger(port) && port > 0 ? port : null,
            latencyMs: Number.isInteger(latency) && latency > 0 ? Math.round(latency / 1000) : null,
            passphrase: params.get('passphrase') ?? '',
            pbKeyLen: pbKeyLen === 16 || pbKeyLen === 24 || pbKeyLen === 32 ? pbKeyLen : null,
            streamId: params.get('streamid') ?? '',
        };
    } catch {
        return { ...DEFAULT_SRT_SETTINGS };
    }
}

// Removes the streamid param from a custom SRT URL while preserving every
// other setting (host, port, mode, latency, passphrase, keylen).
export function stripSrtStreamId(url: string): string {
    const queryIdx = url.indexOf('?');
    if (queryIdx === -1) return url;
    const base = url.slice(0, queryIdx);
    const params = url
        .slice(queryIdx + 1)
        .split('&')
        .filter((part) => part.split('=', 1)[0] !== 'streamid');
    return params.length > 0 ? `${base}?${params.join('&')}` : base;
}
