import type { Express } from 'express';
import { isValidPublicHost, parseName } from '../utils/inputLimits.js';
import type { Db } from '../types.js';
import type { InputState } from '../services/inputState.js';
import type { OutputService } from '../services/outputs.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';
import { generateSrtPassphrase, writeSrtPassphrase } from '../utils/srtPassphrase.js';

const MAX_PIPELINE_GROUPS = 50;
const MAX_PIPELINE_GROUP_NAME_LENGTH = 80;

// Custom pipeline/output display order: [{id: <pipelineId>, outs: [<outputId>, ...]}].
// This is a pure UI concern — the backend only stores and returns it verbatim;
// it never reorders pipelines/outputs itself or keeps this in sync with
// creates/deletes. The frontend reconciles it against the current pipeline/
// output list at render time (anything missing here just sorts to the end),
// so stale or incomplete entries (deleted pipelines, new ones never dragged)
// are harmless and self-heal on the next read.
function normalizeLayoutOrder(value: unknown): { id: number; outs: string[] }[] | null {
    if (!Array.isArray(value)) return null;

    const order: { id: number; outs: string[] }[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        if (!Number.isInteger(row.id)) return null;
        if (!Array.isArray(row.outs) || !row.outs.every((o) => typeof o === 'string')) return null;
        order.push({ id: row.id as number, outs: row.outs as string[] });
    }
    return order;
}

// Whole-collection replace for pipeline groups: [{id?, name}], in the array's
// order (which becomes each group's position). An id is only present for a
// group the client already knows about; an id absent from the array means
// "delete this group" (its member pipelines fall back to ungrouped).
function normalizePipelineGroups(value: unknown): { id?: number; name: string }[] | null {
    if (!Array.isArray(value)) return null;
    if (value.length > MAX_PIPELINE_GROUPS) return null;

    const groups: { id?: number; name: string }[] = [];
    const seenIds = new Set<number>();
    for (const item of value) {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        const name = typeof row.name === 'string' ? row.name.trim() : '';
        if (!name || name.length > MAX_PIPELINE_GROUP_NAME_LENGTH) return null;

        if (row.id === undefined) {
            groups.push({ name });
            continue;
        }
        const id = Number(row.id);
        if (!Number.isInteger(id) || id < 1 || seenIds.has(id)) return null;
        seenIds.add(id);
        groups.push({ id, name });
    }
    return groups;
}

export function registerSettingsApi(
    app: Express,
    db: Db,
    inputState: InputState,
    outputService: OutputService,
    diagnostics: DiagnosticsLogger,
): void {
    app.post('/api/settings/general', (req, res) => {
        const parsedName = parseName(req.body?.name);
        if ('error' in parsedName) return res.status(400).json({ error: parsedName.error });
        const name = parsedName.name;
        const rawHost = req.body?.publicHost;
        if (rawHost !== undefined && rawHost !== null && typeof rawHost !== 'string') {
            return res.status(400).json({ error: 'publicHost must be a string' });
        }
        const publicHost = typeof rawHost === 'string' ? rawHost.trim() : null;
        if (publicHost && !isValidPublicHost(publicHost)) {
            return res.status(400).json({ error: 'publicHost must be a hostname or IP address' });
        }

        db.setSetting('serverName', name);
        if (publicHost !== null) db.setSetting('publicHost', publicHost);

        return res.json({
            serverName: name,
            publicHost: publicHost ?? db.getSetting('publicHost') ?? '',
        });
    });

    app.post('/api/settings/layout-order', (req, res) => {
        const order = normalizeLayoutOrder(req.body?.order);
        if (order === null) {
            return res.status(400).json({ error: 'Invalid layout order' });
        }

        db.setSetting('layoutOrder', JSON.stringify(order));
        return res.json({ layoutOrder: order });
    });

    app.post('/api/settings/pipeline-groups', (req, res) => {
        const groups = normalizePipelineGroups(req.body?.groups);
        if (groups === null) {
            return res.status(400).json({ error: 'Invalid pipeline group configuration' });
        }

        const saved = db.replacePipelineGroups(groups);
        return res.json({ groups: saved });
    });

    app.post('/api/settings/regenerate-stream-keys', (req, res) => {
        const pipelines = db.listPipelines();
        if (pipelines.length > 0) {
            return res
                .status(409)
                .json({ error: 'Cannot regenerate stream keys while pipelines exist' });
        }
        const streamKeys = db.regenerateStreamKeys();
        return res.json({ streamKeys });
    });

    // Rewrites the passphrase in srs.conf and goryu.json only: SRS and Goryu read
    // them at startup, so the new value is enforced after both restart (a reboot or
    // container restart), and the app keeps showing the value they run with until
    // then. The app never signals either service. Refused while anything is live or
    // running so that a restart done soon after cannot cut a stream unannounced.
    app.post('/api/settings/reset-srt-passphrase', (_req, res) => {
        const liveInputs = db.listPipelines().filter((p) => inputState.isLive(p.id)).length;
        const activeOutputs = db
            .listOutputs()
            .filter((o) => outputService.getStats(o.id).status !== 'stopped').length;
        if (liveInputs > 0 || activeOutputs > 0) {
            return res.status(409).json({
                error:
                    'Cannot reset the SRT passphrase while inputs are live or outputs are running ' +
                    `(${liveInputs} live input(s), ${activeOutputs} active output(s))`,
            });
        }

        try {
            const srtPassphrase = generateSrtPassphrase();
            writeSrtPassphrase(srtPassphrase);
            console.log(
                '[settings] SRT passphrase reset in srs.conf and goryu.json; it applies after SRS and Goryu restart',
            );
            diagnostics.event('srt-passphrase-reset', { pendingRestart: true });
            return res.json({ ok: true });
        } catch (err) {
            console.error('[settings] SRT passphrase reset failed:', err);
            diagnostics.event('srt-passphrase-reset-failed', { error: String(err) });
            return res
                .status(500)
                .json({ error: `Could not reset the SRT passphrase: ${String(err)}` });
        }
    });
}
