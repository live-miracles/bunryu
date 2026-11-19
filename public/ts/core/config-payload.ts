import {
    outputsToCopy,
    parseOutputItems,
    splitNewOutputs,
    type OutputPayloadFields,
} from './output-payload.js';

// What the sidebar's Copy / Paste configuration buttons put on the clipboard and read back: the
// groups and every pipeline with its group and outputs, to set up another Bunryu instance.
// Stream keys are not part of it: each instance has its own, and a pasted pipeline takes one
// of the target's. Pure: the dashboard feature does the calls.

// The same bounds the server enforces on a name and on the number of groups.
export const MAX_NAME_LENGTH = 80;
export const MAX_PIPELINE_GROUPS = 50;

export interface ConfigPipeline {
    name: string;
    group: string | null;
    outputs: OutputPayloadFields[];
}

export interface ConfigPayload {
    groups: string[];
    pipelines: ConfigPipeline[];
}

const key = (name: string) => name.trim().toLowerCase();

export interface CopyablePipeline {
    name: string;
    groupId: number | null;
    outs: readonly OutputPayloadFields[];
}

// The groups in their sidebar order and the pipelines with the group's name; shared encodes
// are left out like in a pipeline's own Copy.
export function configToCopy(
    groups: readonly { id: number; name: string; position: number }[],
    pipelines: readonly CopyablePipeline[],
): ConfigPayload {
    const ordered = [...groups].sort((a, b) => a.position - b.position);
    const nameOf = new Map(ordered.map((g) => [g.id, g.name]));
    return {
        groups: ordered.map((g) => g.name),
        pipelines: pipelines.map((p) => ({
            name: p.name,
            group: p.groupId === null ? null : (nameOf.get(p.groupId) ?? null),
            outputs: outputsToCopy(p.outs),
        })),
    };
}

function parseLabel(value: unknown, what: string): { name: string } | { error: string } {
    if (typeof value !== 'string' || !value.trim()) {
        return { error: `Each ${what} must have a non-empty name.` };
    }
    const name = value.trim();
    if (name.length > MAX_NAME_LENGTH) {
        return { error: `A ${what} name must be at most ${MAX_NAME_LENGTH} characters.` };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) {
        return { error: `A ${what} name contains control characters.` };
    }
    return { name };
}

export function parseConfigPayload(text: string): { config: ConfigPayload } | { error: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { error: 'Clipboard content is not valid JSON.' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'Expected a configuration copied with Copy configuration.' };
    }
    const { groups: rawGroups, pipelines: rawPipelines } = parsed as Record<string, unknown>;
    if (!Array.isArray(rawPipelines)) {
        return { error: 'Expected a configuration copied with Copy configuration.' };
    }
    if (rawGroups !== undefined && !Array.isArray(rawGroups)) {
        return { error: 'The configuration groups must be a list.' };
    }

    // Group names in order; a pipeline's group that is not listed is added after them.
    const groups: string[] = [];
    const seenGroups = new Set<string>();
    const addGroup = (name: string) => {
        if (seenGroups.has(key(name))) return;
        seenGroups.add(key(name));
        groups.push(name);
    };
    for (const raw of rawGroups ?? []) {
        const group = parseLabel(raw, 'group');
        if ('error' in group) return group;
        addGroup(group.name);
    }

    const pipelines: ConfigPipeline[] = [];
    const seenPipelines = new Set<string>();
    for (const raw of rawPipelines) {
        if (!raw || typeof raw !== 'object') return { error: 'Invalid pipeline in clipboard.' };
        const item = raw as Record<string, unknown>;
        const name = parseLabel(item.name, 'pipeline');
        if ('error' in name) return name;
        if (seenPipelines.has(key(name.name))) {
            return { error: `The pipeline "${name.name}" is in the clipboard twice.` };
        }
        seenPipelines.add(key(name.name));

        let group: string | null = null;
        if (item.group !== undefined && item.group !== null) {
            const parsedGroup = parseLabel(item.group, 'group');
            if ('error' in parsedGroup) return parsedGroup;
            group = parsedGroup.name;
            addGroup(group);
        }
        if (item.outputs !== undefined && !Array.isArray(item.outputs)) {
            return { error: `The outputs of "${name.name}" must be a list.` };
        }
        const outputs = parseOutputItems((item.outputs as unknown[] | undefined) ?? []);
        if ('error' in outputs) return outputs;
        pipelines.push({ name: name.name, group, outputs: outputs.outputs });
    }
    if (pipelines.length === 0 && groups.length === 0) {
        return { error: 'No pipelines or groups found in clipboard.' };
    }
    return { config: { groups, pipelines } };
}

export interface ExistingPipeline {
    id: string;
    name: string;
    groupId: number | null;
    // The destinations it has already.
    urls: readonly string[];
}

