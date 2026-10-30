import type { Express } from 'express';
import { validateOutputUrl, validateAudioEncoding, ENCODINGS } from '../utils/ffmpeg.js';
import type { Db } from '../types.js';
import type { OutputService } from '../services/outputs.js';
import { cyan } from '../utils/ansiColor.js';
import { checkOutputDestination, isInternalAppDestination } from '../utils/destination.js';
import { isRenditionOutput } from '../utils/renditions.js';
import { parseName } from '../utils/inputLimits.js';

// Validate an output's destination from the request body. It needs a valid URL
// and audio track selection; multiple tracks are only valid for an SRT
// destination since FLV/RTMP carries a single audio stream.
function parseDestination(
    body: unknown,
): { url: string; audioEncoding: string } | { error: string } {
    const b = body as Record<string, unknown> | null | undefined;
    const url = (b?.url as string | undefined)?.trim();
    if (!url || !validateOutputUrl(url)) {
        return {
            error: 'a valid url is required (rtmp://, rtmps://, srt://; no spaces or < > " characters)',
        };
    }
    const audioEncoding = validateAudioEncoding(b?.audioEncoding);
    if (audioEncoding === null) {
        return { error: 'invalid audioEncoding' };
    }
    if (!url.startsWith('srt://') && audioEncoding.includes(',')) {
        return { error: 'multiple audio tracks require an SRT destination' };
    }
    return { url, audioEncoding };
}

const RESTART_LOCKOUT_MS = 5000;
const MANAGED_ERROR = { error: 'Shared encodes are managed automatically' };
const RESERVED_APP_ERROR = 'the internal app is reserved for shared encodes';

interface OutputConfig {
    name: string;
    videoEncoding: string;
    url: string;
    audioEncoding: string;
}

// An output's settings from a request body, checked in the order the dashboard
// reports them. `kind` says which check failed, for the bulk route's messages:
// 'policy' errors (reserved app, blocked destination) are about the destination
// an operator pasted, so a bulk request names the output they belong to.
type ParsedOutputConfig =
    | { config: OutputConfig }
    | { error: string; kind: 'name' | 'policy' | 'field'; name: string };

async function parseOutputConfig(body: unknown): Promise<ParsedOutputConfig> {
    const b = body as Record<string, unknown> | null | undefined;
    const parsedName = parseName(b?.name);
    if ('error' in parsedName) return { error: parsedName.error, kind: 'name', name: '' };
    const { name } = parsedName;
    const videoEncoding = (b?.videoEncoding as string | undefined)?.trim() || 'copy';
    if (!ENCODINGS[videoEncoding]) {
        return { error: `unknown videoEncoding: ${videoEncoding}`, kind: 'field', name };
    }
    const destination = parseDestination(b);
    if ('error' in destination) return { error: destination.error, kind: 'field', name };
    if (await isInternalAppDestination(destination.url)) {
        return { error: RESERVED_APP_ERROR, kind: 'policy', name };
    }
    const blockedReason = await checkOutputDestination(destination.url);
    if (blockedReason) return { error: blockedReason, kind: 'policy', name };
    return { config: { name, videoEncoding, ...destination } };
}

