import * as api from '../core/api.js';
import { state } from '../core/state.js';
import {
    setUrlParam,
    maskStreamKey,
    withBusy,
    copyText,
    escapeHtml,
    confirmDialog,
    flashSaveSuccess,
    formatLocalDateTime,
} from '../core/utils.js';
import { refreshAfterMutation } from './dashboard.js';
import { renderSrtPassphraseReset } from './render.js';
import { noteSharedEncodeRestart } from './shared-encodes.js';
import type {
    StreamKey,
    AudioTrackInfo,
    PipelineGroup,
    ServerLogTail,
    SrsLogEvent,
    Output,
} from '../types.js';
import { buildSrtOutputUrl, isSrtHostRequired, type SrtOutputSettings } from '../core/srt.js';
export { renderSrtBondingDetailsInline, showSrtBondingDetails } from './srt-bonding-details.js';

// Upper bound on selectable audio tracks. Outputs are often configured before
// the pipeline's input has ever connected (so nothing has been probed yet), so
// the track list is a static range rather than derived from live probe data.
const MAX_AUDIO_TRACKS = 50;
const MAX_PIPELINE_GROUP_NAME_LENGTH = 80;
let nextNewPipelineGroupRowId = 0;
let draggingPipelineGroupRow: HTMLElement | null = null;

const ICON_DRAG_HANDLE = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;

function pipelineGroupRowHtml(rowKey: string, name = ''): string {
    return `<tr data-pipeline-group-row="${rowKey}">
        <td>
            <span class="js-pipeline-group-drag-handle text-base-content/50 inline-flex cursor-grab" draggable="true" title="Drag to reorder">${ICON_DRAG_HANDLE}</span>
        </td>
        <td><input type="text" id="pipeline-group-${rowKey}-name" class="input input-sm w-full" data-pipeline-group-row-name oninput="this.classList.remove('input-error')" value="${escapeHtml(name)}" /></td>
        <td class="text-right whitespace-nowrap">
            <button type="button" class="btn btn-xs btn-error btn-outline" onclick="removePipelineGroupRowBtn('${rowKey}')" aria-label="Remove group" title="Remove group">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    <line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" />
                </svg>
            </button>
        </td>
    </tr>`;
}

// Drag-and-drop reordering, mirroring the pipeline list's own handle-based
// drag (see render.ts) — wired once on the tbody via event delegation so it
// keeps working after addPipelineGroupRow/removePipelineGroupRow mutate rows
// directly without re-running this wiring.
function wirePipelineGroupDragEvents(tbody: HTMLElement): void {
    tbody.ondragstart = (e) => {
        const target = e.target as Element;
        const row = target.closest('tr[data-pipeline-group-row]') as HTMLElement | null;
        if (!target.closest('.js-pipeline-group-drag-handle') || !row) {
            e.preventDefault();
            return;
        }
        draggingPipelineGroupRow = row;
        row.classList.add('opacity-40');
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', row.dataset.pipelineGroupRow!);
    };

    tbody.ondragover = (e) => {
        if (!draggingPipelineGroupRow) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        const overRow = (e.target as Element).closest(
            'tr[data-pipeline-group-row]',
        ) as HTMLElement | null;
        if (!overRow || overRow === draggingPipelineGroupRow) return;
        const rect = overRow.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        overRow.parentElement?.insertBefore(
            draggingPipelineGroupRow,
            before ? overRow : overRow.nextElementSibling,
        );
    };

    tbody.ondrop = (e) => e.preventDefault();

    tbody.ondragend = () => {
        draggingPipelineGroupRow?.classList.remove('opacity-40');
        draggingPipelineGroupRow = null;
    };
}

function renderPipelineGroupRows(groups: PipelineGroup[]): void {
    const tbody = document.getElementById('settings-pipeline-group-rows');
    if (!tbody) return;
    const sorted = [...groups].sort((a, b) => a.position - b.position);
    tbody.innerHTML = sorted.map((g) => pipelineGroupRowHtml(String(g.id), g.name)).join('');
    wirePipelineGroupDragEvents(tbody);
}

export function addPipelineGroupRow(): void {
    const tbody = document.getElementById('settings-pipeline-group-rows');
    if (!tbody) return;
    const rowKey = `new-${nextNewPipelineGroupRowId++}`;
    tbody.insertAdjacentHTML('beforeend', pipelineGroupRowHtml(rowKey));
}

export function removePipelineGroupRow(rowKey: string): void {
    document.querySelector(`[data-pipeline-group-row="${rowKey}"]`)?.remove();
}

function readPipelineGroupRows(): { id?: number; name: string }[] | null {
    const rows = Array.from(document.querySelectorAll('[data-pipeline-group-row]'));
    const groups: { id?: number; name: string }[] = [];
    for (const row of rows) {
        const rowKey = (row as HTMLElement).dataset.pipelineGroupRow!;
        const nameEl = row.querySelector(
            '[data-pipeline-group-row-name]',
        ) as HTMLInputElement | null;
        if (!nameEl) continue;
        const name = nameEl.value.trim();
        nameEl.classList.remove('input-error');
        const isNew = rowKey.startsWith('new-');
        if (!name && isNew) continue; // a blank new row is skipped, not saved
        if (!name) {
            // Saving would drop the group (an id missing from the list means
            // delete), so make the operator remove the row on purpose.
            nameEl.classList.add('input-error');
            api.showError('Group name is required. Remove the row to delete the group.');
            return null;
        }
        if (name.length > MAX_PIPELINE_GROUP_NAME_LENGTH) {
            nameEl.classList.add('input-error');
            api.showError(
                `Group name must be at most ${MAX_PIPELINE_GROUP_NAME_LENGTH} characters.`,
            );
            return null;
        }
        const id = isNew ? undefined : Number(rowKey);
        groups.push(id !== undefined ? { id, name } : { name });
    }
    return groups;
}

export async function submitPipelineGroupsForm(btn?: HTMLButtonElement): Promise<void> {
    const groups = readPipelineGroupRows();
    if (groups === null) return;

    await withBusy(btn, async () => {
        const result = await api.updatePipelineGroups(groups);
        if (!result) return;
        await refreshAfterMutation();
        flashSaveSuccess('settings-pipeline-groups-save-success');
    });
}

// ── Settings ──────────────────────────────────────────

export function openSettings(): void {
    const current = state.config.serverName ?? 'Bunryu';
    (document.getElementById('settings-server-name-input') as HTMLInputElement).value = current;
    (document.getElementById('settings-public-host-input') as HTMLInputElement).value =
        state.config.publicHost ?? '';
    (document.getElementById('current-password-input') as HTMLInputElement).value = '';
    (document.getElementById('new-password-input') as HTMLInputElement).value = '';
    (document.getElementById('confirm-password-input') as HTMLInputElement).value = '';
    (document.getElementById('confirm-password-input') as HTMLInputElement).classList.remove(
        'input-error',
    );
    renderPipelineGroupRows(state.config.groups ?? []);
    const hasPipelines = (state.config.pipelines?.length ?? 0) > 0;
    const regenBtn = document.getElementById('regen-stream-keys-btn') as HTMLButtonElement;
    const regenHint = document.getElementById('regen-stream-keys-hint') as HTMLElement;
    regenBtn.disabled = hasPipelines;
    regenHint.classList.toggle('hidden', !hasPipelines);
    renderSrtPassphraseReset();
    void api.getVersion().then((v) => {
        if (!v) return;
        (document.getElementById('v-app') as HTMLElement).textContent = `v${v.app}`;
        (document.getElementById('v-commit') as HTMLElement).textContent = v.commit;
        (document.getElementById('v-srs') as HTMLElement).textContent = v.srs;
        (document.getElementById('v-relay') as HTMLElement).textContent = v.srtRelay;
        (document.getElementById('v-ffmpeg') as HTMLElement).textContent = v.ffmpeg;
        (document.getElementById('v-node') as HTMLElement).textContent = v.node;
        (document.getElementById('v-os') as HTMLElement).textContent = v.os;
        (document.getElementById('v-kernel') as HTMLElement).textContent = v.kernel;
        // Shown after the core count; omitted when the platform doesn't report a model.
        (document.getElementById('v-cpu-model') as HTMLElement).textContent =
            v.cpuModel && v.cpuModel !== 'unknown' ? ` · ${v.cpuModel}` : '';
    });
}

export async function submitGeneralSettingsForm(btn?: HTMLButtonElement): Promise<void> {
    const name = (
        document.getElementById('settings-server-name-input') as HTMLInputElement
    ).value.trim();
    const publicHost = (
        document.getElementById('settings-public-host-input') as HTMLInputElement
    ).value.trim();
    const nameEl = document.getElementById('settings-server-name-input') as HTMLInputElement;
    nameEl.classList.toggle('input-error', !name);
    if (!name) {
        api.showError('Server name is required.');
        return;
    }

    await withBusy(btn, async () => {
        const result = await api.updateGeneralSettings(name, publicHost);
        if (!result) return;

        const el = document.getElementById('server-name-display');
        if (el) el.textContent = name;
        document.title = name;
        await refreshAfterMutation();
        flashSaveSuccess('settings-general-save-success');
    });
}

