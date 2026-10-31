import * as api from '../core/api.js';
import { state } from '../core/state.js';
import { withBusy, confirmDialog } from '../core/utils.js';
import { refreshAfterMutation } from './dashboard.js';
import type { PipelineGroup } from '../types.js';

// The sidebar's group controls: add, rename and delete. Reordering groups and moving
// pipelines between them is drag-and-drop in render.ts.
const MAX_PIPELINE_GROUP_NAME_LENGTH = 80;
const MAX_PIPELINE_GROUPS = 50;

type GroupDraft = { id?: number; name: string };

function sortedGroups(): PipelineGroup[] {
    return [...(state.config.groups ?? [])].sort((a, b) => a.position - b.position);
}

function groupDrafts(): GroupDraft[] {
    return sortedGroups().map((g) => ({ id: g.id, name: g.name }));
}

// Every change is saved on the spot: the server replaces the whole list, so this sends
// the full list with the one change applied. Nothing is drawn ahead of the answer, so
// a failed save leaves the sidebar showing what the server still has.
async function saveGroups(next: GroupDraft[], btn?: HTMLButtonElement | null): Promise<boolean> {
    let saved = false;
    await withBusy(btn, async () => {
        const result = await api.updatePipelineGroups(next);
        if (!result) return;
        state.config.groups = result.groups;
        saved = true;
        await refreshAfterMutation();
    });
    return saved;
}

function groupNameInput(): HTMLInputElement {
    return document.getElementById('pipe-group-name-input') as HTMLInputElement;
}

function openPipelineGroupModal(group?: PipelineGroup): void {
    (document.getElementById('pipe-group-id-input') as HTMLInputElement).value = group
        ? String(group.id)
        : '';
    document.getElementById('pipe-group-modal-title')!.textContent = group
        ? 'Rename Group'
        : 'Add Group';
    const nameEl = groupNameInput();
    nameEl.value = group?.name ?? '';
    nameEl.classList.remove('input-error');
    (document.getElementById('pipe-group-modal') as HTMLDialogElement).showModal();
    nameEl.focus();
    nameEl.select();
}

export function addPipelineGroup(): void {
    if (sortedGroups().length >= MAX_PIPELINE_GROUPS) {
        api.showError(`At most ${MAX_PIPELINE_GROUPS} groups are allowed.`);
        return;
    }
    openPipelineGroupModal();
}

export function editPipelineGroup(id: number): void {
    const group = sortedGroups().find((g) => g.id === id);
    if (group) openPipelineGroupModal(group);
}

export async function submitPipelineGroupForm(btn?: HTMLButtonElement | null): Promise<void> {
    const nameEl = groupNameInput();
    const name = nameEl.value.trim();
    const idValue = (document.getElementById('pipe-group-id-input') as HTMLInputElement).value;
    const id = idValue ? Number(idValue) : undefined;
    nameEl.classList.remove('input-error');
    if (!name) {
        nameEl.classList.add('input-error');
        api.showError('Group name is required.');
        return;
    }
    if (name.length > MAX_PIPELINE_GROUP_NAME_LENGTH) {
        nameEl.classList.add('input-error');
        api.showError(`Group name must be at most ${MAX_PIPELINE_GROUP_NAME_LENGTH} characters.`);
        return;
    }

    const groups = groupDrafts();
    const next =
        id === undefined
            ? [...groups, { name }]
            : groups.map((g) => (g.id === id ? { id, name } : g));
    if (await saveGroups(next, btn)) {
        (document.getElementById('pipe-group-modal') as HTMLDialogElement).close();
    }
}

export async function removePipelineGroup(id: number): Promise<void> {
    const group = sortedGroups().find((g) => g.id === id);
    if (!group) return;
    const members = (state.config.pipelines ?? []).filter((p) => p.groupId === id).length;
    const confirmed = await confirmDialog({
        title: 'Delete group?',
        message:
            `Delete the group "${group.name}"?` +
            (members
                ? `\n${members} pipeline${members === 1 ? '' : 's'} in it will move out of any group.`
                : ''),
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!confirmed) return;
    await saveGroups(groupDrafts().filter((g) => g.id !== id));
}