export function registerOutputApi(app: Express, db: Db, outputService: OutputService): void {
    app.post('/api/pipelines/:pipelineId/outputs', async (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        const parsed = await parseOutputConfig(req.body);
        if ('error' in parsed) return res.status(400).json({ error: parsed.error });

        let output: ReturnType<Db['createOutput']>;
        try {
            output = db.createOutput({ pipelineId, ...parsed.config });
        } catch (error) {
            console.error('[outputs] failed to create output:', error);
            return res.status(500).json({
                error: error instanceof Error ? error.message : 'could not create output',
            });
        }
        console.log(cyan(`[outputs] user add requested: ${output.id} (${output.name})`));
        return res.status(201).json(output);
    });

    app.post('/api/pipelines/:pipelineId/outputs/bulk', async (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        const rawOutputs = req.body?.outputs;
        if (!Array.isArray(rawOutputs) || rawOutputs.length === 0)
            return res.status(400).json({ error: 'outputs array is required' });

        const validated: OutputConfig[] = [];
        for (const item of rawOutputs) {
            const parsed = await parseOutputConfig(item);
            if ('error' in parsed) {
                const error =
                    parsed.kind === 'name'
                        ? `each output needs a valid name: ${parsed.error}`
                        : parsed.kind === 'policy'
                          ? `${parsed.name}: ${parsed.error}`
                          : parsed.error;
                return res.status(400).json({ error });
            }
            validated.push(parsed.config);
        }

        let created: ReturnType<Db['createOutputs']>;
        try {
            created = db.createOutputs(validated.map((v) => ({ pipelineId, ...v })));
        } catch (error) {
            console.error('[outputs] failed to create outputs:', error);
            return res.status(500).json({
                error: error instanceof Error ? error.message : 'could not create outputs',
            });
        }
        console.log(
            cyan(
                `[outputs] user add-bulk requested: pipeline=${pipelineId} count=${created.length}`,
            ),
        );
        return res.status(201).json(created);
    });

    app.post('/api/pipelines/:pipelineId/outputs/start-all', (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        db.setDesiredStateForPipeline(pipelineId, 'running');
        const scheduled = outputService.restartPipelineOutputs(pipelineId, 0);
        console.log(
            cyan(
                `[outputs] user start-all requested: pipeline=${pipelineId} scheduled=${scheduled}`,
            ),
        );
        return res.json({ ok: true, scheduled });
    });

    app.post('/api/pipelines/:pipelineId/outputs/stop-all', (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        const outputs = db.listOutputsForPipeline(pipelineId);
        db.setDesiredStateForPipeline(pipelineId, 'stopped');
        for (const o of outputs) outputService.stop(o.id);
        console.log(
            cyan(
                `[outputs] user stop-all requested: pipeline=${pipelineId} count=${outputs.length}`,
            ),
        );
        return res.json({ ok: true });
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }
        if (isRenditionOutput(output)) return res.status(409).json(MANAGED_ERROR);

        // A running output keeps the destination and encoding its ffmpeg was started
        // with, so only its name may change: a body with any other setting is
        // refused, even a client holding stale config that sends the old values.
        const isRunning =
            output.desiredState !== 'stopped' || outputService.getStats(outId).status === 'running';
        if (isRunning) {
            const body = (req.body ?? {}) as Record<string, unknown>;
            if (Object.keys(body).some((key) => key !== 'name')) {
                return res
                    .status(409)
                    .json({ error: 'Stop the output before changing its settings' });
            }
            const renamed = parseName(body.name);
            if ('error' in renamed) return res.status(400).json({ error: renamed.error });
            const updated = db.updateOutput(outId, { ...output, name: renamed.name });
            console.log(cyan(`[outputs] user rename requested: ${outId} (${renamed.name})`));
            return res.json(updated);
        }

        // Like name and videoEncoding, a field left out keeps its stored value,
        // so a script sending only { name } can't silently reset the audio tracks.
        const body = (req.body ?? {}) as Record<string, unknown>;
        const parsed = await parseOutputConfig({
            name: body.name === undefined ? output.name : body.name,
            videoEncoding:
                (body.videoEncoding as string | undefined)?.trim() ?? output.videoEncoding,
            url: body.url === undefined ? output.url : body.url,
            audioEncoding:
                body.audioEncoding === undefined ? output.audioEncoding : body.audioEncoding,
        });
        if ('error' in parsed) return res.status(400).json({ error: parsed.error });
        const { name } = parsed.config;

        let updated: ReturnType<Db['updateOutput']>;
        try {
            updated = db.updateOutput(outId, parsed.config);
        } catch (error) {
            console.error('[outputs] failed to update output:', error);
            return res.status(500).json({
                error: error instanceof Error ? error.message : 'could not update output',
            });
        }
        console.log(cyan(`[outputs] user update requested: ${outId} (${name})`));
        return res.json(updated);
    });

    app.delete('/api/pipelines/:pipelineId/outputs', async (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        if (!db.getPipeline(pipelineId))
            return res.status(404).json({ error: 'Pipeline not found' });

        const outputs = db.listOutputsForPipeline(pipelineId);
        // Shared encodes do not block this: they follow their outputs and idle-stop
        // only after a grace period, so one may still be winding down right after
        // the user stopped everything. They are stopped and removed with the rest.
        const renditions = outputs.filter(isRenditionOutput);
        for (const o of outputs) {
            if (isRenditionOutput(o)) continue;
            if (o.desiredState !== 'stopped' || outputService.getStats(o.id).status === 'running') {
                return res.status(409).json({
                    error: `Output "${o.name}" is still running. Stop all outputs before clearing.`,
                });
            }
        }

        for (const r of renditions) await outputService.retire(r.id);
        db.deleteOutputsForPipeline(pipelineId);
        return res.json({ ok: true });
    });

    app.delete('/api/pipelines/:pipelineId/outputs/:outId', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }
        if (isRenditionOutput(output)) return res.status(409).json(MANAGED_ERROR);

        console.log(cyan(`[outputs] user delete requested: ${outId} (${output.name})`));
        await outputService.retire(outId);
        db.deleteOutput(outId);
        return res.json({ ok: true });
    });

    app.get('/api/pipelines/:pipelineId/outputs/:outId/errors', (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }

        return res.json(db.getOutputErrorHistory(outId));
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId/start', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }
        if (isRenditionOutput(output)) return res.status(409).json(MANAGED_ERROR);

        console.log(cyan(`[outputs] user start requested: ${outId} (${output.name})`));
        try {
            db.setOutputDesiredState(outId, 'running');
            await outputService.start(outId, { byUser: true });
            const stats = outputService.getStats(outId);
            return res.json({ ok: true, status: stats });
        } catch (err) {
            try {
                db.setOutputDesiredState(outId, 'stopped');
            } catch {
                /* best-effort */
            }
            return res.status(400).json({ error: (err as Error).message });
        }
    });

    // A double click (or two operators) must not restart the same output twice in a
    // row: every restart interrupts the destination. In-memory is enough, the
    // lockout is five seconds.
    const lastRestartAt = new Map<string, number>();
    app.post('/api/pipelines/:pipelineId/outputs/:outId/restart', (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }
        if (outputService.getStats(outId).status !== 'running') {
            return res.status(409).json({ error: 'Output is not running' });
        }
        const now = Date.now();
        for (const [id, at] of lastRestartAt) {
            if (now - at >= RESTART_LOCKOUT_MS) lastRestartAt.delete(id);
        }
        if (lastRestartAt.has(outId)) {
            return res.status(409).json({
                error: 'Restarted moments ago; wait a few seconds before restarting again',
            });
        }
        if (!outputService.restart(outId)) {
            return res.status(409).json({ error: 'Output is not running' });
        }
        lastRestartAt.set(outId, now);
        console.log(cyan(`[outputs] user restart requested: ${outId} (${output.name})`));
        return res.json({ ok: true });
    });

    app.post('/api/pipelines/:pipelineId/outputs/:outId/stop', async (req, res) => {
        const { pipelineId, outId } = req.params;
        const output = db.getOutput(outId);
        if (!output || output.pipelineId !== parseInt(pipelineId)) {
            return res.status(404).json({ error: 'Output not found' });
        }
        if (isRenditionOutput(output)) return res.status(409).json(MANAGED_ERROR);

        console.log(cyan(`[outputs] user stop requested: ${outId} (${output.name})`));
        db.setOutputDesiredState(outId, 'stopped');
        outputService.stop(outId);
        return res.json({ ok: true });
    });
}