export async function submitPasswordForm(btn?: HTMLButtonElement): Promise<void> {
    const currentPw = (document.getElementById('current-password-input') as HTMLInputElement).value;
    const newPw = (document.getElementById('new-password-input') as HTMLInputElement).value;
    const confirmPw = (document.getElementById('confirm-password-input') as HTMLInputElement).value;
    const confirmEl = document.getElementById('confirm-password-input') as HTMLInputElement;

    const currentEl = document.getElementById('current-password-input') as HTMLInputElement;
    const newEl = document.getElementById('new-password-input') as HTMLInputElement;
    for (const el of [currentEl, newEl, confirmEl]) el.classList.remove('input-error');
    const problem = !currentPw
        ? { el: currentEl, message: 'Enter your current password.' }
        : !newPw
          ? { el: newEl, message: 'Enter a new password.' }
          : newPw !== confirmPw
            ? { el: confirmEl, message: 'The new passwords do not match.' }
            : null;
    if (problem) {
        problem.el.classList.add('input-error');
        api.showError(problem.message);
        return;
    }

    await withBusy(btn, async () => {
        const result = await api.changePassword(currentPw, newPw);
        if (!result) return;
        (document.getElementById('current-password-input') as HTMLInputElement).value = '';
        (document.getElementById('new-password-input') as HTMLInputElement).value = '';
        (document.getElementById('confirm-password-input') as HTMLInputElement).value = '';
        flashSaveSuccess('settings-password-save-success');
    });
}

export async function logoutUser(): Promise<void> {
    const confirmed = await confirmDialog({
        title: 'Log out?',
        message: 'You will be signed out of this dashboard. Pipelines and outputs keep running.',
        confirmLabel: 'Log out',
    });
    if (!confirmed) return;
    await api.logout();
    window.location.href = '/login';
}

export async function regenerateStreamKeysBtn(btn?: HTMLButtonElement): Promise<void> {
    const confirmed = await confirmDialog({
        title: 'Regenerate stream keys?',
        message: 'All existing stream key values will be replaced with new ones.',
        confirmLabel: 'Regenerate All',
        danger: true,
    });
    if (!confirmed) return;
    await withBusy(btn, async () => {
        const result = await api.regenerateStreamKeys();
        if (result) await refreshAfterMutation();
    });
}

export async function resetSrtPassphraseBtn(btn?: HTMLButtonElement): Promise<void> {
    const confirmed = await confirmDialog({
        title: 'Reset the SRT passphrase?',
        message:
            'A new random passphrase is written to the SRS and Goryu config files. It applies only after both restart, so reboot the server (or restart the container) afterwards, then update the SRT URL in every encoder. Until then the dashboard and the services keep the old one.',
        confirmLabel: 'Reset',
        danger: true,
    });
    if (!confirmed) return;
    await withBusy(btn, async () => {
        const result = await api.resetSrtPassphrase();
        if (!result) return;
        document.getElementById('reset-srt-passphrase-done')?.classList.remove('hidden');
        document.getElementById('reset-srt-passphrase-hint')?.classList.add('hidden');
    });
}

// ── Pipeline ──────────────────────────────────────────

function pipeModal(): HTMLDialogElement {
    return document.getElementById('edit-pipe-modal') as HTMLDialogElement;
}

function populateKeySelect(currentKeyId: number): void {
    const select = document.getElementById('pipe-key-select') as HTMLSelectElement;
    const options: string[] = [];
    for (const k of state.streamKeys as StreamKey[]) {
        const label = maskStreamKey(k.key);
        const selected = k.id === currentKeyId ? ' selected' : '';
        options.push(`<option value="${k.id}"${selected}>${label}</option>`);
    }
    select.innerHTML = options.join('');
}

function populateGroupSelect(currentGroupId: number | null): void {
    const select = document.getElementById('pipe-group-select') as HTMLSelectElement;
    const groups = [...(state.config.groups ?? [])].sort((a, b) => a.position - b.position);
    const options = [
        `<option value=""${currentGroupId === null ? ' selected' : ''}>— No Group —</option>`,
        ...groups.map(
            (g) =>
                `<option value="${g.id}"${g.id === currentGroupId ? ' selected' : ''}>${escapeHtml(g.name)}</option>`,
        ),
    ];
    select.innerHTML = options.join('');
}

export async function createPipeline(btn?: HTMLButtonElement): Promise<void> {
    await withBusy(btn, async () => {
        const result = await api.createPipeline();
        if (result) {
            const created = result as { id: string };
            setUrlParam('p', String(created.id));
            await refreshAfterMutation();
        }
    });
}

export function openEditPipeline(id: string): void {
    const pipeline = state.pipelines.find((p) => p.id === id);
    if (!pipeline) return;
    const modal = pipeModal();
    const nameEl = document.getElementById('pipe-name-input') as HTMLInputElement;
    nameEl.value = pipeline.name;
    nameEl.classList.remove('input-error');
    (document.getElementById('pipe-id-input') as HTMLInputElement).value = id;
    (document.getElementById('pipe-modal-title') as HTMLElement).textContent = 'Edit Pipeline';
    populateKeySelect(pipeline.streamKeyId);
    const keySelect = document.getElementById('pipe-key-select') as HTMLSelectElement;
    const hasActiveOutputs = pipeline.outs.some((o) => o.desiredState !== 'stopped');
    keySelect.disabled = hasActiveOutputs;
    keySelect.title = hasActiveOutputs ? 'Stop all outputs before changing stream key' : '';
    populateGroupSelect(pipeline.groupId);
    modal.showModal();
}

export async function submitPipelineForm(btn?: HTMLButtonElement): Promise<void> {
    const id = (document.getElementById('pipe-id-input') as HTMLInputElement).value.trim();
    const nameEl = document.getElementById('pipe-name-input') as HTMLInputElement;
    const name = nameEl.value.trim();
    nameEl.classList.toggle('input-error', !name);
    if (!name) return;
    const streamKeyId = parseInt(
        (document.getElementById('pipe-key-select') as HTMLSelectElement).value,
    );
    const groupRaw = (document.getElementById('pipe-group-select') as HTMLSelectElement).value;
    const groupId = groupRaw === '' ? null : parseInt(groupRaw);
    await withBusy(btn, async () => {
        const result = await api.updatePipeline(id, name, streamKeyId, groupId);
        if (!result) return;
        pipeModal().close();
        await refreshAfterMutation();
    });
}

