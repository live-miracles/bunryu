import type {
    ConfigData,
    HealthData,
    RejectedPublishesData,
    PipelineLog,
    OutputPayload,
    OutputErrorRecord,
    SystemMetrics,
    MetricSample,
    SrsLogsData,
    LayoutOrderEntry,
    LegHistoryData,
    PipelineGroup,
} from '../types.js';

let loadingCount = 0;
let serverUnreachable = false;

export function isServerUnreachable(): boolean {
    return serverUnreachable;
}

function setConnectionBanner(unreachable: boolean): void {
    if (unreachable === serverUnreachable) return;
    serverUnreachable = unreachable;
    const banner = document.getElementById('connection-banner');
    banner?.classList.toggle('hidden', !unreachable);
    banner?.classList.toggle('flex', unreachable);
}

function setLoading(active: boolean): void {
    const el = document.getElementById('saving-badge');
    if (active) {
        loadingCount++;
        el?.classList.remove('hidden');
        el?.classList.add('flex');
    } else {
        loadingCount = Math.max(0, loadingCount - 1);
        if (loadingCount === 0) {
            el?.classList.add('hidden');
            el?.classList.remove('flex');
        }
    }
}

export function showError(msg: unknown): void {
    const el = document.getElementById('error-msg');
    const alert = document.getElementById('error-alert');
    if (el) el.textContent = String(msg);
    alert?.classList.remove('hidden');
    setTimeout(() => alert?.classList.add('hidden'), 5000);
}

const isMutating = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

async function apiRequest<T>(
    url: string,
    opts: { method?: string; body?: unknown; silent?: boolean; timeoutMs?: number } = {},
): Promise<T | null> {
    const method = opts.method?.toUpperCase() || 'GET';
    const fetchOpts: RequestInit = { method };
    const controller = opts.timeoutMs ? new AbortController() : undefined;
    if (controller) fetchOpts.signal = controller.signal;
    const timeout = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
    if (opts.body !== undefined) {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = JSON.stringify(opts.body);
    }
    const showLoading = isMutating(method) && !opts.silent;
    if (showLoading) setLoading(true);
    try {
        const res = await fetch(url, fetchOpts);
        if (res.status === 401) {
            window.location.href = '/login';
            return null;
        }
        // A non-JSON body (a proxy's error page) is still a server answer: only
        // a failure to get any response means the connection is down.
        const data = (await res.json().catch(() => undefined)) as
            | (T & { error?: string })
            | undefined;
        if (!res.ok) {
            showError(data?.error || `HTTP ${res.status}`);
            return null;
        }
        if (data === undefined) throw new Error('invalid JSON response');
        setConnectionBanner(false);
        return data;
    } catch {
        setConnectionBanner(true);
        return null;
    } finally {
        if (timeout) clearTimeout(timeout);
        if (showLoading) setLoading(false);
    }
}

export const getConfig = () => apiRequest<ConfigData>('/api/config');
export const getHealth = () => apiRequest<HealthData>('/api/health');
export const getRejectedPublishes = () =>
    apiRequest<RejectedPublishesData>('/api/rejected-publishes');
export const getSystemMetrics = () => apiRequest<SystemMetrics>('/api/metrics/system');
export const getMetricsHistory = (after?: number) =>
    apiRequest<MetricSample[]>(
        after === undefined ? '/api/metrics/history' : `/api/metrics/history?after=${after}`,
    );
export const getLegHistory = (pipelineId: string, from: number, to: number, after?: number) =>
    apiRequest<LegHistoryData>(
        `/api/health/pipelines/${encodeURIComponent(pipelineId)}/legs/history?from=${Math.round(from)}&to=${Math.round(to)}${after === undefined ? '' : `&after=${Math.round(after)}`}`,
        { timeoutMs: 15_000 },
    );

export const updateGeneralSettings = (name: string, publicHost: string) =>
    apiRequest<{ serverName: string; publicHost: string }>('/api/settings/general', {
        method: 'POST',
        body: { name, publicHost },
    });

