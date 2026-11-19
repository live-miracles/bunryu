import * as api from '../core/api.js';
import { state } from '../core/state.js';
import { copyText, showNotice, withBusy } from '../core/utils.js';
import {
    configPasteMessage,
    configToCopy,
    parseConfigPayload,
    planConfigPaste,
    planHasWork,
    type ConfigPasteResult,
} from '../core/config-payload.js';
import { refreshAfterMutation } from './dashboard.js';

// Settings' Copy / Paste configuration: every group, pipeline and output on this instance
// to the clipboard, and from the clipboard into this one (see core/config-payload.ts).

function groupsInOrder() {
    return [...(state.config.groups ?? [])].sort((a, b) => a.position - b.position);
}

export async function copyConfig(): Promise<void> {
    const config = configToCopy(groupsInOrder(), state.pipelines);
    await copyText(JSON.stringify(config, null, 2));
}

// Adds what the clipboard has and this instance lacks; nothing that exists is changed except
// that a pipeline with no group gets the pasted one, so it works while outputs run. The server
// answers one pipeline at a time, so a step it refuses is counted and shown and the rest go on.
export async function pasteConfig(btn: HTMLButtonElement): Promise<void> {
    let text: string;
    try {
        text = await navigator.clipboard.readText();
    } catch {
        api.showError('Could not read clipboard. Please allow clipboard access.');
        return;
    }
    const parsed = parseConfigPayload(text);
    if ('error' in parsed) {
        api.showError(parsed.error);
        return;
    }

    const takenKeys = new Set(state.pipelines.map((p) => p.streamKeyId));
    const plan = planConfigPaste(parsed.config, {
        groups: state.config.groups ?? [],
        pipelines: state.pipelines.map((p) => ({
            id: p.id,
            name: p.name,
            groupId: p.groupId,
            urls: p.outs.map((o) => o.url),
        })),
        streamKeys: [...(state.config.streamKeys ?? [])]
            .sort((a, b) => a.slot - b.slot)
            .map((k) => ({ id: k.id, taken: takenKeys.has(k.id) })),
    });
    if ('error' in plan) {
        api.showError(plan.error);
        return;
    }
    if (!planHasWork(plan)) {
        const skipped = plan.pipelines.reduce((sum, p) => sum + p.skippedOutputs, 0);
        showNotice(
            configPasteMessage({ ...emptyResult(), outputsSkipped: skipped }).text,
            'warning',
        );
        return;
    }

    await withBusy(btn, async () => {
        const result = emptyResult();
        // Every group is made first, in one save: the server replaces the whole list, so this
        // sends the groups that exist as well, which keeps their ids.
        const groupIds = new Map(
            (state.config.groups ?? []).map((g) => [g.name.trim().toLowerCase(), g.id]),
        );
        if (plan.newGroups.length > 0) {
            const saved = await api.updatePipelineGroups([
                ...groupsInOrder().map((g) => ({ id: g.id, name: g.name })),
                ...plan.newGroups.map((name) => ({ name })),
            ]);
            if (!saved) return;
            state.config.groups = saved.groups;
            for (const g of saved.groups) groupIds.set(g.name.trim().toLowerCase(), g.id);
            result.groupsCreated = plan.newGroups.length;
        }
        const groupId = (name: string | null) =>
            name === null ? null : (groupIds.get(name.trim().toLowerCase()) ?? null);

        for (const item of plan.pipelines) {
            let pipelineId = item.existingId;
            if (pipelineId === null) {
                const created = await api.createPipeline({
                    name: item.name,
                    streamKeyId: item.streamKeyId,
                    groupId: groupId(item.setGroup),
                });
                if (!created) {
                    result.failed++;
                    continue;
                }
                pipelineId = String(created.id);
                result.pipelinesCreated++;
                if (item.sharedKey) result.sharedKeys++;
            } else if (item.setGroup !== null) {
                const grouped = await api.updatePipeline(
                    pipelineId,
                    item.name,
                    undefined,
                    groupId(item.setGroup),
                );
                if (grouped) result.pipelinesGrouped++;
                else result.failed++;
            }
            result.outputsSkipped += item.skippedOutputs;
            if (item.outputs.length > 0) {
                const added = await api.createOutputsBulk(pipelineId, item.outputs);
                if (added) result.outputsAdded += item.outputs.length;
                else result.failed++;
            }
        }
        await refreshAfterMutation();
        const message = configPasteMessage(result);
        showNotice(message.text, message.tone);
    });
}

function emptyResult(): ConfigPasteResult {
    return {
        groupsCreated: 0,
        pipelinesCreated: 0,
        pipelinesGrouped: 0,
        outputsAdded: 0,
        outputsSkipped: 0,
        sharedKeys: 0,
        failed: 0,
    };
}