export async function confirmDeletePipeline(id: string, btn?: HTMLButtonElement): Promise<void> {
    const pipeline = (state.config.pipelines ?? []).find((p) => String(p.id) === String(id));
    const confirmed = await confirmDialog({
        title: 'Delete pipeline?',
        message: pipeline
            ? `Pipeline "${pipeline.name}" and all its outputs will be deleted.`
            : 'This pipeline and all its outputs will be deleted.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!confirmed) return;
    await withBusy(btn, async () => {
        const ok = await api.deletePipeline(id);
        if (ok) {
            setUrlParam('p', null);
            await refreshAfterMutation();
        }
    });
}

// ── Output modal ──────────────────────────────────────

const SERVERS = [
    { label: 'Custom RTMP', prefix: '', keyLabel: 'RTMP URL', placeholder: 'rtmp://...' },
    {
        label: 'Custom SRT',
        prefix: '',
        keyLabel: 'SRT Settings',
        placeholder: '',
    },
    {
        label: 'YT RTMP',
        prefix: 'rtmp://a.rtmp.youtube.com/live2/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    {
        label: 'YT RTMP (Backup)',
        prefix: 'rtmp://b.rtmp.youtube.com/live2?backup=1/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    {
        label: 'Facebook RTMP',
        prefix: 'rtmps://live-api-s.facebook.com:443/rtmp/',
        keyLabel: 'Stream Key',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
    },
    {
        label: 'Instagram RTMPS',
        prefix: '',
        keyLabel: 'Stream Key',
        placeholder: '1234567890?s_bl=1&s_prp=xxx-1&...',
    },
    { label: 'Restream RTMP', prefix: '', keyLabel: 'Pipeline', placeholder: '' },
    { label: 'Restream SRT', prefix: '', keyLabel: 'Pipeline', placeholder: '' },
] as const;

const CUSTOM_RTMP_IDX = 0;
const CUSTOM_SRT_IDX = 1;
const INSTAGRAM_RTMP_IDX = 5;
const RESTREAM_RTMP_IDX = 6;
const RESTREAM_SRT_IDX = 7;

function isRestreamIdx(idx: number): boolean {
    return idx === RESTREAM_RTMP_IDX || idx === RESTREAM_SRT_IDX;
}

function serverOptionsHtml(selectedIdx: number): string {
    return SERVERS.map(
        (s, i) => `<option value="${i}"${i === selectedIdx ? ' selected' : ''}>${s.label}</option>`,
    ).join('');
}

function buildInstagramUrl(key: string): string {
    const m = key.match(/[?&]s_prp=([^&]+)/);
    const sPrp = m ? m[1] : '';
    return `rtmps://edgetee-upload-${sPrp}.xx.fbcdn.net:443/rtmp/${key}`;
}

function detectInstagramKey(url: string): string | null {
    const m = url.match(/^rtmps:\/\/edgetee-upload-[^.]+\.xx\.fbcdn\.net:443\/rtmp\/(.+)$/);
    return m ? m[1] : null;
}

function detectServer(url: string): { idx: number; key: string } {
    for (const p of state.config.pipelines ?? []) {
        if (url === p.rtmpPublishUrlLocal) return { idx: RESTREAM_RTMP_IDX, key: String(p.id) };
        if (url === p.srtPublishUrlLocal) return { idx: RESTREAM_SRT_IDX, key: String(p.id) };
    }
    const instagramKey = detectInstagramKey(url);
    if (instagramKey !== null) return { idx: INSTAGRAM_RTMP_IDX, key: instagramKey };
    for (let i = 0; i < SERVERS.length; i++) {
        const { prefix } = SERVERS[i];
        if (prefix && url.startsWith(prefix)) return { idx: i, key: url.slice(prefix.length) };
    }
    return { idx: url.startsWith('srt://') ? CUSTOM_SRT_IDX : CUSTOM_RTMP_IDX, key: url };
}

function isDestinationUrl(text: string): boolean {
    return /^(rtmps?|srt):\/\//i.test(text);
}

// Drops the trailing path segment (the stream key) from a custom RTMP URL,
// keeping only the server/app portion so it can be prefilled without leaking
// the previous output's key. Leaves the URL untouched if it has no path
// segment to strip (e.g. bare "rtmp://host").
function stripRtmpStreamKey(url: string): string {
    const m = url.match(/^([a-z]+:\/\/)(.*)$/i);
    if (!m) return url;
    const [, scheme, rest] = m;
    const slashIdx = rest.lastIndexOf('/');
    if (slashIdx === -1) return url;
    return scheme + rest.slice(0, slashIdx + 1);
}

// Removes the streamid param from a custom SRT URL while preserving every
// other setting (host, port, mode, latency, passphrase, keylen).
function stripSrtStreamId(url: string): string {
    const queryIdx = url.indexOf('?');
    if (queryIdx === -1) return url;
    const base = url.slice(0, queryIdx);
    const params = url
        .slice(queryIdx + 1)
        .split('&')
        .filter((part) => part.split('=', 1)[0] !== 'streamid');
    return params.length > 0 ? `${base}?${params.join('&')}` : base;
}

type SrtFormSettings = Omit<SrtOutputSettings, 'port'> & { port: number | null };

const DEFAULT_SRT_SETTINGS: SrtFormSettings = {
    mode: 'caller',
    host: '',
    port: null,
    latencyMs: null,
    passphrase: '',
    pbKeyLen: null,
    streamId: '',
};

function decodeSrtParam(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, '%20'));
    } catch {
        return value;
    }
}

function parseSrtParams(query: string): Map<string, string> {
    const params = new Map<string, string>();
    for (const part of query.split('&')) {
        if (!part) continue;
        const eqIdx = part.indexOf('=');
        const rawKey = eqIdx === -1 ? part : part.slice(0, eqIdx);
        const rawValue = eqIdx === -1 ? '' : part.slice(eqIdx + 1);
        params.set(decodeSrtParam(rawKey), decodeSrtParam(rawValue));
    }
    return params;
}

function parseSrtUrl(url: string): SrtFormSettings {
    if (!url.startsWith('srt://')) return { ...DEFAULT_SRT_SETTINGS };
    try {
        const queryIdx = url.indexOf('?');
        const parsed = new URL(queryIdx === -1 ? url : url.slice(0, queryIdx));
        const params =
            queryIdx === -1 ? new Map<string, string>() : parseSrtParams(url.slice(queryIdx + 1));
        const latency = Number(params.get('latency') ?? '');
        const port = Number(parsed.port || '');
        const pbKeyLen = Number(params.get('pbkeylen') ?? '');
        return {
            mode: params.get('mode') === 'listener' ? 'listener' : 'caller',
            host: parsed.hostname,
            port: Number.isInteger(port) && port > 0 ? port : null,
            latencyMs: Number.isInteger(latency) && latency > 0 ? Math.round(latency / 1000) : null,
            passphrase: params.get('passphrase') ?? '',
            pbKeyLen: pbKeyLen === 16 || pbKeyLen === 24 || pbKeyLen === 32 ? pbKeyLen : null,
            streamId: params.get('streamid') ?? '',
        };
    } catch {
        return { ...DEFAULT_SRT_SETTINGS };
    }
}

export function syncSrtHostVisibility(): void {
    const modeEl = document.querySelector('.js-srt-mode') as HTMLSelectElement | null;
    const hostEl = document.querySelector('.js-srt-host') as HTMLInputElement | null;
    const hostFieldset = hostEl?.closest('fieldset');
    if (!modeEl || !hostFieldset) return;
    hostFieldset.classList.toggle('hidden', modeEl.value === 'listener');
}

function restreamPipelineOpts(selectedId: string): string {
    const pipelines = state.config.pipelines ?? [];
    if (!pipelines.length) return '<option value="" disabled>No pipelines</option>';
    const header = `<option value="" disabled${selectedId ? '' : ' selected'}>Pipeline</option>`;
    return (
        header +
        pipelines
            .map(
                (p) =>
                    `<option value="${escapeHtml(String(p.id))}"${String(p.id) === selectedId ? ' selected' : ''}>${escapeHtml(p.name)}</option>`,
            )
            .join('')
    );
}

function fieldsetHtml(label: string, sizeClass: string, inputHtml: string): string {
    return `<fieldset class="fieldset ${sizeClass}">
        <legend class="fieldset-legend">${label}</legend>
        ${inputHtml}
    </fieldset>`;
}

function sinkKeyFieldHtml(idx: number, key: string): string {
    if (isRestreamIdx(idx)) {
        return fieldsetHtml(
            'Pipeline',
            'flex-1',
            `<select id="out-sink-key-input" name="sinkKey" class="select select-sm w-full js-sink-key" onchange="this.classList.remove('select-error')">${restreamPipelineOpts(key)}</select>`,
        );
    }
    if (idx === CUSTOM_SRT_IDX) {
        const srt = parseSrtUrl(key);
        return [
            fieldsetHtml(
                'Type',
                '',
                `<select id="out-srt-mode-input" name="srtMode" class="select select-sm w-28 js-srt-mode" onchange="srtModeChange()">
                    <option value="caller"${srt.mode === 'caller' ? ' selected' : ''}>Caller</option>
                    <option value="listener"${srt.mode === 'listener' ? ' selected' : ''}>Listener</option>
                </select>`,
            ),
            fieldsetHtml(
                'Hostname',
                '',
                `<input type="text" id="out-srt-host-input" name="srtHost" class="input input-sm w-40 font-mono text-xs js-srt-host" placeholder="xxx.xxx.xxx.xxx" value="${escapeHtml(srt.host)}" oninput="this.classList.remove('input-error')" />`,
            ),
            fieldsetHtml(
                'Port',
                '',
                `<input type="number" min="1" max="65535" id="out-srt-port-input" name="srtPort" class="input input-sm w-20 font-mono text-xs js-srt-port" placeholder="10000" value="${srt.port ?? ''}" oninput="this.classList.remove('input-error')" />`,
            ),
            fieldsetHtml(
                'Latency (ms)',
                '',
                `<input type="number" min="1" step="1" id="out-srt-latency-input" name="srtLatency" class="input input-sm w-28 font-mono text-xs js-srt-latency" placeholder="240" value="${srt.latencyMs ?? ''}" oninput="this.classList.remove('input-error')" />`,
            ),
            fieldsetHtml(
                'Passphrase',
                '',
                `<input type="text" id="out-srt-passphrase-input" name="srtPassphrase" class="input input-sm w-56 font-mono text-xs js-srt-passphrase" placeholder="Passphrase" value="${escapeHtml(srt.passphrase)}" oninput="this.classList.remove('input-error')" />`,
            ),
            fieldsetHtml(
                'Key Length',
                '',
                `<select id="out-srt-keylen-input" name="srtKeylen" class="select select-sm w-24 js-srt-keylen" title="Key length">
                    <option value="" disabled${srt.pbKeyLen === null ? ' selected' : ''}>—</option>
                    <option value="16"${srt.pbKeyLen === 16 ? ' selected' : ''}>16</option>
                    <option value="24"${srt.pbKeyLen === 24 ? ' selected' : ''}>24</option>
                    <option value="32"${srt.pbKeyLen === 32 ? ' selected' : ''}>32</option>
                </select>`,
            ),
            fieldsetHtml(
                'Stream ID',
                '',
                `<input type="text" id="out-srt-streamid-input" name="srtStreamId" class="input input-sm w-80 font-mono text-xs js-srt-streamid" placeholder="Stream ID" value="${escapeHtml(srt.streamId)}" oninput="this.classList.remove('input-error')" />`,
            ),
        ].join('');
    }
    const s = SERVERS[idx];
    return fieldsetHtml(
        s.keyLabel,
        'flex-1',
        `<input type="text" id="out-sink-key-input" name="sinkKey" class="input input-sm w-full font-mono text-xs js-sink-key"
               placeholder="${s.placeholder}" value="${escapeHtml(key)}"
               oninput="this.classList.remove('input-error')" onpaste="onSinkKeyPaste(event)" />`,
    );
}