export interface PipelinePastePlan {
    name: string;
    // The pipeline it adds to, or null when it is created.
    existingId: string | null;
    // The group to put it in: a new pipeline's own, or the group of an existing one that has
    // none. Null leaves it as it is (an existing pipeline in a group keeps that group).
    setGroup: string | null;
    // For a new pipeline: the key it takes, the next free one or, once those are used up,
    // the last key (`sharedKey`).
    streamKeyId: number | null;
    sharedKey: boolean;
    outputs: OutputPayloadFields[];
    skippedOutputs: number;
}

export interface ConfigPastePlan {
    newGroups: string[];
    pipelines: PipelinePastePlan[];
}

// What a paste does on this instance. Groups and pipelines are matched by name, ignoring
// case. An existing pipeline gets the pasted outputs it does not have yet (the same rule as
// pasting outputs into a pipeline) and a group only when it has none; a pipeline that is not
// here is created.
export function planConfigPaste(
    config: ConfigPayload,
    existing: {
        groups: readonly { id: number; name: string }[];
        pipelines: readonly ExistingPipeline[];
        // Every stream key, in slot order, with whether a pipeline has it.
        streamKeys: readonly { id: number; taken: boolean }[];
    },
): ConfigPastePlan | { error: string } {
    const haveGroup = new Set(existing.groups.map((g) => key(g.name)));
    const newGroups = config.groups.filter((g) => !haveGroup.has(key(g)));
    if (existing.groups.length + newGroups.length > MAX_PIPELINE_GROUPS) {
        return {
            error: `Pasting would make ${existing.groups.length + newGroups.length} groups; at most ${MAX_PIPELINE_GROUPS} are allowed.`,
        };
    }

    const byName = new Map<string, ExistingPipeline>();
    for (const p of existing.pipelines) if (!byName.has(key(p.name))) byName.set(key(p.name), p);
    const freeKeys = existing.streamKeys.filter((k) => !k.taken).map((k) => k.id);
    const lastKey = existing.streamKeys.at(-1)?.id ?? null;

    const pipelines: PipelinePastePlan[] = [];
    for (const pasted of config.pipelines) {
        const match = byName.get(key(pasted.name));
        if (match) {
            const { fresh, skipped } = splitNewOutputs(match.urls, pasted.outputs);
            pipelines.push({
                name: match.name,
                existingId: match.id,
                setGroup: match.groupId === null ? pasted.group : null,
                streamKeyId: null,
                sharedKey: false,
                outputs: fresh,
                skippedOutputs: skipped.length,
            });
            continue;
        }
        const free = freeKeys.shift();
        pipelines.push({
            name: pasted.name,
            existingId: null,
            setGroup: pasted.group,
            streamKeyId: free ?? lastKey,
            sharedKey: free === undefined,
            outputs: pasted.outputs,
            skippedOutputs: 0,
        });
    }
    return { newGroups, pipelines };
}

// Whether the plan changes anything.
export function planHasWork(plan: ConfigPastePlan): boolean {
    return (
        plan.newGroups.length > 0 ||
        plan.pipelines.some(
            (p) => p.existingId === null || p.setGroup !== null || p.outputs.length > 0,
        )
    );
}

export interface ConfigPasteResult {
    groupsCreated: number;
    pipelinesCreated: number;
    pipelinesGrouped: number;
    outputsAdded: number;
    outputsSkipped: number;
    // New pipelines that got a key another pipeline already has.
    sharedKeys: number;
    // Steps the server refused (its message was shown).
    failed: number;
}

// What the operator is told once a paste is done: a warning when anything was skipped, shares
// a key or failed.
export function configPasteMessage(r: ConfigPasteResult): {
    text: string;
    tone: 'success' | 'warning';
} {
    const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
    const done: string[] = [];
    if (r.pipelinesCreated > 0) done.push(`created ${n(r.pipelinesCreated, 'pipeline')}`);
    if (r.groupsCreated > 0) done.push(`created ${n(r.groupsCreated, 'group')}`);
    if (r.pipelinesGrouped > 0) done.push(`put ${n(r.pipelinesGrouped, 'pipeline')} in a group`);
    if (r.outputsAdded > 0) done.push(`added ${n(r.outputsAdded, 'output')}`);
    const parts = [done.length > 0 ? `Pasted: ${done.join(', ')}.` : 'Nothing was added.'];
    if (r.outputsSkipped > 0) {
        parts.push(
            `Skipped ${n(r.outputsSkipped, 'output')} with a destination the pipeline already uses.`,
        );
    }
    if (r.sharedKeys > 0) {
        parts.push(
            `${n(r.sharedKeys, 'new pipeline')} share${r.sharedKeys === 1 ? 's' : ''} the last stream key because the keys ran out; give them their own.`,
        );
    }
    if (r.failed > 0) parts.push(`${n(r.failed, 'step')} failed.`);
    const warn = r.outputsSkipped > 0 || r.sharedKeys > 0 || r.failed > 0;
    return { text: parts.join(' '), tone: warn ? 'warning' : 'success' };
}
