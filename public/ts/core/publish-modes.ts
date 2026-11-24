// The "Publish to this input" card: one input mode (RTMP or SRT) is shown at a time, each
// as rows of "label, value, copy". The value is shown shortened where
// it is long, and masked where it is a secret (stream key, stream ID, passphrase);
// copying always gives the real value, and the dashboard can reveal a secret row for a
// few seconds. A stream key keeps its `keyNN_` prefix visible (not secret, and it says
// which key it is); the passphrase is masked whole.

// SRT means the SRT relay (single link or bonded): it gives link statistics and alerts,
// which SRT sent straight to SRS cannot, so that port is not offered here.
export type PublishMode = 'rtmp' | 'srt';

export const PUBLISH_MODES: { mode: PublishMode; label: string }[] = [
    { mode: 'rtmp', label: 'RTMP' },
    { mode: 'srt', label: 'SRT' },
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
    streamKey: string;
    passphrase: string;
    relayPort: number;
    // The SRT publish URL (through the relay) for a single link, and for a bonded group (it
    // adds `grouptype=broadcast`).
    relayUrl: string;
    relayBondedUrl: string;
}

interface LiveInput {
    input: { connected: boolean; isSrt: boolean };
    srtBonding: { inputActive: boolean };
}

// The tab the connected input belongs to, or null while nothing is connected: SRT sent
// straight to SRS opens the SRT tab too, since that is where its input card points.
export function livePublishMode(pipeline: LiveInput): PublishMode | null {
    if (pipeline.srtBonding.inputActive) return 'srt';
    if (!pipeline.input.connected) return null;
    return pipeline.input.isSrt ? 'srt' : 'rtmp';
}

// The tab that gets the green "live" dot: the same, except for SRT sent straight to SRS,
// which is not the SRT mode the tab offers (the relay).
export function liveDotMode(pipeline: LiveInput): PublishMode | null {
    return pipeline.input.isSrt && !pipeline.srtBonding.inputActive
        ? null
        : livePublishMode(pipeline);
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

// The host of an `srt://host:port?...` URL.
function srtHost(url: string): string {
    const hostStart = 'srt://'.length;
    return url.slice(hostStart, url.indexOf(':', hostStart));
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
    const streamId = `#!::r=live/${ctx.streamKey},m=publish`;
    const maskedStreamId = { value: streamId, masked: maskSecrets(streamId, secrets) };
    const rows = [
        row('Host', srtHost(ctx.relayUrl), secrets),
        row('Port', String(ctx.relayPort), secrets),
        row('Stream ID', streamId, secrets, { secret: maskedStreamId }),
    ];
    if (ctx.passphrase)
        rows.push(row('Passphrase', ctx.passphrase, secrets, { secret: passphrase }));
    rows.push(
        row('Single-link URL', ctx.relayUrl, secrets, { primary: true }),
        row('Bonded URL', ctx.relayBondedUrl, secrets, { primary: true }),
    );
    return rows;
}
