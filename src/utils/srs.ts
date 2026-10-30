import { readSrsConfigValues } from './srsConfig.js';
import { INPUT_TIMEOUT_US } from './ffmpeg.js';

const SRS_CLIENT_FETCH_TIMEOUT_MS = 3000;
const SRS_CLIENT_HEALTH_FETCH_TIMEOUT_MS = 1000;
const SRS_CLIENT_HEALTH_FETCH_COUNT = 1000;
const SRS_STREAMS_FETCH_TIMEOUT_MS = 5000;
// SRS's /api/v1/streams silently caps the response at 10 entries unless an
// explicit count is given (undocumented default; see ossrs/srs#4358 and
// ossrs/srs#4580) — with more than 10 concurrent streams across pipelines,
// whichever ones fall outside that window vanish from the response and their
// pipelines misread as input-not-live.
const SRS_STREAMS_FETCH_COUNT = 1000;

export interface SrsStreamVideo {
    codec: string;
    profile: string;
    level: string;
    width: number;
    height: number;
    fps?: number | null;
    fieldOrder?: string | null;
}

export interface SrsStreamAudio {
    codec: string;
    sample_rate: number;
    channel: number;
    profile: string;
}

export interface AudioTrackInfo {
    index: number;
    codec: string;
    sampleRate: number;
    channels: number;
    profile: string;
    language: string | null;
    title: string | null;
    pid: number | null;
}

export interface SrsStream {
    id: string;
    name: string;
    vhost: string;
    app: string;
    tcUrl?: string;
    live_ms: number;
    publish: { active: boolean; cid?: string };
    kbps: { recv_30s: number; send_30s: number };
    clients: number;
    // Video frames, added in ~5 s batches (SRS 6.0). SRS 8.0 counts video + audio
    // here and adds video_frames; the input frame-rate alert needs that field
    // if SRS is upgraded.
    frames: number;
    recv_bytes: number;
    send_bytes: number;
    video?: SrsStreamVideo;
    audio?: SrsStreamAudio;
}

export interface SrsClient {
    id: string;
    ip?: string;
    type?: string;
    app?: string;
    stream?: string;
    name?: string;
    url?: string;
    tcUrl?: string;
    publish?: boolean;
    // Seconds connected, bytes moved each way and the 30 s rates (a player's
    // send_30s lags for its first seconds; send_bytes does not).
    alive?: number;
    send_bytes?: number;
    recv_bytes?: number;
    kbps?: { recv_30s: number; send_30s: number };
}

