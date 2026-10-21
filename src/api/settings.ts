import type { Express } from 'express';
import { isValidPublicHost, parseName } from '../utils/inputLimits.js';
import type { Db, HostProbeTarget } from '../types.js';
import { checkProbeAddress, resolveAddresses } from '../utils/destination.js';

const MAX_HOST_PROBE_TARGETS = 10;
const MAX_PIPELINE_GROUPS = 50;
const MAX_PIPELINE_GROUP_NAME_LENGTH = 80;

function normalizeHostProbeTargets(value: unknown): HostProbeTarget[] | null {
    // Reject (not silently treat as "clear everything"): this used to double
    // as an implicit no-op default back when it was one optional field among
    // several on a combined /api/settings payload, but on this endpoint's own
    // dedicated route a missing/malformed field is almost certainly a client
    // bug, not intent to wipe every configured target. Send an explicit empty
    // array to actually clear them.
    if (!Array.isArray(value)) return null;

    const targets: HostProbeTarget[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        const slot = Number(row.slot);
        const label = typeof row.label === 'string' ? row.label.trim() : '';
        const host = typeof row.host === 'string' ? row.host.trim() : '';
        const port = Number(row.port);

        if (!Number.isInteger(slot) || slot < 1 || slot > MAX_HOST_PROBE_TARGETS) return null;
        if (!label || !host) return null;
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

        targets.push({ slot, label, host, port });
    }

    if (targets.length > MAX_HOST_PROBE_TARGETS) return null;
    if (new Set(targets.map((target) => target.slot)).size !== targets.length) return null;
    return targets.sort((a, b) => a.slot - b.slot);
}

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

export function registerSettingsApi(app: Express, db: Db): void {
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

    app.post('/api/settings/host-probes', async (req, res) => {
        const hostProbeTargets = normalizeHostProbeTargets(req.body?.hostProbeTargets);
        if (hostProbeTargets === null) {
            return res.status(400).json({ error: 'Invalid host probe target configuration' });
        }
        // The probe re-checks the resolved address on every connect; rejecting
        // here too just gives the operator the reason at save time.
        for (const target of hostProbeTargets) {
            for (const address of await resolveAddresses(target.host)) {
                const reason = checkProbeAddress(address);
                if (reason) return res.status(400).json({ error: `${target.label}: ${reason}` });
            }
        }

        db.replaceHostProbeTargets(hostProbeTargets);

        return res.json({ hostProbeTargets });
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
}