function outModal(): HTMLDialogElement {
    return document.getElementById('edit-out-modal') as HTMLDialogElement;
}

function outVideoEncodingOptions(selected: string): string {
    const encodings = state.config.encodings ?? ['copy', '720p', '1080p'];
    return encodings
        .map((e) => `<option value="${e}" ${e === selected ? 'selected' : ''}>${e}</option>`)
        .join('');
}

// Tracks for the pipeline whose output modal is currently open, keyed by index.
// Captured when the modal opens so the global add-sink handler can build new
// rows with the same list. Only used to enrich track labels with real
// metadata (language/codec/channels) when it happens to be known — the option
// list itself is a static range (see MAX_AUDIO_TRACKS) so it doesn't depend on
// the input ever having been probed.
let currentSinkTracks: AudioTrackInfo[] = [];

// Build the audio-track <option>s for one sink. "copy" is a literal stream copy.
// "Track N" force-transcodes that track (also the fix for SRT-origin timestamp
// jitter — see encodeAudioArgs in ffmpeg.ts) and is offered for every pipeline
// up to MAX_AUDIO_TRACKS regardless of origin protocol or probe state, since
// outputs are frequently configured before the input has connected; entries
// are enriched with real track metadata for indices we do have probe data
// for. Always preserves the currently selected value even when it falls
// outside that range (e.g. a stale multi-track list), so editing a saved
// output doesn't silently reset its track to copy.
function audioOptionsHtml(tracks: AudioTrackInfo[], selected: string): string {
    const byIndex = new Map(tracks.map((t) => [t.index, t] as const));
    const options = [
        `<option value="copy"${selected === 'copy' ? ' selected' : ''}>copy</option>`,
        `<option value="translation"${selected === 'translation' ? ' selected' : ''}>translation</option>`,
    ];
    let matched = selected === 'copy' || selected === 'translation';
    for (let i = 0; i < MAX_AUDIO_TRACKS; i++) {
        const val = String(i);
        if (val === selected) matched = true;
        const t = byIndex.get(i);
        const parts = [`Track ${i + 1}`];
        if (t) {
            if (t.language) parts.push(`(${t.language})`);
            if (t.title) parts.push(`— ${t.title}`);
            parts.push(`· ${t.codec} ${t.channels}ch`);
        }
        options.push(
            `<option value="${val}"${val === selected ? ' selected' : ''}>${escapeHtml(parts.join(' '))}</option>`,
        );
    }
    if (!matched) {
        const label = /^\d+$/.test(selected) ? `Track ${Number(selected) + 1}` : selected;
        options.push(
            `<option value="${escapeHtml(selected)}" selected>${escapeHtml(label)}</option>`,
        );
    }
    return options.join('');
}

// Plain "Track N" options with no 'copy'/'translation' entries — used for the
// translation mixer's per-leg track pickers (source leg / translator leg),
// which always select exactly one track and have no meaning for those two
// values. Same static MAX_AUDIO_TRACKS range and real-metadata enrichment as
// audioOptionsHtml above.
function trackIndexOptionsHtml(tracks: AudioTrackInfo[], selected: number): string {
    const byIndex = new Map(tracks.map((t) => [t.index, t] as const));
    const options: string[] = [];
    for (let i = 0; i < MAX_AUDIO_TRACKS; i++) {
        const t = byIndex.get(i);
        const parts = [`Track ${i + 1}`];
        if (t) {
            if (t.language) parts.push(`(${t.language})`);
            if (t.title) parts.push(`— ${t.title}`);
            parts.push(`· ${t.codec} ${t.channels}ch`);
        }
        options.push(
            `<option value="${i}"${i === selected ? ' selected' : ''}>${escapeHtml(parts.join(' '))}</option>`,
        );
    }
    return options.join('');
}

function sinkRowHtmlForServer(idx: number, key = ''): string {
    const serverField = fieldsetHtml(
        'Server',
        '',
        `<select class="select select-sm w-40" id="out-server-input" onchange="outServerChange(this)">${serverOptionsHtml(idx)}</select>`,
    );
    return `<div class="js-sink-row flex flex-wrap items-end gap-2 rounded-box bg-base-200 px-2 py-2">${serverField}${sinkKeyFieldHtml(idx, key)}</div>`;
}

function refreshSinkAudioMode(selected: string): void {
    const sel = document.getElementById('out-audio-encoding-input') as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML = audioOptionsHtml(currentSinkTracks, selected);
    sel.disabled = false;
}

function populateDestinationDetected(
    tracks: AudioTrackInfo[],
    idx: number,
    key: string,
    audioEncoding: string,
): void {
    currentSinkTracks = tracks;
    const container = document.getElementById('out-sinks-container');
    if (container) container.innerHTML = sinkRowHtmlForServer(idx, key);
    syncSrtHostVisibility();
    refreshSinkAudioMode(audioEncoding);
}

function populateDestination(
    tracks: AudioTrackInfo[],
    destination: { url: string; audioEncoding: string } | null,
): void {
    const { idx, key } = destination?.url
        ? detectServer(destination.url)
        : { idx: CUSTOM_RTMP_IDX, key: '' };
    populateDestinationDetected(tracks, idx, key, destination?.audioEncoding ?? 'copy');
}

// Sanitizes a previous output's server/key for prefill so the unique-per-stream
// identifier isn't silently reused: RTMP stream keys, SRT stream IDs, and the
// selected Restream target pipeline are all dropped (blank), while the
// server/connection settings around them are kept.
function sanitizedDestinationFor(previousUrl: string): { idx: number; key: string } {
    const { idx, key } = detectServer(previousUrl);
    if (idx === CUSTOM_SRT_IDX) return { idx, key: stripSrtStreamId(key) };
    if (idx === CUSTOM_RTMP_IDX) return { idx, key: stripRtmpStreamKey(key) };
    return { idx, key: '' };
}

export function onOutServerChange(select: HTMLSelectElement): void {
    const idx = parseInt(select.value);
    const container = document.getElementById('out-sinks-container');
    if (container) container.innerHTML = sinkRowHtmlForServer(idx, '');
    syncSrtHostVisibility();
}

// If a full RTMP/RTMPS/SRT URL is pasted into the key field, split it into
// server preset + key (e.g. a full YouTube RTMP URL switches the preset to
// "YT RTMP" and leaves just the stream key behind) instead of dumping the
// whole URL into the field. Falls back to the default paste behavior when
// the URL doesn't resolve to anything more specific than Custom RTMP, since
// that preset's field is meant to hold the full URL anyway.
export function onSinkKeyPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text').trim();
    if (!text || !isDestinationUrl(text)) return;
    const { idx, key } = detectServer(text);
    if (idx === CUSTOM_RTMP_IDX && key === text) return;
    event.preventDefault();
    const container = document.getElementById('out-sinks-container');
    if (container) container.innerHTML = sinkRowHtmlForServer(idx, key);
    syncSrtHostVisibility();
}

function pipelineTracks(pipelineId: string): AudioTrackInfo[] {
    return state.pipelines.find((p) => p.id === pipelineId)?.input.audioTracks ?? [];
}

// Refreshes the "Translation Input Track" select to match whichever pipeline
// is currently chosen in the translator dropdown. Exported so the dropdown's
// onchange handler (wired through window in dashboard-entry.ts) can call it.
export function onTranslationPipelineChange(select: HTMLSelectElement): void {
    const trackSelect = document.getElementById(
        'out-translation-input-track-input',
    ) as HTMLSelectElement | null;
    if (!trackSelect) return;
    const translatorPipelineId = select.value;
    const tracks = translatorPipelineId ? pipelineTracks(translatorPipelineId) : [];
    trackSelect.innerHTML = trackIndexOptionsHtml(tracks, 0);
}

