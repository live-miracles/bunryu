import express from 'express';
import type { Express } from 'express';
import { requireAuth } from './auth.js';
import { MAX_AUDIO_TRACKS } from '../utils/inputLimits.js';
import type { PreviewService } from '../services/preview.js';
import { PipelineNotFoundError } from '../utils/pipelineNotFoundError.js';

function isValidTrackCount(value: unknown): boolean {
    return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= MAX_AUDIO_TRACKS
    );
}

export function registerPreviewApi(app: Express, previewService: PreviewService): void {
    app.post('/api/pipelines/:id/preview/start', async (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });

        const rawCount = req.body?.audioTrackCount;
        if (rawCount !== undefined && !isValidTrackCount(rawCount)) {
            return res.status(400).json({
                error: `audioTrackCount must be an integer from 1 to ${MAX_AUDIO_TRACKS}`,
            });
        }
        const audioTrackCount = rawCount === undefined ? 1 : (rawCount as number);

        try {
            return res.json(await previewService.start(id, audioTrackCount));
        } catch (err) {
            if (err instanceof PipelineNotFoundError) {
                return res.status(404).json({ error: err.message });
            }
            return res.status(500).json({ error: String(err) });
        }
    });

    // Refreshes the preview's keepalive TTL. The dashboard calls this every 15s
    // while a preview is attached; previews with no keepalive are reaped so a
    // closed browser tab cannot leave a preview ffmpeg running forever. Returns
    // active=false when the preview no longer exists (reaped or crashed) so the
    // client can tear its player down.
    app.post('/api/pipelines/:id/preview/keepalive', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        return res.json({ active: previewService.keepalive(id) });
    });

    app.post('/api/pipelines/:id/preview/stop', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        previewService.stop(id);
        return res.json({ ok: true });
    });
}

// HLS previews show live content, so they sit behind the same session cookie as
// the API (hls.js and native HLS are same-origin and send it). Every fetch also
// counts as a viewer for the preview idle reaper.
export function registerHlsRoute(app: Express, previewService: PreviewService): void {
    app.use(
        '/hls',
        requireAuth,
        (req, res, next) => {
            const pipelineId = parseInt(req.path.split('/')[1] ?? '', 10);
            if (Number.isInteger(pipelineId)) previewService.keepalive(pipelineId);
            // Live HLS must never be cached by browsers or intermediaries; a stale
            // manifest is enough to make playback freeze on every refresh and then
            // fall out of the live window entirely.
            res.setHeader(
                'Cache-Control',
                'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0, no-transform',
            );
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Surrogate-Control', 'no-store');
            next();
        },
        express.static(previewService.baseDir, {
            etag: false,
            lastModified: false,
        }),
    );
}
