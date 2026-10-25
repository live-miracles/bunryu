import type { Express } from 'express';
import {
    validateOutputUrl,
    validateAudioEncoding,
    isTranslationAudio,
    ENCODINGS,
    MIN_VOLUME_DB,
} from '../utils/ffmpeg.js';
import type { Db, TranslationInput } from '../types.js';
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

function parseTranslation(body: unknown): TranslationInput | null | undefined | { error: string } {
    const raw = (body as Record<string, unknown> | null | undefined)?.translation;
    if (raw === undefined) return undefined;
    if (raw === null || raw === false) return null;
    if (typeof raw !== 'object') return { error: 'translation must be an object or null' };
    const value = raw as Record<string, unknown>;
    const translatorStreamKey = (value.translatorStreamKey as string | undefined)?.trim();
    if (!translatorStreamKey) {
        return { error: 'translation translatorStreamKey is required' };
    }
    // undefined = field omitted (the db fills its default); a string = error text.
    const numeric = (key: string, min: number, max: number): number | string | undefined => {
        if (value[key] === undefined) return undefined;
        const n = Number(value[key]);
        return Number.isFinite(n) && n >= min && n <= max ? n : `${key} is invalid`;
    };
    const sourceTrackIndex = numeric('sourceTrackIndex', 0, 49);
    const translatorTrackIndex = numeric('translatorTrackIndex', 0, 49);
    const delay = numeric('translationDelayMs', 0, 5000);
    const thresholdDb = numeric('voiceThresholdDb', -100, 0);
    const duckVolumeDb = numeric('duckVolumeDb', MIN_VOLUME_DB, 0);
    const duckDurationMs = numeric('duckDurationMs', 0, 30000);
    const restoreSilenceMs = numeric('restoreSilenceMs', 0, 30000);
    const restoreVolumeDb = numeric('restoreVolumeDb', MIN_VOLUME_DB, 0);
    const restoreDurationMs = numeric('restoreDurationMs', 0, 30000);
    if (typeof sourceTrackIndex === 'string') return { error: sourceTrackIndex };
    if (typeof translatorTrackIndex === 'string') return { error: translatorTrackIndex };
    if (typeof delay === 'string') return { error: delay };
    if (typeof thresholdDb === 'string') return { error: thresholdDb };
    if (typeof duckVolumeDb === 'string') return { error: duckVolumeDb };
    if (typeof duckDurationMs === 'string') return { error: duckDurationMs };
    if (typeof restoreSilenceMs === 'string') return { error: restoreSilenceMs };
    if (typeof restoreVolumeDb === 'string') return { error: restoreVolumeDb };
    if (typeof restoreDurationMs === 'string') return { error: restoreDurationMs };
    return {
        translatorStreamKey,
        ...(value.sourceTrackIndex === undefined ? {} : { sourceTrackIndex }),
        ...(value.translatorTrackIndex === undefined ? {} : { translatorTrackIndex }),
        ...(value.translationDelayMs === undefined ? {} : { translationDelayMs: delay }),
        ...(value.voiceThresholdDb === undefined ? {} : { voiceThresholdDb: thresholdDb }),
        ...(value.duckVolumeDb === undefined ? {} : { duckVolumeDb }),
        ...(value.duckDurationMs === undefined ? {} : { duckDurationMs }),
        ...(value.restoreSilenceMs === undefined ? {} : { restoreSilenceMs }),
        ...(value.restoreVolumeDb === undefined ? {} : { restoreVolumeDb }),
        ...(value.restoreDurationMs === undefined ? {} : { restoreDurationMs }),
    };
}