function renderOutputTranslationControls(
    pipelineId: string,
    translation: Output['translation'] | null,
): void {
    const container = document.getElementById('out-translation-container');
    if (!container) return;
    const mix = translation;
    const translatorPipeline = state.pipelines.find(
        (pipeline) => pipeline.streamKey === mix?.translatorStreamKey,
    );
    const options = state.pipelines
        .filter((pipeline) => pipeline.id !== pipelineId)
        .map(
            (pipeline) =>
                `<option value="${pipeline.id}" ${translatorPipeline?.id === pipeline.id ? 'selected' : ''}>${escapeHtml(pipeline.name)}</option>`,
        )
        .join('');
    container.classList.toggle('hidden', mix === null);
    container.innerHTML = `
      <div id="out-translation-fields" class="rounded-box bg-base-200 flex flex-wrap items-end gap-2 px-2 py-2">
          <fieldset class="fieldset min-w-56 flex-1">
            <legend class="fieldset-legend">Translator Pipeline</legend>
            <select id="out-translation-pipeline-input" class="select select-sm w-full" onchange="onTranslationPipelineChange(this)">
              <option value="">Select translator pipeline</option>${options}
            </select>
          </fieldset>
          <fieldset class="fieldset min-w-40 flex-1">
            <legend class="fieldset-legend">Source Track</legend>
            <select id="out-translation-source-track-input" class="select select-sm w-full">${trackIndexOptionsHtml(pipelineTracks(pipelineId), mix?.sourceTrackIndex ?? 0)}</select>
          </fieldset>
          <fieldset class="fieldset min-w-40 flex-1">
            <legend class="fieldset-legend">Translation Input Track</legend>
            <select id="out-translation-input-track-input" class="select select-sm w-full">${trackIndexOptionsHtml(translatorPipeline ? pipelineTracks(translatorPipeline.id) : [], mix?.translatorTrackIndex ?? 0)}</select>
          </fieldset>
          <fieldset class="fieldset min-w-40 flex-1">
            <legend class="fieldset-legend">Translation Delay (ms)</legend>
            <input id="out-translation-delay-input" class="input input-sm w-full" type="number" min="0" max="5000" value="${mix?.translationDelayMs ?? 800}" />
          </fieldset>
          <fieldset class="fieldset min-w-40 flex-1">
            <legend class="fieldset-legend">Voice Threshold (dB)</legend>
            <input id="out-translation-threshold-input" class="input input-sm w-full" type="number" min="-100" max="0" step="1" value="${mix?.voiceThresholdDb ?? -20}" />
          </fieldset>
          <fieldset class="fieldset min-w-40 flex-1">
            <legend class="fieldset-legend">Source While Speaking (dB)</legend>
            <input id="out-translation-duck-volume-input" class="input input-sm w-full" type="number" min="-60" max="0" step="1" value="${mix?.duckVolumeDb ?? -24}" />
          </fieldset>
          <fieldset class="fieldset min-w-40 flex-1">
            <legend class="fieldset-legend">Duck Fade (ms)</legend>
            <input id="out-translation-duck-duration-input" class="input input-sm w-full" type="number" min="0" max="30000" value="${mix?.duckDurationMs ?? 900}" />
          </fieldset>
          <fieldset class="fieldset min-w-40 flex-1">
            <legend class="fieldset-legend">Restore After (ms)</legend>
            <input id="out-translation-restore-silence-input" class="input input-sm w-full" type="number" min="0" max="30000" value="${mix?.restoreSilenceMs ?? 2000}" />
          </fieldset>
          <fieldset class="fieldset min-w-40 flex-1">
            <legend class="fieldset-legend">Restore Volume (dB)</legend>
            <input id="out-translation-restore-volume-input" class="input input-sm w-full" type="number" min="-60" max="0" step="1" value="${mix?.restoreVolumeDb ?? -6}" />
          </fieldset>
          <fieldset class="fieldset min-w-40 flex-1">
            <legend class="fieldset-legend">Restore Fade (ms)</legend>
            <input id="out-translation-restore-duration-input" class="input input-sm w-full" type="number" min="0" max="30000" value="${mix?.restoreDurationMs ?? 5000}" />
          </fieldset>
        ${options ? '' : '<p class="w-full text-xs opacity-60">Create another pipeline for the translator feed first.</p>'}
      </div>`;
    document.getElementById('out-audio-encoding-input')?.addEventListener('change', (event) => {
        const enabled = (event.target as HTMLSelectElement).value === 'translation';
        container.classList.toggle('hidden', !enabled);
    });
}

const LOCKED_FIELD_TITLE = 'Stop the output before changing this';

// A running output keeps the destination and encoding its ffmpeg was started
// with, so its form only lets the name change (the server enforces the same
// rule). Everything else, including pasting a whole output, is disabled.
function setOutputSettingsLocked(locked: boolean): void {
    const fields = document.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >(
        '#out-video-encoding-input, #out-audio-encoding-input, ' +
            '#out-translation-container :is(input, select, button), ' +
            '#out-sinks-container :is(input, select, button)',
    );
    for (const el of fields) {
        el.disabled = locked;
        if (locked) el.title = LOCKED_FIELD_TITLE;
        else if (el.title === LOCKED_FIELD_TITLE) el.removeAttribute('title');
    }
    const pasteBtn = document.getElementById('out-paste-btn') as HTMLButtonElement;
    pasteBtn.disabled = locked;
    pasteBtn.classList.toggle('btn-disabled', locked);
    pasteBtn.classList.toggle('opacity-40', locked);
}

export function openAddOutput(pipelineId: string): void {
    const modal = outModal();
    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    const existingCount = pipeline?.outs.length ?? 0;
    (document.getElementById('out-pipe-id-input') as HTMLInputElement).value = pipelineId;
    (document.getElementById('out-id-input') as HTMLInputElement).value = '';
    const nameEl = document.getElementById('out-name-input') as HTMLInputElement;
    nameEl.value = `Output ${existingCount + 1}`;
    nameEl.classList.remove('input-error');

    // Prefill from the pipeline's most recently added output so repeat destinations
    // (same server/encoding) don't have to be re-entered from scratch each time.
    // The per-stream identifier (RTMP stream key / SRT stream ID) is left blank
    // rather than copied, since that's almost never meant to be reused.
    const previous = pipeline?.outs[pipeline.outs.length - 1] ?? null;

    (document.getElementById('out-video-encoding-input') as HTMLSelectElement).innerHTML =
        outVideoEncodingOptions(previous?.videoEncoding ?? 'copy');
    if (previous) {
        const { idx, key } = sanitizedDestinationFor(previous.url);
        populateDestinationDetected(pipelineTracks(pipelineId), idx, key, previous.audioEncoding);
    } else {
        populateDestinationDetected(pipelineTracks(pipelineId), CUSTOM_RTMP_IDX, '', 'copy');
    }
    renderOutputTranslationControls(pipelineId, previous?.translation ?? null);
    (document.getElementById('out-modal-title') as HTMLElement).textContent = 'Add Output';
    setOutputSettingsLocked(false);
    (document.getElementById('out-save-btn') as HTMLButtonElement).disabled = false;
    const copyBtn = document.getElementById('out-copy-btn') as HTMLButtonElement;
    copyBtn.disabled = true;
    copyBtn.classList.add('btn-disabled', 'opacity-40');
    copyBtn.title = 'Save the output before copying it';
    modal.showModal();
}

export function openEditOutput(pipelineId: string, outId: string): void {
    const output = state.config.outputs?.find(
        (o) => o.id === outId && String(o.pipelineId) === pipelineId,
    );
    if (!output) return;
    const modal = outModal();
    (document.getElementById('out-pipe-id-input') as HTMLInputElement).value = pipelineId;
    (document.getElementById('out-id-input') as HTMLInputElement).value = outId;
    const nameEl = document.getElementById('out-name-input') as HTMLInputElement;
    nameEl.value = output.name;
    nameEl.classList.remove('input-error');
    (document.getElementById('out-video-encoding-input') as HTMLSelectElement).innerHTML =
        outVideoEncodingOptions(output.videoEncoding);
    populateDestination(pipelineTracks(pipelineId), {
        url: output.url,
        audioEncoding: output.audioEncoding,
    });
    renderOutputTranslationControls(
        pipelineId,
        output.audioEncoding === 'translation' ? output.translation : null,
    );
    (document.getElementById('out-modal-title') as HTMLElement).textContent = 'Edit Output';

    const isRunning = output.desiredState === 'running';
    setOutputSettingsLocked(isRunning);
    (document.getElementById('out-save-btn') as HTMLButtonElement).disabled = false;

    const copyBtn = document.getElementById('out-copy-btn') as HTMLButtonElement;
    copyBtn.disabled = false;
    copyBtn.classList.remove('btn-disabled', 'opacity-40');
    copyBtn.title = 'Copy output to clipboard';

    modal.showModal();
}

function isValidSinkUrl(serverIdx: number, url: string): boolean {
    if (serverIdx === CUSTOM_RTMP_IDX)
        return url.startsWith('rtmp://') || url.startsWith('rtmps://');
    if (serverIdx === CUSTOM_SRT_IDX) return url.startsWith('srt://');
    return true;
}

