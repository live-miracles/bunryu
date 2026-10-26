// The "Publish to this input" card: one input mode (RTMP, SRT or SRT Relay) is shown at
// a time, each as rows of "label, value, copy". The value is shown shortened where
// it is long, and masked where it is a secret (stream key, stream ID, passphrase);
// copying always gives the real value, and the dashboard can reveal a secret row for a
// few seconds. A stream key keeps its `keyNN_` prefix visible (not secret, and it says
// which key it is); the passphrase is masked whole.

export type PublishMode = 'rtmp' | 'srt' | 'relay';

export const PUBLISH_MODES: { mode: PublishMode; label: string }[] = [
    { mode: 'rtmp', label: 'RTMP' },
    { mode: 'srt', label: 'SRT' },
    { mode: 'relay', label: 'SRT Relay' },
];

export const MASK = '••••••••';

export interface PublishRow {
    label: string;
    // What Copy puts on the clipboard.
    value: string;
    // What the row displays: `value` with every secret masked.
    shown: string;
    secret: boolean;
    // The full URL row, styled as the main action.
    primary: boolean;
}

export interface PublishContext {
    rtmpUrl: string;
    srtUrl: string;
    streamKey: string;
    passphrase: string;
    relayPort: number;
    // The SRT Relay publish URL for a single link, and for a bonded group (it adds
    // `grouptype=broadcast`).
    relayUrl: string;
    relayBondedUrl: string;
}

interface LiveInput {
    input: { connected: boolean; isSrt: boolean };
    srtBonding: { inputActive: boolean };
}

// The mode the encoder is publishing on right now, or null while nothing is.
export function livePublishMode(pipeline: LiveInput): PublishMode | null {
    if (pipeline.srtBonding.inputActive) return 'relay';
    if (!pipeline.input.connected) return null;
    return pipeline.input.isSrt ? 'srt' : 'rtmp';
}

// A stream key with everything after its `keyNN_` prefix masked.
export function maskKey(key: string): string {
    const underscore = key.indexOf('_');
    return underscore > 0 && underscore <= 8 ? key.slice(0, underscore + 1) + MASK : MASK;
}

interface Secret {
    value: string;
    masked: string;
}

// `text` with each secret replaced by its masked form. A secret also matches in its
// URL-encoded form, which is how the passphrase sits in a publish URL.
export function maskSecrets(text: string, secrets: Secret[]): string {
    let out = text;
    for (const { value, masked } of secrets) {
        if (!value) continue;
        for (const form of new Set([value, encodeURIComponent(value)])) {
            out = out.split(form).join(masked);
        }
    }
    return out;
}

function row(
    label: string,
    value: string,
    secrets: Secret[],
    opts: { secret?: Secret; primary?: boolean } = {},
): PublishRow {
    return {
        label,
        value,
        shown: opts.secret ? opts.secret.masked : maskSecrets(value, secrets),
        secret: opts.secret !== undefined,
        primary: opts.primary ?? false,
    };
}

// `srt://host:port?...` into host and port.
function srtHostPort(url: string): { host: string; port: string } {
    const hostStart = 'srt://'.length;
    const colon = url.indexOf(':', hostStart);
    const end = url.indexOf('?', colon);
    return {
        host: url.slice(hostStart, colon),
        port: url.slice(colon + 1, end > -1 ? end : undefined),
    };
}

export function publishRows(mode: PublishMode, ctx: PublishContext): PublishRow[] {
    const key = { value: ctx.streamKey, masked: maskKey(ctx.streamKey) };
    const passphrase = { value: ctx.passphrase, masked: MASK };
    const secrets = [key, passphrase];
    if (mode === 'rtmp') {
        const slash = ctx.rtmpUrl.lastIndexOf('/');
        return [
            row('Server URL', slash > -1 ? ctx.rtmpUrl.slice(0, slash) : ctx.rtmpUrl, secrets),
            row('Stream key', ctx.streamKey, secrets, { secret: key }),
            row('Full URL', ctx.rtmpUrl, secrets, { primary: true }),
        ];
    }
    const { host, port } = srtHostPort(ctx.srtUrl);
    const streamId = `#!::r=live/${ctx.streamKey},m=publish`;
    const maskedStreamId = { value: streamId, masked: maskSecrets(streamId, secrets) };
    const rows = [
        row('Host', host, secrets),
        row('Port', mode === 'relay' ? String(ctx.relayPort) : port, secrets),
        row('Stream ID', streamId, secrets, { secret: maskedStreamId }),
    ];
    if (ctx.passphrase)
        rows.push(row('Passphrase', ctx.passphrase, secrets, { secret: passphrase }));
    if (mode === 'relay') {
        rows.push(
            row('Bonded URL', ctx.relayBondedUrl, secrets, { primary: true }),
            row('Single-link URL', ctx.relayUrl, secrets, { primary: true }),
        );
    } else {
        rows.push(row('Full URL', ctx.srtUrl, secrets, { primary: true }));
    }
    return rows;
}
