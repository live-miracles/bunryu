import { getUrlParam, setUrlParam } from '../core/utils.js';
import { state } from '../core/state.js';
import { refreshDashboard } from './dashboard.js';
import { initSoundAlerts } from './sound-alerts.js';
import { initTheme } from './theme.js';
import { setOutputsListFilter } from './render.js';
import {
    openSettings,
    submitGeneralSettingsForm,
    submitKeyVaultForm,
    submitPasswordForm,
    logoutUser,
    regenerateStreamKeysBtn,
    resetSrtPassphraseBtn,
    createPipeline,
    submitPipelineForm,
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
import {
    addPipelineGroup,
    editPipelineGroup,
    removePipelineGroup,
    submitPipelineGroupForm,
} from './pipeline-groups.js';
import { copyConfig, pasteConfig } from './config-copy.js';

declare global {
    interface Window {
        // Called from rendered views (status-view.ts, render.ts, editor.ts).
        openSrsLogsBtn: () => Promise<void>;
        editPipelineGroupBtn: (id: number) => void;
        removePipelineGroupBtn: (id: number) => Promise<void>;
        selectPipeline: (id: string | null) => void;
    }
}

// Below xl the panels stack (under the list, or in one column beside it), so after picking a
// pipeline or a view, scroll its panel into view.
const stackedLayout = window.matchMedia('(max-width: 1279px)');
function showContentPanel(): void {
    if (!stackedLayout.matches) return;
    const panel = ['pipe-info-col', 'overview-col', 'status-col', 'srs-logs-col', 'settings-col']
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
window.editPipelineGroupBtn = (id) => editPipelineGroup(id);
window.removePipelineGroupBtn = (id) => removePipelineGroup(id);
window.selectPipeline = (id) => {
    void import('./preview.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
    setUrlParam('p', id);
    setUrlParam('view', null);
    void refreshDashboard().then(showContentPanel);
};

async function openStatus(): Promise<void> {
    void import('./preview.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
    setUrlParam('p', null);
    setUrlParam('view', 'status');
    await refreshDashboard();
    showContentPanel();
}

async function openSettingsView(): Promise<void> {
    void import('./preview.js').then(({ stopCurrentPreview }) => stopCurrentPreview());
    setUrlParam('p', null);
    setUrlParam('view', 'settings');
    await refreshDashboard();
    openSettings();
    showContentPanel();
}

function byId<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

async function togglePreview(): Promise<void> {
    const {
        getPreviewPipelineId,
        stopCurrentPreview,
        attachHls,
        setPreviewStarting,
        endPreviewStarting,
        isPreviewStarting,
        syncPreviewControls,
    } = await import('./preview.js');
    if (isPreviewStarting()) return;
    if (getPreviewPipelineId()) {
        stopCurrentPreview();
        return;
    }
    const id = getUrlParam('p');
    if (!id) return;
    setPreviewStarting();
    const { startPreview, stopPreview } = await import('../core/api.js');
    const pipeline = state.pipelines.find((p) => p.id === id);
    // The server accepts at most 50; a publisher can advertise more.
    const audioTrackCount = Math.min(50, Math.max(1, pipeline?.input.audioTracks.length ?? 1));
    const result = await startPreview(id, audioTrackCount);
    endPreviewStarting();
    if (result?.hlsUrl && getUrlParam('p') !== id) {
        // The user moved to another pipeline while this one was starting, and
        // stopCurrentPreview() had nothing to stop yet: stop it here instead of
        // showing its video under the other pipeline's name.
        void stopPreview(id);
        syncPreviewControls(false);
    } else if (result?.hlsUrl) {
        attachHls(id, result.hlsUrl);
    } else {
        syncPreviewControls(false);
    }
}

// Shows or masks a secret field; the button holds the two icons (shown, hidden).
function toggleSecret(input: HTMLInputElement, btn: HTMLElement): void {
    let show: boolean;
    if (input.hasAttribute('data-mask')) {
        // A text box masked by CSS (.secret-mask), so Chrome does not take it for a password.
        show = input.classList.contains('secret-mask');
        input.classList.toggle('secret-mask', !show);
    } else {
        show = input.type === 'password';
        input.type = show ? 'text' : 'password';
    }
    btn.children[0].classList.toggle('hidden', show);
    btn.children[1].classList.toggle('hidden', !show);
}

// The static markup's controls name their action in a data attribute (data-click,
// data-input, data-change, data-paste); one listener per event type looks it up here.
// The Content-Security-Policy refuses inline handlers, so there are none.
type Handler = (el: HTMLElement, event: Event) => unknown;
const button = (el: HTMLElement) => el as HTMLButtonElement;

const CLICK: Record<string, Handler> = {
    'show-overview': () => window.selectPipeline(null),
    // From the sidebar's warning/error count badges to the overview with the "Issues"
    // filter active, so a red badge is one click from the failing rows.
    'show-problems': () => {
        state.overviewFilter = 'problems';
        window.selectPipeline(null);
    },
    'open-status': () => openStatus(),
    'open-settings': () => openSettingsView(),
    'open-logs': () => window.openSrsLogsBtn(),
    'refresh-logs': () => showSrsLogs(),
    'add-pipeline': (el) => createPipeline(button(el)),
    'pipeline-form': (el) => submitPipelineForm(button(el)),
    'add-pipeline-group': () => addPipelineGroup(),
    'pipeline-group-form': (el) => submitPipelineGroupForm(button(el)),
    'add-output': () => {
        const id = getUrlParam('p');
        if (id) openAddOutput(id);
    },
    'output-form': (el) => submitOutputForm(button(el)),
    'output-copy': () => copyOutput(),
    'output-paste': () => pasteOutputIntoForm(),
    'outputs-copy': async () => {
        const id = getUrlParam('p');
        if (id) await copyOutputs(id);
    },
    'outputs-paste': async () => {
        const id = getUrlParam('p');
        const btn = byId<HTMLButtonElement>('outputs-paste-btn');
        if (id && btn) await pasteOutputs(id, btn);
    },
    'outputs-start-all': async () => {
        const id = getUrlParam('p');
        const btn = byId<HTMLButtonElement>('outputs-start-all-btn');
        if (id && btn) await startAllOutputs(id, btn);
    },
    'outputs-stop-all': async () => {
        const id = getUrlParam('p');
        const btn = byId<HTMLButtonElement>('outputs-stop-all-btn');
        if (id && btn) await stopAllOutputs(id, btn);
    },
    'outputs-problems': () =>
        setOutputsListFilter({ problemsOnly: !state.outputsListProblemsOnly }),
    'preview-toggle': () => togglePreview(),
    'preview-mute': () =>
        import('./preview.js').then(({ togglePreviewMute }) => togglePreviewMute()),
    'preview-reload': () => import('./preview.js').then(({ reloadPreview }) => reloadPreview()),
    'preview-maximize': () =>
        import('./preview.js').then(({ togglePreviewMaximize }) => togglePreviewMaximize()),
    'settings-general-form': (el) => submitGeneralSettingsForm(button(el)),
    'settings-key-vault-form': (el) => submitKeyVaultForm(button(el)),
    'settings-password-form': (el) => submitPasswordForm(button(el)),
    'copy-config': () => copyConfig(),
    'paste-config': (el) => pasteConfig(button(el)),
    'regenerate-stream-keys': (el) => regenerateStreamKeysBtn(button(el)),
    'reset-srt-passphrase': (el) => resetSrtPassphraseBtn(button(el)),
    logout: () => logoutUser(),
    'toggle-secret': (el) => {
        const input = byId<HTMLInputElement>(el.dataset.target ?? '');
        if (input) toggleSecret(input, el);
    },
};
const INPUT: Record<string, Handler> = {
    'outputs-search': (el) => setOutputsListFilter({ search: (el as HTMLInputElement).value }),
};
const CHANGE: Record<string, Handler> = {
    'preview-track': () =>
        import('./preview.js').then(({ previewTrackChange }) => previewTrackChange()),
    'srt-mode': () => syncSrtHostVisibility(),
    'out-server': (el) => onOutServerChange(el as HTMLSelectElement),
};
const PASTE: Record<string, Handler> = {
    'sink-key': (_el, event) => onSinkKeyPaste(event as ClipboardEvent),
};

function delegate(type: string, attribute: string, handlers: Record<string, Handler>): void {
    document.addEventListener(type, (event) => {
        const el = (event.target as Element | null)?.closest?.<HTMLElement>(`[${attribute}]`);
        const handler = el && handlers[el.getAttribute(attribute) ?? ''];
        if (handler) void handler(el, event);
    });
}
delegate('click', 'data-click', CLICK);
delegate('input', 'data-input', INPUT);
delegate('change', 'data-change', CHANGE);
delegate('paste', 'data-paste', PASTE);

// A field marked invalid is cleared as soon as it is edited (data-clear-error names the
// class; data-clear-error-also another field that goes with it, such as a confirmation).
for (const type of ['input', 'change']) {
    document.addEventListener(type, (event) => {
        const el = (event.target as Element | null)?.closest?.<HTMLElement>('[data-clear-error]');
        if (!el) return;
        const cls = el.dataset.clearError ?? '';
        el.classList.remove(cls);
        if (el.dataset.clearErrorAlso) byId(el.dataset.clearErrorAlso)?.classList.remove(cls);
    });
}
// Enter in a field marked data-enter presses the button it names.
document.addEventListener('keydown', (event) => {
    const el = (event.target as Element | null)?.closest?.<HTMLElement>('[data-enter]');
    if (!el || (event as KeyboardEvent).key !== 'Enter') return;
    event.preventDefault();
    byId<HTMLButtonElement>(el.dataset.enter ?? '')?.click();
});
// Forms that only group fields are never submitted; their buttons act on click.
document.addEventListener('submit', (event) => {
    if ((event.target as Element).matches('form[data-no-submit]')) event.preventDefault();
});

initSoundAlerts();
initTheme();

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