function readSrtSettings(row: Element): { url: string } | { error: true } {
    const hostEl = row.querySelector('.js-srt-host') as HTMLInputElement | null;
    const portEl = row.querySelector('.js-srt-port') as HTMLInputElement | null;
    const latencyEl = row.querySelector('.js-srt-latency') as HTMLInputElement | null;
    const passphraseEl = row.querySelector('.js-srt-passphrase') as HTMLInputElement | null;
    const modeEl = row.querySelector('.js-srt-mode') as HTMLSelectElement | null;
    const keyLenEl = row.querySelector('.js-srt-keylen') as HTMLSelectElement | null;
    const streamIdEl = row.querySelector('.js-srt-streamid') as HTMLInputElement | null;
    if (!hostEl || !portEl || !latencyEl || !passphraseEl || !modeEl || !keyLenEl || !streamIdEl) {
        return { error: true };
    }

    const mode = modeEl.value === 'listener' ? 'listener' : 'caller';
    const host = hostEl.value.trim();
    const port = Number(portEl.value.trim());
    const latencyRaw = latencyEl.value.trim();
    const latencyMs = latencyRaw ? Number(latencyRaw) : null;
    const passphrase = passphraseEl.value.trim();
    const pbKeyLen = keyLenEl.value ? (Number(keyLenEl.value) as 16 | 24 | 32) : null;
    const streamId = streamIdEl.value.trim();

    const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
    const latencyValid = latencyMs === null || (Number.isInteger(latencyMs) && latencyMs > 0);
    const passphraseValid = !passphrase || (passphrase.length >= 10 && passphrase.length <= 79);
    const keyLenValid = !passphrase || pbKeyLen !== null;

    hostEl.classList.toggle('input-error', isSrtHostRequired(mode) && !host);
    portEl.classList.toggle('input-error', !portValid);
    latencyEl.classList.toggle('input-error', !latencyValid);
    passphraseEl.classList.toggle('input-error', !passphraseValid);
    keyLenEl.classList.toggle('input-error', !keyLenValid);

    if (
        (isSrtHostRequired(mode) && !host) ||
        !portValid ||
        !latencyValid ||
        !passphraseValid ||
        !keyLenValid
    ) {
        return { error: true };
    }

    return {
        url: buildSrtOutputUrl({
            mode,
            host,
            port,
            latencyMs,
            passphrase,
            pbKeyLen,
            streamId,
        }),
    };
}

export async function submitOutputForm(btn?: HTMLButtonElement): Promise<void> {
    const pipelineId = (
        document.getElementById('out-pipe-id-input') as HTMLInputElement
    ).value.trim();
    const outId = (document.getElementById('out-id-input') as HTMLInputElement).value.trim();
    const nameEl = document.getElementById('out-name-input') as HTMLInputElement;
    const name = nameEl.value.trim();
    nameEl.classList.toggle('input-error', !name);

    // The settings of a running output are locked in the form, so only the name
    // is sent.
    const existing = state.config.outputs?.find(
        (o) => o.id === outId && String(o.pipelineId) === pipelineId,
    );
    if (outId && existing?.desiredState === 'running') {
        if (!name) return;
        await withBusy(btn, async () => {
            const result = await api.updateOutput(pipelineId, outId, { name });
            if (result) {
                outModal().close();
                await refreshAfterMutation();
            }
        });
        return;
    }

    const videoEncoding = (document.getElementById('out-video-encoding-input') as HTMLSelectElement)
        .value;
    const audioEncoding = (document.getElementById('out-audio-encoding-input') as HTMLSelectElement)
        .value;
    const translationEnabled = audioEncoding === 'translation';
    const translatorPipelineId = (
        document.getElementById('out-translation-pipeline-input') as HTMLSelectElement | null
    )?.value;
    const translatorPipeline = translatorPipelineId
        ? state.pipelines.find((p) => p.id === translatorPipelineId)
        : undefined;
    const translation =
        translationEnabled && translatorPipeline
            ? {
                  translatorStreamKey: translatorPipeline.streamKey,
                  sourceTrackIndex: Number(
                      (
                          document.getElementById(
                              'out-translation-source-track-input',
                          ) as HTMLSelectElement
                      ).value,
                  ),
                  translatorTrackIndex: Number(
                      (
                          document.getElementById(
                              'out-translation-input-track-input',
                          ) as HTMLSelectElement
                      ).value,
                  ),
                  translationDelayMs: Number(
                      (document.getElementById('out-translation-delay-input') as HTMLInputElement)
                          .value,
                  ),
                  voiceThresholdDb: Number(
                      (
                          document.getElementById(
                              'out-translation-threshold-input',
                          ) as HTMLInputElement
                      ).value,
                  ),
                  duckVolumeDb: Number(
                      (
                          document.getElementById(
                              'out-translation-duck-volume-input',
                          ) as HTMLInputElement
                      ).value,
                  ),
                  duckDurationMs: Number(
                      (
                          document.getElementById(
                              'out-translation-duck-duration-input',
                          ) as HTMLInputElement
                      ).value,
                  ),
                  restoreSilenceMs: Number(
                      (
                          document.getElementById(
                              'out-translation-restore-silence-input',
                          ) as HTMLInputElement
                      ).value,
                  ),
                  restoreVolumeDb: Number(
                      (
                          document.getElementById(
                              'out-translation-restore-volume-input',
                          ) as HTMLInputElement
                      ).value,
                  ),
                  restoreDurationMs: Number(
                      (
                          document.getElementById(
                              'out-translation-restore-duration-input',
                          ) as HTMLInputElement
                      ).value,
                  ),
              }
            : null;
    const serverIdx = parseInt(
        (document.getElementById('out-server-input') as HTMLSelectElement).value,
    );

    const row = document.querySelector('#out-sinks-container .js-sink-row');
    let url = '';
    let destinationValid = row !== null;
    if (row) {
        const keyEl = row.querySelector('.js-sink-key') as
            | HTMLInputElement
            | HTMLSelectElement
            | null;
        const key = keyEl?.value.trim() ?? '';
        if (serverIdx === CUSTOM_SRT_IDX) {
            const srt = readSrtSettings(row);
            if ('error' in srt) {
                destinationValid = false;
            } else {
                url = srt.url;
            }
        } else if (isRestreamIdx(serverIdx)) {
            const pipeline = (state.config.pipelines ?? []).find((p) => String(p.id) === key);
            keyEl?.classList.toggle('select-error', !pipeline);
            if (!pipeline) {
                destinationValid = false;
            } else {
                url =
                    serverIdx === RESTREAM_RTMP_IDX
                        ? pipeline.rtmpPublishUrlLocal
                        : pipeline.srtPublishUrlLocal;
            }
        } else if (serverIdx === INSTAGRAM_RTMP_IDX) {
            if (keyEl instanceof HTMLInputElement) keyEl.classList.toggle('input-error', !key);
            if (!key) {
                destinationValid = false;
            } else {
                url = buildInstagramUrl(key);
            }
        } else {
            if (keyEl instanceof HTMLInputElement) keyEl.classList.toggle('input-error', !key);
            if (!key) {
                destinationValid = false;
            } else {
                url = SERVERS[serverIdx].prefix + key;
                if (!isValidSinkUrl(serverIdx, url)) {
                    if (keyEl instanceof HTMLInputElement) keyEl.classList.add('input-error');
                    destinationValid = false;
                }
            }
        }
    }

    if (!name || !destinationValid) return;

    await withBusy(btn, async () => {
        const payload = { name, videoEncoding, url, audioEncoding, translation };
        const result = outId
            ? await api.updateOutput(pipelineId, outId, payload)
            : await api.createOutput(pipelineId, payload);
        if (result) {
            outModal().close();
            await refreshAfterMutation();
        }
    });
}