export function registerOutputApi(app: Express, db: Db, outputService: OutputService): void {
    app.post('/api/pipelines/:pipelineId/outputs', async (req, res) => {
        const pipelineId = parseInt(req.params.pipelineId);
        if (isNaN(pipelineId)) return res.status(400).json({ error: 'invalid pipelineId' });
        const ownPipeline = db.getPipeline(pipelineId);
        if (!ownPipeline) return res.status(404).json({ error: 'Pipeline not found' });

        const parsedName = parseName(req.body?.name);
        const name = 'name' in parsedName ? parsedName.name : '';
        const videoEncoding = (req.body?.videoEncoding as string | undefined)?.trim() || 'copy';
        const parsed = parseDestination(req.body);

        if ('error' in parsedName) return res.status(400).json({ error: parsedName.error });
        if (!ENCODINGS[videoEncoding])
            return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
        if ('error' in parsed) return res.status(400).json({ error: parsed.error });
        if (await isInternalAppDestination(parsed.url)) {
            return res.status(400).json({ error: RESERVED_APP_ERROR });
        }
        const blockedReason = await checkOutputDestination(parsed.url);
        if (blockedReason) return res.status(400).json({ error: blockedReason });
        const translation = parseTranslation(req.body);
        if (translation && 'error' in translation) return res.status(400).json(translation);
        if (translation && !db.getPipelineByStreamKey(translation.translatorStreamKey)) {
            return res.status(400).json({ error: 'translation translator pipeline not found' });
        }
        if (translation && translation.translatorStreamKey === ownPipeline.streamKey) {
            return res
                .status(400)
                .json({ error: 'translation translator must be another pipeline' });
        }
        if (isTranslationAudio(parsed.audioEncoding) && !translation) {
            return res
                .status(400)
                .json({ error: 'translation audio requires translation settings' });
        }
        if (!isTranslationAudio(parsed.audioEncoding) && translation) {
            return res
                .status(400)
                .json({ error: 'translation settings require translation audio' });
        }

        let output: ReturnType<Db['createOutput']>;
        try {
            output = db.createOutput({
                pipelineId,
                name,
                videoEncoding,
                url: parsed.url,
                audioEncoding: parsed.audioEncoding,
                translation,
            });
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

        const validated: {
            name: string;
            videoEncoding: string;
            url: string;
            audioEncoding: string;
        }[] = [];
        for (const item of rawOutputs) {
            const parsedName = parseName(item?.name);
            const name = 'name' in parsedName ? parsedName.name : '';
            const videoEncoding = (item?.videoEncoding as string | undefined)?.trim() || 'copy';
            const parsed = parseDestination(item);

            if ('error' in parsedName) {
                return res
                    .status(400)
                    .json({ error: `each output needs a valid name: ${parsedName.error}` });
            }
            if (!ENCODINGS[videoEncoding])
                return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
            if ('error' in parsed) return res.status(400).json({ error: parsed.error });
            if (await isInternalAppDestination(parsed.url)) {
                return res.status(400).json({ error: `${name}: ${RESERVED_APP_ERROR}` });
            }
            const blockedReason = await checkOutputDestination(parsed.url);
            if (blockedReason) return res.status(400).json({ error: `${name}: ${blockedReason}` });

            validated.push({
                name,
                videoEncoding,
                url: parsed.url,
                audioEncoding: parsed.audioEncoding,
            });
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

        const parsedName =
            req.body?.name === undefined ? { name: output.name } : parseName(req.body.name);
        const name = 'name' in parsedName ? parsedName.name : '';
        const videoEncoding =
            (req.body?.videoEncoding as string | undefined)?.trim() ?? output.videoEncoding;
        // Like name and videoEncoding, a field left out keeps its stored value,
        // so a script sending only { name } can't silently reset the audio tracks.
        const body = (req.body ?? {}) as Record<string, unknown>;
        const parsed = parseDestination({
            url: body.url === undefined ? output.url : body.url,
            audioEncoding:
                body.audioEncoding === undefined ? output.audioEncoding : body.audioEncoding,
        });

        if ('error' in parsedName) return res.status(400).json({ error: parsedName.error });
        if (!ENCODINGS[videoEncoding])
            return res.status(400).json({ error: `unknown videoEncoding: ${videoEncoding}` });
        if ('error' in parsed) return res.status(400).json({ error: parsed.error });
        if (await isInternalAppDestination(parsed.url)) {
            return res.status(400).json({ error: RESERVED_APP_ERROR });
        }
        const blockedReason = await checkOutputDestination(parsed.url);
        if (blockedReason) return res.status(400).json({ error: blockedReason });
        const parsedTranslation = parseTranslation(req.body);
        if (parsedTranslation && 'error' in parsedTranslation)
            return res.status(400).json(parsedTranslation);
        // Preserve an existing translation when an older client omits the
        // optional field, but always clear it when switching to normal audio.
        const translation =
            parsedTranslation === undefined && isTranslationAudio(parsed.audioEncoding)
                ? output.translation
                : parsedTranslation;
        const ownPipeline = db.getPipeline(output.pipelineId);
        if (translation && !db.getPipelineByStreamKey(translation.translatorStreamKey)) {
            return res.status(400).json({ error: 'translation translator pipeline not found' });
        }
        if (translation && translation.translatorStreamKey === ownPipeline?.streamKey) {
            return res
                .status(400)
                .json({ error: 'translation translator must be another pipeline' });
        }
        if (isTranslationAudio(parsed.audioEncoding) && !translation) {
            return res
                .status(400)
                .json({ error: 'translation audio requires translation settings' });
        }
        if (!isTranslationAudio(parsed.audioEncoding) && translation) {
            return res
                .status(400)
                .json({ error: 'translation settings require translation audio' });
        }

        let updated: ReturnType<Db['updateOutput']>;
        try {
            updated = db.updateOutput(outId, {
                name,
                videoEncoding,
                url: parsed.url,
                audioEncoding: parsed.audioEncoding,
                translation,
            });
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

        for (const r of renditions) {
            // Desired-stopped first, or the output service respawns the process it
            // was just asked to stop (see removeRendition in services/renditions.ts).
            db.setOutputDesiredState(r.id, 'stopped');
            await outputService.stopAndWait(r.id);
            outputService.clearRetryState(r.id);
        }
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
        await outputService.stopAndWait(outId);
        outputService.clearRetryState(outId);
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
        // Translation outputs are published by the translation mixer, which has its
        // own restart logic; this service has no process to restart for them.
        if (isTranslationAudio(output.audioEncoding)) {
            return res
                .status(409)
                .json({ error: 'Translation outputs are restarted by the translation mixer' });
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