export const updateLayoutOrder = (order: LayoutOrderEntry[]) =>
    apiRequest<{ layoutOrder: LayoutOrderEntry[] }>('/api/settings/layout-order', {
        method: 'POST',
        body: { order },
    });

export const updatePipelineGroups = (groups: { id?: number; name: string }[]) =>
    apiRequest<{ groups: PipelineGroup[] }>('/api/settings/pipeline-groups', {
        method: 'POST',
        body: { groups },
    });

export const createPipeline = () => apiRequest('/api/pipelines', { method: 'POST' });

export const updatePipeline = (
    id: string,
    name: string,
    streamKeyId?: number,
    groupId?: number | null,
) =>
    apiRequest(`/api/pipelines/${id}`, {
        method: 'POST',
        body: {
            name,
            ...(streamKeyId !== undefined ? { streamKeyId } : {}),
            ...(groupId !== undefined ? { groupId } : {}),
        },
    });

export const deletePipeline = (id: string) =>
    apiRequest(`/api/pipelines/${id}`, { method: 'DELETE' });

export const createOutput = (pipelineId: string, data: OutputPayload) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs`, { method: 'POST', body: data });

// A running output accepts only its name; the server refuses any other field.
export const updateOutput = (
    pipelineId: string,
    outId: string,
    data: OutputPayload | { name: string },
) => apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}`, { method: 'POST', body: data });

export const deleteOutput = (pipelineId: string, outId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}`, { method: 'DELETE' });

export const clearOutputs = (pipelineId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs`, { method: 'DELETE' });

export const createOutputsBulk = (pipelineId: string, outputs: OutputPayload[]) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/bulk`, { method: 'POST', body: { outputs } });

export const startAllOutputs = (pipelineId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/start-all`, { method: 'POST' });

export const stopAllOutputs = (pipelineId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/stop-all`, { method: 'POST' });

export const startOutput = (pipelineId: string, outId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}/start`, { method: 'POST' });

export const stopOutput = (pipelineId: string, outId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}/stop`, { method: 'POST' });

export const restartOutput = (pipelineId: string, outId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/outputs/${outId}/restart`, { method: 'POST' });

export const getOutputErrorHistory = (pipelineId: string, outId: string) =>
    apiRequest<OutputErrorRecord[]>(`/api/pipelines/${pipelineId}/outputs/${outId}/errors`);

export const startPreview = (pipelineId: string, audioTrackCount?: number) =>
    apiRequest<{ hlsUrl: string }>(`/api/pipelines/${pipelineId}/preview/start`, {
        method: 'POST',
        body: { audioTrackCount: audioTrackCount ?? 1 },
        silent: true,
    });

export const stopPreview = (pipelineId: string) =>
    apiRequest(`/api/pipelines/${pipelineId}/preview/stop`, { method: 'POST', silent: true });

export const previewKeepalive = (pipelineId: string) =>
    apiRequest<{ active: boolean }>(`/api/pipelines/${pipelineId}/preview/keepalive`, {
        method: 'POST',
        silent: true,
    });

export const logout = () => apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });

export const getVersion = () =>
    apiRequest<{
        app: string;
        commit: string;
        srs: string;
        srtRelay: string;
        ffmpeg: string;
        node: string;
        os: string;
        kernel: string;
        cpuModel: string;
    }>('/api/version');

export const changePassword = (currentPassword: string, newPassword: string) =>
    apiRequest<{ ok: boolean }>('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
    });

export const regenerateStreamKeys = () =>
    apiRequest<{ streamKeys: unknown[] }>('/api/settings/regenerate-stream-keys', {
        method: 'POST',
    });

export const resetSrtPassphrase = () =>
    apiRequest<{ ok: boolean }>('/api/settings/reset-srt-passphrase', {
        method: 'POST',
    });

export const getPipelineLogs = (pipelineId: string) =>
    apiRequest<PipelineLog[]>(`/api/pipelines/${pipelineId}/logs`);

export const getSrsLogs = () => apiRequest<SrsLogsData>('/api/srs-logs');