export async function confirmDeleteOutput(pipelineId: string, outId: string): Promise<void> {
    const output = state.config.outputs?.find(
        (o) => String(o.pipelineId) === String(pipelineId) && String(o.id) === String(outId),
    );
    const confirmed = await confirmDialog({
        title: 'Delete output?',
        message: output
            ? `Output "${output.name}" will be deleted.`
            : 'This output will be deleted.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!confirmed) return;
    const ok = await api.deleteOutput(pipelineId, outId);
    if (ok) await refreshAfterMutation();
}

export async function confirmRestartSharedEncode(pipelineId: string, outId: string): Promise<void> {
    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    const rendition = pipeline?.renditions.find((o) => o.id === outId);
    if (!rendition) return;
    const count = rendition.dependents.length;
    const confirmed = await confirmDialog({
        title: 'Restart shared encode?',
        message: `Restart ${rendition.name}? Its ${count} output${count === 1 ? '' : 's'} will reconnect.`,
        confirmLabel: 'Restart',
        danger: true,
    });
    if (!confirmed) return;
    noteSharedEncodeRestart(outId);
    const result = await api.restartOutput(pipelineId, outId);
    if (result) await refreshAfterMutation();
}

export async function startOutput(pipelineId: string, outId: string): Promise<void> {
    await api.startOutput(pipelineId, outId);
    // desiredState lives in config, so refetch it (not just health) to flip the
    // Start/Stop label and let the pending-button logic settle correctly.
    await refreshAfterMutation();
}

export async function stopOutput(pipelineId: string, outId: string): Promise<void> {
    await api.stopOutput(pipelineId, outId);
    await refreshAfterMutation();
}

export async function showPipelineLogs(pipelineId: string): Promise<void> {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = document.getElementById('logs-modal-content');
    if (!modal || !contentEl) return;
    hideLogsModalRefresh();
    hideLogsModalClearErrors();

    const pipelineName = state.pipelines.find((p) => p.id === pipelineId)?.name ?? pipelineId;
    if (titleEl) titleEl.textContent = `History — ${pipelineName}`;
    contentEl.textContent = 'Loading…';
    modal.showModal();

    const logs = await api.getPipelineLogs(pipelineId);
    if (!logs || logs.length === 0) {
        contentEl.innerHTML = '<p class="opacity-50 text-sm">No history recorded yet.</p>';
        return;
    }

    contentEl.innerHTML = logs
        .map(
            (
                l,
            ) => `<div class="flex items-center gap-3 border-b border-base-200 py-1.5 last:border-0">
                <span class="badge badge-xs leading-none ${l.event === 'online' ? 'badge-success' : 'badge-neutral'} shrink-0 uppercase">${l.event}</span>
                <span class="text-xs opacity-70 shrink-0">${formatLocalDateTime(l.ts)}</span>
                <span class="text-xs opacity-80">${l.message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
            </div>`,
        )
        .join('');
}

function renderOutputErrorHistory(
    contentEl: HTMLElement,
    history: import('../types.js').OutputErrorRecord[],
): void {
    if (history.length === 0) {
        contentEl.innerHTML = '<p class="opacity-50 text-sm">No error recorded.</p>';
        return;
    }

    contentEl.innerHTML = history
        .slice()
        .reverse()
        .map((entry, idx) => {
            const ts = entry.ts
                ? new Date(entry.ts).toLocaleString(undefined, { hour12: false })
                : '';
            // 'stopped' entries mark a deliberate stop, not a failure — badge
            // and text stay neutral so they read as diagnostic info rather
            // than an error. They're written on every stop, so the message
            // is often empty (nothing to add beyond "stopped here").
            // 'warning' entries are FFmpeg warning bursts on an output that kept
            // running — informational, shown in the warning colour.
            const isCrash = entry.kind === 'crash';
            const isWarning = entry.kind === 'warning';
            const badgeClass = isCrash
                ? 'badge-error'
                : isWarning
                  ? 'badge-warning'
                  : 'badge-neutral';
            const badgeLabel = isCrash
                ? idx === 0
                    ? 'latest crash'
                    : 'crash'
                : isWarning
                  ? 'warning'
                  : entry.message
                    ? 'stopped (stderr)'
                    : 'stopped';
            const textClass = isCrash
                ? 'text-error opacity-80'
                : isWarning
                  ? 'text-warning opacity-80'
                  : 'opacity-60';
            const body = entry.message
                ? `<pre class="text-xs ${textClass} whitespace-pre-wrap break-all overflow-x-auto">${escapeHtml(entry.message)}</pre>`
                : '';
            return `<div class="${idx === 0 ? '' : 'mt-4 pt-4 border-t border-base-200'}">
                <div class="flex items-center gap-2 mb-2">
                    <span class="badge badge-xs ${badgeClass} uppercase">${badgeLabel}</span>
                    <span class="text-xs opacity-50">${ts}</span>
                </div>
                ${body}
            </div>`;
        })
        .join('');
}

export async function showOutputError(pipelineId: string, outId: string): Promise<void> {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = document.getElementById('logs-modal-content');
    const clearBtn = document.getElementById('logs-modal-clear-errors') as HTMLButtonElement | null;
    if (!modal || !contentEl) return;
    hideLogsModalRefresh();

    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    // A shared encode is an output row too, but lives apart from `outs`.
    const output = [...(pipeline?.outs ?? []), ...(pipeline?.renditions ?? [])].find(
        (o) => o.id === outId,
    );
    if (titleEl) titleEl.textContent = `Error History - ${output?.name ?? outId}`;
    contentEl.textContent = 'Loading…';
    modal.showModal();

    if (clearBtn) {
        clearBtn.classList.remove('hidden');
        clearBtn.onclick = () =>
            withBusy(clearBtn, async () => {
                await api.clearOutputErrorHistory(pipelineId, outId);
                renderOutputErrorHistory(contentEl, []);
                clearBtn.classList.add('hidden');
                clearBtn.onclick = null;
                await refreshAfterMutation();
            });
    }

    const history = await api.getOutputErrorHistory(pipelineId, outId);
    renderOutputErrorHistory(contentEl, history ?? []);
    if (clearBtn && (!history || history.length === 0)) clearBtn.classList.add('hidden');
}

// Unlike output errors, the relay only ever carries one lastError/lastErrorAt
// pair (no persisted history), so this reads straight from the already-loaded
// health snapshot instead of calling out to an API.
export function showRelayError(pipelineId: string): void {
    const modal = document.getElementById('logs-modal') as HTMLDialogElement | null;
    const titleEl = document.getElementById('logs-modal-title');
    const contentEl = document.getElementById('logs-modal-content');
    if (!modal || !contentEl) return;
    hideLogsModalRefresh();
    hideLogsModalClearErrors();

    const pipeline = state.pipelines.find((p) => p.id === pipelineId);
    if (titleEl) titleEl.textContent = `Goryu Error — ${pipeline?.name ?? pipelineId}`;

    const message = pipeline?.srtBonding.lastError;
    if (!message) {
        contentEl.innerHTML = '<p class="opacity-50 text-sm">No error recorded.</p>';
        modal.showModal();
        return;
    }

    const ts = pipeline?.srtBonding.lastErrorAt
        ? new Date(pipeline.srtBonding.lastErrorAt).toLocaleString(undefined, { hour12: false })
        : '';
    contentEl.innerHTML = `
        <div class="text-xs opacity-50 mb-2">${ts}</div>
        <pre class="text-xs text-error opacity-80 whitespace-pre-wrap break-all overflow-x-auto">${escapeHtml(message)}</pre>
    `;
    modal.showModal();
}

function hideLogsModalRefresh(): void {
    const refreshBtn = document.getElementById('logs-modal-refresh');
    if (!refreshBtn) return;
    refreshBtn.classList.add('hidden');
    refreshBtn.classList.remove('inline-flex');
    refreshBtn.onclick = null;
}

function hideLogsModalClearErrors(): void {
    const clearBtn = document.getElementById('logs-modal-clear-errors') as HTMLButtonElement | null;
    if (!clearBtn) return;
    clearBtn.classList.add('hidden');
    clearBtn.onclick = null;
}

const LOG_TERMINALS: { label: string; elId: string; key: 'srs' | 'dashboard' | 'relay' }[] = [
    { label: 'Dashboard', elId: 'dashboard-log-tail', key: 'dashboard' },
    { label: 'SRS', elId: 'srs-log-tail', key: 'srs' },
    { label: 'Relay', elId: 'relay-log-tail', key: 'relay' },
];

// Maps ANSI SGR foreground codes to the same severity colors SRS itself
// uses (red for its ERROR lines, yellow for WARN), so the web terminal
// mirrors a real terminal instead of hand-matching level text.
const ANSI_FG_CLASS: Record<string, string> = {
    '31': 'text-error',
    '91': 'text-error',
    '33': 'text-warning',
    '93': 'text-warning',
    '32': 'text-success',
    '92': 'text-success',
    '34': 'text-info',
    '94': 'text-info',
    '36': 'text-info',
    '96': 'text-info',
    '35': 'text-secondary',
    '95': 'text-secondary',
};
// eslint-disable-next-line no-control-regex -- matches the ESC that starts an ANSI sequence
const ANSI_SGR_REGEX = /\x1b\[([0-9;]*)m/g;

function ansiLineToHtml(line: string): string {
    let html = '';
    let lastIndex = 0;
    let openSpan = false;
    ANSI_SGR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ANSI_SGR_REGEX.exec(line))) {
        html += escapeHtml(line.slice(lastIndex, match.index));
        lastIndex = ANSI_SGR_REGEX.lastIndex;
        if (openSpan) {
            html += '</span>';
            openSpan = false;
        }
        for (const code of match[1].split(';')) {
            const cls = ANSI_FG_CLASS[code];
            if (cls) {
                html += `<span class="${cls}">`;
                openSpan = true;
            }
        }
    }
    html += escapeHtml(line.slice(lastIndex));
    if (openSpan) html += '</span>';
    return html;
}

export async function showSrsLogs(): Promise<void> {
    const contentEl = document.getElementById('srs-logs-content');
    if (!contentEl) return;

    contentEl.textContent = 'Loading…';

    const data = await api.getSrsLogs();
    if (!data) return;

    const renderTerminal = (label: string, elId: string, tail: ServerLogTail): string => {
        let section = `<p class="text-xs font-semibold uppercase opacity-50 mb-2">${label} (last 200 lines)</p>`;
        if (tail.lines.length === 0) {
            const msg =
                tail.source === 'none'
                    ? `No ${label} log output found — it may not have started yet. In Docker this viewer is always empty; use \`docker compose logs\`.`
                    : `${label} log output is empty — no log output yet.`;
            section += `<p class="text-sm opacity-50 mb-4">${msg}</p>`;
        } else {
            section += `<div id="${elId}" class="h-72 overflow-y-auto rounded-xl border border-white/10 bg-black p-3">
                <pre class="text-gray-300 whitespace-pre-wrap break-all">${tail.lines.map((l) => ansiLineToHtml(l)).join('\n')}</pre>
            </div>`;
        }
        return section;
    };

    let html = '';
    for (const { label, elId, key } of LOG_TERMINALS) {
        html += renderTerminal(label, elId, data[key]);
    }

    const EVENT_SOURCE_LABEL: Record<SrsLogEvent['source'], string> = {
        srs: 'SRS',
        relay: 'Goryu',
        host: 'Host',
    };

    html += '<p class="text-xs font-semibold uppercase opacity-50 mt-4 mb-2">Server events</p>';
    if (data.events.length === 0) {
        html += '<p class="text-sm opacity-50 mb-4">No events recorded yet.</p>';
    } else {
        html +=
            '<div class="mb-4">' +
            [...data.events]
                .reverse()
                .map(
                    (e) =>
                        `<div class="flex items-center gap-3 border-b border-base-200 py-1.5 last:border-0">
                            <span class="badge badge-xs leading-none shrink-0 uppercase ${e.type === 'recovered' ? 'badge-success' : 'badge-error'}">${e.type}</span>
                            <span class="badge badge-xs badge-outline shrink-0">${EVENT_SOURCE_LABEL[e.source]}</span>
                            <span class="opacity-70 shrink-0">${formatLocalDateTime(e.ts)}</span>
                            <span class="opacity-80">${escapeHtml(e.message)}</span>
                        </div>`,
                )
                .join('') +
            '</div>';
    }

    contentEl.innerHTML = html;
    for (const { elId } of LOG_TERMINALS) {
        const tailEl = document.getElementById(elId);
        if (tailEl) tailEl.scrollTop = tailEl.scrollHeight;
    }
}

// ── Output copy / paste ───────────────────────────────

interface OutputPayloadFields {
    name: string;
    videoEncoding: string;
    url: string;
    audioEncoding: string;
}

function parseOutputItem(item: unknown): OutputPayloadFields | null {
    if (!item || typeof item !== 'object') {
        api.showError('Invalid output format in clipboard.');
        return null;
    }
    const { name, videoEncoding, url, audioEncoding } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) {
        api.showError('Each output must have a non-empty name.');
        return null;
    }
    if (typeof videoEncoding !== 'string') {
        api.showError('Each output must have a videoEncoding.');
        return null;
    }
    if (typeof url !== 'string' || !url.trim()) {
        api.showError('Each output must have a non-empty url.');
        return null;
    }
    if (typeof audioEncoding !== 'string') {
        api.showError('Each output must have an audioEncoding.');
        return null;
    }
    return {
        name: name.trim(),
        videoEncoding,
        url,
        audioEncoding,
    };
}

