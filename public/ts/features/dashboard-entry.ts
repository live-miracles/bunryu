import { getUrlParam, setUrlParam, copyText } from '../core/utils.js';
import { state } from '../core/state.js';
import { refreshDashboard } from './dashboard.js';
import { initSoundAlerts } from './sound-alerts.js';
import { setOutputsListFilter } from './render.js';
import {
    openSettings,
    addPipelineGroupRow,
    removePipelineGroupRow,
    submitGeneralSettingsForm,
    submitPipelineGroupsForm,
    submitPasswordForm,
    logoutUser,
    regenerateStreamKeysBtn,
    resetSrtPassphraseBtn,
    createPipeline,
    openEditPipeline,
    submitPipelineForm,
    confirmDeletePipeline,
    showPipelineLogs,
    showSrsLogs,
    openAddOutput,
    submitOutputForm,
    onOutServerChange,
    onSinkKeyPaste,
    copyOutput,
    pasteOutputIntoForm,
    copyOutputs,
    pasteOutputs,
    startAllOutputs,
    stopAllOutputs,
    syncSrtHostVisibility,
} from './editor.js';

declare global {
    interface Window {
        openSrsLogsBtn: () => Promise<void>;
        refreshSrsLogsBtn: () => Promise<void>;
        openSettingsBtn: () => Promise<void>;
        addPipelineGroupRowBtn: () => void;
        removePipelineGroupRowBtn: (rowKey: string) => void;
        settingsGeneralFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        settingsPipelineGroupsFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        settingsPasswordFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        logoutBtn: () => Promise<void>;
        regenerateStreamKeysBtn: (btn?: HTMLButtonElement) => Promise<void>;
        resetSrtPassphraseBtn: (btn?: HTMLButtonElement) => Promise<void>;
        selectPipeline: (id: string | null) => void;
        addPipeBtn: (btn?: HTMLButtonElement) => Promise<void>;
        pipeFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        editPipeBtn: () => void;
        deletePipeBtn: (btn?: HTMLButtonElement) => Promise<void>;
        pipeHistoryBtn: () => Promise<void>;
        addOutBtn: () => void;
        outputsCopyBtn: () => Promise<void>;
        outputsPasteBtn: () => Promise<void>;
        outputsSearchInput: (value: string) => void;
        outputsProblemsToggle: () => void;
        outputsStartAllBtn: () => Promise<void>;
        outputsStopAllBtn: () => Promise<void>;
        outFormBtn: (btn?: HTMLButtonElement) => Promise<void>;
        outServerChange: (select: HTMLSelectElement) => void;
        srtModeChange: () => void;
        onSinkKeyPaste: (event: ClipboardEvent) => void;
        outCopyBtn: () => Promise<void>;
        outPasteBtn: () => Promise<void>;
        copyText: (text: string) => Promise<void>;
        previewToggleBtn: () => Promise<void>;
        previewTrackChange: () => void;
        previewMuteBtn: () => void;
        previewReloadBtn: () => void;
        previewMaximizeBtn: () => void;
        showProblemsOverviewBtn: () => void;
    }
}

// Jump from the sidebar's warning/error count badges to the overview with the
// "Issues" filter active, so a red badge is one click from the failing rows.
window.showProblemsOverviewBtn = () => {
    state.overviewFilter = 'problems';
    window.selectPipeline(null);
};

// Below xl the panels stack (under the list, or in one column beside it), so after picking a
// pipeline or a view, scroll its panel into view.
const stackedLayout = window.matchMedia('(max-width: 1279px)');
function showContentPanel(): void {
    if (!stackedLayout.matches) return;
    const panel = ['pipe-info-col', 'overview-col', 'srs-logs-col', 'settings-col']
        .map((id) => document.getElementById(id))
        .find((el) => el && !el.classList.contains('hidden'));
    panel?.scrollIntoView({ block: 'start' });
}

