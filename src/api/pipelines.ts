import type { Express } from 'express';
import { parseName } from '../utils/inputLimits.js';
import type { Db } from '../types.js';
import type { OutputService } from '../services/outputs.js';
import type { PreviewService } from '../services/preview.js';
import type { SrtRelayService } from '../services/srtRelay.js';
import { isRenditionOutput } from '../utils/renditions.js';

export function registerPipelineApi(
    app: Express,
    db: Db,
    outputService: OutputService,
    previewService: PreviewService,
    srtRelayService: SrtRelayService,
): void {
    app.post('/api/pipelines', (_req, res) => {
        const pipeline = db.createPipeline();
        return res.status(201).json(pipeline);
    });

    app.get('/api/pipelines/:id', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        const pipeline = db.getPipeline(id);
        if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
        const streamId = `#!::r=live/${pipeline.streamKey},m=publish`;
        return res.json({
            ...pipeline,
            srtRelay: srtRelayService.getStats(),
            srtBonding: srtRelayService.getStreamStatus(streamId),
        });
    });

    app.post('/api/pipelines/:id', async (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        const existing = db.getPipeline(id);
        if (!existing) return res.status(404).json({ error: 'Pipeline not found' });

        const parsedName = parseName(req.body?.name);
        if ('error' in parsedName) return res.status(400).json({ error: parsedName.error });
        const name = parsedName.name;
        const streamKeyId = req.body?.streamKeyId as number | undefined;
        const keyChanged = streamKeyId !== undefined && streamKeyId !== existing.streamKeyId;

        if (keyChanged) {
            const outputs = db.listOutputsForPipeline(id);
            // Shared encodes idle-stop 15 s after the last output stops, so one may
            // still be desired-running right after the user stopped everything; only
            // the user's own outputs block the change.
            const active = outputs.some(
                (o) => !isRenditionOutput(o) && o.desiredState !== 'stopped',
            );
            if (active) {
                return res
                    .status(409)
                    .json({ error: 'Stop all outputs before changing the stream key' });
            }
            // A shared encode pulls the input by its key. Stop the ones still running
            // (desired-stopped first, see the pipeline delete below) so the next one
            // starts on the new key instead of holding the old pull.
            for (const r of outputs.filter(isRenditionOutput)) {
                if (r.desiredState === 'running') db.setOutputDesiredState(r.id, 'stopped');
                await outputService.stopAndWait(r.id);
            }
            // The preview pulls a fixed stream key and has no retry loop, so a
            // key reassignment would leave it pinned to the old key. Stop it;
            // the user can replay against the new key.
            previewService.stop(id);
        }

        // groupId is tri-state: the key may be absent (leave the pipeline's
        // group untouched), explicit null (clear it), or a number (reassign).
        let groupId: number | null | undefined;
        if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'groupId')) {
            const raw = req.body.groupId;
            if (raw === null) {
                groupId = null;
            } else {
                const n = Number(raw);
                if (!Number.isInteger(n) || !db.listPipelineGroups().some((g) => g.id === n)) {
                    return res.status(400).json({ error: 'invalid groupId' });
                }
                groupId = n;
            }
        }

        const updated = db.updatePipeline(id, name, streamKeyId, groupId);
        return res.json(updated);
    });

    app.delete('/api/pipelines/:id', async (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        if (!db.getPipeline(id)) return res.status(404).json({ error: 'Pipeline not found' });

        // Shared encodes follow their outputs and idle-stop 15 s after the last one
        // stops, so one may still be desired-running right after the user stopped
        // everything; only the user's own outputs block the delete.
        const active = db
            .listOutputsForPipeline(id)
            .some((o) => !isRenditionOutput(o) && o.desiredState !== 'stopped');
        if (active) {
            return res
                .status(409)
                .json({ error: 'Stop all outputs before deleting this pipeline' });
        }

        previewService.stop(id);
        const outputs = db.listOutputsForPipeline(id);
        await Promise.all(outputs.map((o) => outputService.retire(o.id)));

        try {
            db.deletePipeline(id);
            return res.json({ ok: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'could not delete pipeline';
            return res.status(409).json({ error: message });
        }
    });

    app.get('/api/pipelines/:id/logs', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
        if (!db.getPipeline(id)) return res.status(404).json({ error: 'Pipeline not found' });
        return res.json(db.getPipelineLogs(id));
    });
}