function parseOutputsPayload(text: string): OutputPayloadFields[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        api.showError('Clipboard content is not valid JSON.');
        return null;
    }
    if (!Array.isArray(parsed)) {
        api.showError('Expected a JSON array of outputs.');
        return null;
    }
    const outputs: OutputPayloadFields[] = [];
    for (const item of parsed) {
        const parsedItem = parseOutputItem(item);
        if (!parsedItem) return null;
        outputs.push(parsedItem);
    }
    if (outputs.length === 0) {
        api.showError('No outputs found in clipboard.');
        return null;
    }
    return outputs;
}

// Unlike parseOutputItem (used for the bulk paste-all-outputs flow, where
// every output being created needs an explicit name/encoding), a single
// output pasted into the open form can omit name/videoEncoding/audioEncoding
// and leave those fields untouched — only the destination url is meaningless
// to default. A bare RTMP/RTMPS/SRT URL on the clipboard is shorthand for
// {"url": "..."}.
interface OutputPastePayload {
    name?: string;
    videoEncoding?: string;
    url: string;
    audioEncoding?: string;
}

function parseSingleOutputPayload(text: string): OutputPastePayload | null {
    const trimmed = text.trim();
    let parsed: unknown;
    if (isDestinationUrl(trimmed)) {
        parsed = { url: trimmed };
    } else {
        try {
            parsed = JSON.parse(text);
        } catch {
            api.showError('Clipboard content is not valid JSON.');
            return null;
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        api.showError('Expected a single output object, not a list.');
        return null;
    }
    const { name, videoEncoding, url, audioEncoding } = parsed as Record<string, unknown>;
    if (typeof url !== 'string' || !url.trim()) {
        api.showError('Clipboard JSON must include a non-empty url.');
        return null;
    }
    return {
        name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
        videoEncoding:
            typeof videoEncoding === 'string' && videoEncoding ? videoEncoding : undefined,
        url,
        audioEncoding:
            typeof audioEncoding === 'string' && audioEncoding ? audioEncoding : undefined,
    };
}

export async function copyOutput(): Promise<void> {
    const pipelineId = (
        document.getElementById('out-pipe-id-input') as HTMLInputElement
    ).value.trim();
    const outId = (document.getElementById('out-id-input') as HTMLInputElement).value.trim();
    const output = state.config.outputs?.find(
        (o) => o.id === outId && String(o.pipelineId) === pipelineId,
    );
    if (!output) {
        api.showError('Save the output before copying it.');
        return;
    }
    const { name, videoEncoding, url, audioEncoding } = output;
    await copyText(JSON.stringify({ name, videoEncoding, url, audioEncoding }, null, 2));
}

export async function pasteOutputIntoForm(): Promise<void> {
    const pipelineId = (
        document.getElementById('out-pipe-id-input') as HTMLInputElement
    ).value.trim();

    let text: string;
    try {
        text = await navigator.clipboard.readText();
    } catch {
        api.showError('Could not read clipboard. Please allow clipboard access.');
        return;
    }

    const payload = parseSingleOutputPayload(text);
    if (!payload) return;

    if (payload.name) {
        const nameEl = document.getElementById('out-name-input') as HTMLInputElement;
        nameEl.value = payload.name;
        nameEl.classList.remove('input-error');
    }
    if (payload.videoEncoding) {
        (document.getElementById('out-video-encoding-input') as HTMLSelectElement).innerHTML =
            outVideoEncodingOptions(payload.videoEncoding);
    }
    const audioEncoding =
        payload.audioEncoding ??
        (document.getElementById('out-audio-encoding-input') as HTMLSelectElement | null)?.value ??
        'copy';
    populateDestination(pipelineTracks(pipelineId), {
        url: payload.url,
        audioEncoding,
    });
}

export async function startAllOutputs(pipelineId: string, btn: HTMLButtonElement): Promise<void> {
    const confirmed = await confirmDialog({
        title: 'Start all outputs?',
        message:
            'All outputs for this pipeline will be started. They start staggered to avoid overloading the server.',
        confirmLabel: 'Start All',
    });
    if (!confirmed) return;
    await withBusy(btn, async () => {
        const ok = await api.startAllOutputs(pipelineId);
        if (!ok) return;
        await refreshAfterMutation();
    });
}

export async function stopAllOutputs(pipelineId: string, btn: HTMLButtonElement): Promise<void> {
    const confirmed = await confirmDialog({
        title: 'Stop all outputs?',
        message: 'All outputs for this pipeline will be stopped.',
        confirmLabel: 'Stop All',
        danger: true,
    });
    if (!confirmed) return;
    await withBusy(btn, async () => {
        const ok = await api.stopAllOutputs(pipelineId);
        if (!ok) return;
        await refreshAfterMutation();
    });
}

export async function copyOutputs(pipelineId: string): Promise<void> {
    const outputs = (state.config.outputs ?? [])
        .filter((o) => String(o.pipelineId) === pipelineId)
        .map(({ name, videoEncoding, url, audioEncoding }) => ({
            name,
            videoEncoding,
            url,
            audioEncoding,
        }));
    await copyText(JSON.stringify(outputs, null, 2));
}

export async function pasteOutputs(pipelineId: string, btn: HTMLButtonElement): Promise<void> {
    const confirmed = await confirmDialog({
        title: 'Replace all outputs?',
        message:
            'All outputs for this pipeline will be replaced with the clipboard contents. This cannot be undone.',
        confirmLabel: 'Replace',
        danger: true,
    });
    if (!confirmed) return;

    let text: string;
    try {
        text = await navigator.clipboard.readText();
    } catch {
        api.showError('Could not read clipboard. Please allow clipboard access.');
        return;
    }

    const outputs = parseOutputsPayload(text);
    if (!outputs) return;

    await withBusy(btn, async () => {
        const cleared = await api.clearOutputs(pipelineId);
        if (!cleared) return;

        const created = await api.createOutputsBulk(pipelineId, outputs);
        if (!created) return;

        await refreshAfterMutation();
    });
}