window.openSrsLogsBtn = async () => {
    void import('./preview.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
    setUrlParam('p', null);
    setUrlParam('view', 'logs');
    await refreshDashboard();
    await showSrsLogs();
    showContentPanel();
};
window.refreshSrsLogsBtn = async () => {
    await showSrsLogs();
};
window.openSettingsBtn = async () => {
    void import('./preview.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
    setUrlParam('p', null);
    setUrlParam('view', 'settings');
    await refreshDashboard();
    openSettings();
    showContentPanel();
};
window.addPipelineGroupRowBtn = () => addPipelineGroupRow();
window.removePipelineGroupRowBtn = (rowKey) => removePipelineGroupRow(rowKey);
window.settingsGeneralFormBtn = (btn) => submitGeneralSettingsForm(btn);
window.settingsPipelineGroupsFormBtn = (btn) => submitPipelineGroupsForm(btn);
window.settingsPasswordFormBtn = (btn) => submitPasswordForm(btn);
window.logoutBtn = () => logoutUser();
window.regenerateStreamKeysBtn = (btn) => regenerateStreamKeysBtn(btn);
window.resetSrtPassphraseBtn = (btn) => resetSrtPassphraseBtn(btn);

window.selectPipeline = (id) => {
    void import('./preview.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
    setUrlParam('p', id);
    setUrlParam('view', null);
    void refreshDashboard().then(showContentPanel);
};

window.addPipeBtn = (btn) => createPipeline(btn);
window.pipeFormBtn = (btn) => submitPipelineForm(btn);

window.editPipeBtn = () => {
    if (document.getElementById('pipe-edit-btn')?.classList.contains('btn-disabled')) return;
    const id = getUrlParam('p');
    if (id) openEditPipeline(id);
};

window.deletePipeBtn = async (btn) => {
    if (document.getElementById('pipe-delete-btn')?.classList.contains('btn-disabled')) return;
    const id = getUrlParam('p');
    if (id) await confirmDeletePipeline(id, btn);
};

window.pipeHistoryBtn = async () => {
    const id = getUrlParam('p');
    if (id) await showPipelineLogs(id);
};

window.addOutBtn = () => {
    const id = getUrlParam('p');
    if (id) openAddOutput(id);
};

window.outputsCopyBtn = async () => {
    const id = getUrlParam('p');
    if (id) await copyOutputs(id);
};

window.outputsPasteBtn = async () => {
    const id = getUrlParam('p');
    const btn = document.getElementById('outputs-paste-btn') as HTMLButtonElement | null;
    if (id && btn) await pasteOutputs(id, btn);
};

window.outputsSearchInput = (value) => setOutputsListFilter({ search: value });

window.outputsProblemsToggle = () =>
    setOutputsListFilter({ problemsOnly: !state.outputsListProblemsOnly });

window.outputsStartAllBtn = async () => {
    const id = getUrlParam('p');
    const btn = document.getElementById('outputs-start-all-btn') as HTMLButtonElement | null;
    if (id && btn) await startAllOutputs(id, btn);
};

window.outputsStopAllBtn = async () => {
    const id = getUrlParam('p');
    const btn = document.getElementById('outputs-stop-all-btn') as HTMLButtonElement | null;
    if (id && btn) await stopAllOutputs(id, btn);
};

window.outFormBtn = (btn) => submitOutputForm(btn);
window.outServerChange = (select) => onOutServerChange(select);
window.srtModeChange = () => syncSrtHostVisibility();
window.onSinkKeyPaste = (event) => onSinkKeyPaste(event);
window.outCopyBtn = () => copyOutput();
window.outPasteBtn = () => pasteOutputIntoForm();

window.copyText = copyText;

window.previewToggleBtn = async () => {
    const {
        getPreviewPipelineId,
        stopCurrentPreview,
        attachHls,
        setPreviewStarting,
        syncPreviewControls,
    } = await import('./preview.js');
    if (getPreviewPipelineId()) {
        stopCurrentPreview();
        return;
    }
    const id = getUrlParam('p');
    if (!id) return;
    setPreviewStarting();
    const { startPreview } = await import('../core/api.js');
    const pipeline = state.pipelines.find((p) => p.id === id);
    // The server accepts at most 50; a publisher can advertise more.
    const audioTrackCount = Math.min(50, Math.max(1, pipeline?.input.audioTracks.length ?? 1));
    const result = await startPreview(id, audioTrackCount);
    if (result?.hlsUrl) {
        attachHls(id, result.hlsUrl);
    } else {
        syncPreviewControls(false);
    }
};

window.previewTrackChange = () => {
    void import('./preview.js').then(({ previewTrackChange }) => previewTrackChange());
};

window.previewMuteBtn = () => {
    void import('./preview.js').then(({ togglePreviewMute }) => togglePreviewMute());
};

window.previewReloadBtn = () => {
    void import('./preview.js').then(({ reloadPreview }) => reloadPreview());
};

window.previewMaximizeBtn = () => {
    void import('./preview.js').then(({ togglePreviewMaximize }) => togglePreviewMaximize());
};

initSoundAlerts();

// A page load can start directly on ?view=settings or ?view=logs (bookmark,
// reload). Those views are otherwise only populated when the user clicks the
// corresponding navbar button, so without this they'd render as an empty
// column until that click happens.
void (async () => {
    const initialView = getUrlParam('view');
    if (initialView !== 'settings' && initialView !== 'logs') return;
    await refreshDashboard();
    if (initialView === 'settings') openSettings();
    else await showSrsLogs();
})();
