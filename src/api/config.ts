import type { Express } from 'express';
import { ENCODINGS } from '../utils/ffmpeg.js';
import { rtmpPublishUrl, srtPublishUrl } from '../utils/srs.js';
import { readSrsConfigValues } from '../utils/srsConfig.js';
import type { Db } from '../types.js';
import { readRelayConfig } from '../utils/relayConfig.js';

// Defensive parse for a value the UI wrote via /api/settings/layout-order —
// never throws, since a blank/corrupt value should just mean "no custom
// order yet", not a broken config load.
function parseLayoutOrder(raw: string | null): { id: number; outs: string[] }[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];

        const order: { id: number; outs: string[] }[] = [];
        for (const item of parsed) {
            if (!item || typeof item !== 'object') return [];
            const row = item as Record<string, unknown>;
            if (!Number.isInteger(row.id)) return [];
            if (!Array.isArray(row.outs) || !row.outs.every((o) => typeof o === 'string')) {
                return [];
            }
            order.push({ id: row.id as number, outs: row.outs as string[] });
        }
        return order;
    } catch {
        return [];
    }
}

export function registerConfigApi(app: Express, db: Db): void {
    app.get('/api/config', (_req, res) => {
        // srtPassphrase feeds the relay URL (relay listener, port 10081);
        // direct SRT publish URLs go to SRS itself, which enforces its own
        // srt_server passphrase. The install script sets both to the same value,
        // but each URL must reflect the config its endpoint actually checks.
        const srtPassphrase = readRelayConfig().passphrase || null;
        const srsSrtPassphrase = readSrsConfigValues().srtPassphrase;
        const host = db.getSetting('publicHost') || 'localhost';
        const pipelines = db.listPipelines().map((p) => ({
            ...p,
            rtmpPublishUrl: rtmpPublishUrl(p.streamKey, host),
            srtPublishUrl: srtPublishUrl(p.streamKey, host, srsSrtPassphrase),
            // Pipeline-to-pipeline restream destinations stay on this same server,
            // so route them over localhost instead of bouncing off the public host.
            rtmpPublishUrlLocal: rtmpPublishUrl(p.streamKey, 'localhost'),
            srtPublishUrlLocal: srtPublishUrl(p.streamKey, 'localhost', srsSrtPassphrase),
        }));
        res.json({
            configRev: db.getConfigRev(),
            pipelines,
            outputs: db.listOutputs(),
            hostProbeTargets: db.listHostProbeTargets(),
            groups: db.listPipelineGroups(),
            encodings: Object.keys(ENCODINGS),
            streamKeys: db.listStreamKeys(),
            serverName: db.getSetting('serverName') ?? 'Bunryu',
            srtPassphrase,
            publicHost: host,
            layoutOrder: parseLayoutOrder(db.getSetting('layoutOrder')),
        });
    });
}