export async function kickSrsClientsByStream(app: string, stream: string): Promise<void> {
    const srsApiUrl = readSrsConfigValues().apiUrl;
    const PAGE_SIZE = 100;

    // Collect all matching client ids first, then delete. Deleting while
    // paginating shifts SRS's offset-based pages under us, skipping clients.
    const toKick: string[] = [];
    let start = 0;
    while (true) {
        const res = await fetch(`${srsApiUrl}/api/v1/clients?start=${start}&count=${PAGE_SIZE}`, {
            signal: AbortSignal.timeout(SRS_CLIENT_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
            clients?: Array<{ id: string; app: string; stream: string }>;
        };
        const clients = data.clients ?? [];
        for (const client of clients) {
            if (client.app === app && client.stream === stream) {
                toKick.push(client.id);
            }
        }
        if (clients.length < PAGE_SIZE) break;
        start += PAGE_SIZE;
    }

    for (const id of toKick) {
        await fetch(`${srsApiUrl}/api/v1/clients/${id}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(SRS_CLIENT_FETCH_TIMEOUT_MS),
        }).catch((err: unknown) => {
            console.warn(
                `[srs] kick of client ${id} on ${app}/${stream} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        });
    }
}

export async function fetchSrsClientsForHealth(): Promise<SrsClient[]> {
    const srsApiUrl = readSrsConfigValues().apiUrl;
    const res = await fetch(
        `${srsApiUrl}/api/v1/clients?start=0&count=${SRS_CLIENT_HEALTH_FETCH_COUNT}`,
        {
            signal: AbortSignal.timeout(SRS_CLIENT_HEALTH_FETCH_TIMEOUT_MS),
            headers: { Connection: 'close' },
        },
    );
    if (!res.ok) throw new Error(`SRS clients API ${res.status}`);
    const data = (await res.json()) as { code: number; clients?: SrsClient[] };
    return data.clients || [];
}

export async function fetchSrsStreams(): Promise<SrsStream[]> {
    const srsApiUrl = readSrsConfigValues().apiUrl;
    const res = await fetch(
        `${srsApiUrl}/api/v1/streams/?start=0&count=${SRS_STREAMS_FETCH_COUNT}`,
        {
            signal: AbortSignal.timeout(SRS_STREAMS_FETCH_TIMEOUT_MS),
            headers: { Connection: 'close' },
        },
    );
    if (!res.ok) throw new Error(`SRS API ${res.status}`);
    const data = (await res.json()) as { code: number; streams: SrsStream[] };
    return data.streams || [];
}

export function rtmpPullUrl(streamKey: string): string {
    const srs = readSrsConfigValues();
    return `rtmp://${srs.rtmpHost}:${srs.rtmpPort}/live/${streamKey}`;
}

// latency/transtype are required, not optional tuning. Without an explicit
// receiver latency, ffmpeg's libsrt default is too tight for SRS's TSBPD send
// timing: the SRT link tears down ("Timer expired" / SRTS_BROKEN) before any
// payload arrives, so the pull reads 0 bytes. A 200 ms receiver buffer (with
// transtype=live) lets the stream flow. This pulls the raw MPEG-TS untouched,
// so every audio track survives (RTMP/srt_to_rtmp would collapse to one) and
// the timestamps stay clean (no srt_to_rtmp jitter — ffmpeg demuxes the TS).
//
// `timeout` (libsrt's own socket-I/O timeout, microseconds) bounds how long
// ffmpeg will block on this pull when SRS holds the play session open but
// stops sending payload (e.g. its publisher went away) — the generic
// `-rw_timeout` CLI flag used elsewhere does NOT apply to the srt:// protocol
// (confirmed against ffmpeg's own protocol option list; libsrt has its own
// `-timeout`), so without this the pull can block indefinitely. Defaults to
// the same bound as `-rw_timeout` elsewhere.
export function srtPullUrl(streamKey: string): string {
    const srs = readSrsConfigValues();
    let url = `srt://${srs.rtmpHost}:${srs.srtPort}?streamid=#!::r=live/${streamKey},m=request&latency=200000&transtype=live&timeout=${INPUT_TIMEOUT_US}`;
    if (srs.srtPassphrase) {
        url += `&passphrase=${encodeURIComponent(srs.srtPassphrase)}&pbkeylen=16`;
    }
    return url;
}

export function rtmpPublishUrl(streamKey: string, host: string): string {
    return `rtmp://${host}:${readSrsConfigValues().rtmpPort}/live/${streamKey}`;
}

export function srtPublishUrl(streamKey: string, host: string, passphrase?: string | null): string {
    const url = `srt://${host}:${readSrsConfigValues().srtPort}?streamid=#!::r=live/${streamKey},m=publish`;
    if (!passphrase) return url;
    return `${url}&passphrase=${encodeURIComponent(passphrase)}&pbkeylen=16`;
}

// The `r=` resource of an SRT stream id (`#!::r=live/key01,m=publish`), as written or
// percent-encoded; null when there is none.
export function extractStreamResource(value: string): string | null {
    const candidates = [value];
    try {
        candidates.push(decodeURIComponent(value));
    } catch {
        /* keep the raw candidate only */
    }

    for (const candidate of candidates) {
        const match = /(?:^|[?,&#]|::|,)r=([^,&#]+)/.exec(candidate);
        if (!match?.[1]) continue;
        return match[1].replace(/^\/+/, '');
    }

    return null;
}
