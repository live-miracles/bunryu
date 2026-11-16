import type { KeyVaultConfig } from '../utils/keyVaultConfig.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';
import type { HealthSnapshot } from './health.js';
import type { Db } from '../types.js';
import {
    buildPayload,
    hashDestination,
    payloadSignature,
    type KeyVaultPayload,
} from '../utils/keyVaultPayload.js';
import type { ReportedStatus } from '../utils/outputStatus.js';

// Pushes the status of every configured output to Key Vault: one report a minute,
// and one at once when a status changes (at most one per 10 s). The reporter is a
// side channel: whatever the receiver does (down, slow, errors), the control plane,
// the outputs and the dashboard are not affected, and it never retries in a tight loop.
// Its settings are the operator's, from Settings: `reconfigure()` applies a change while
// the server runs, so nothing here needs a restart and nothing can stop the server starting.

export interface KeyVaultReporterOptions {
    // A report is sent at least this often, so Key Vault can tell bunryu is alive.
    heartbeatMs: number;
    // After a send, a status change waits until this much time has passed.
    minChangeIntervalMs: number;
    // One request; a report is given up after the last retry.
    timeoutMs: number;
    // Waits before each retry of a failed report: 2 retries, 37 s at the very most
    // with the default timeout, inside one heartbeat.
    retryDelaysMs: number[];
}

export const DEFAULT_REPORTER_OPTIONS: KeyVaultReporterOptions = {
    heartbeatMs: 60_000,
    minChangeIntervalMs: 10_000,
    timeoutMs: 10_000,
    retryDelaysMs: [2_000, 5_000],
};

export interface KeyVaultReporterDeps {
    // The saved settings; null means off. It may throw when the stored value cannot be
    // used: that is logged and the reporter stays off. Read at start() and reconfigure().
    getConfig: () => KeyVaultConfig | null;
    // The name this server reports under: the server name from Settings, read for every
    // report so that a rename needs no new settings.
    getInstance: () => string;
    db: Pick<Db, 'listPipelines' | 'listOutputs' | 'getOutputErrorHistory'>;
    health: {
        onSnapshot(listener: (snapshot: HealthSnapshot) => void): void;
        getSnapshot(): HealthSnapshot;
    };
    diagnostics?: DiagnosticsLogger;
    options?: Partial<KeyVaultReporterOptions>;
    // For tests.
    fetchFn?: typeof fetch;
    now?: () => number;
}

export interface KeyVaultReporterState {
    enabled: boolean;
    lastAttemptAtMs: number | null;
    lastSuccessAtMs: number | null;
    // Failed reports in a row (0 while Key Vault accepts them).
    consecutiveFailures: number;
}

type SendReason = 'heartbeat' | 'change';

class ReportError extends Error {
    constructor(
        message: string,
        readonly status: number | null,
        readonly retryable: boolean,
    ) {
        super(message);
    }
}

const MAX_HASH_CACHE = 5000;

function errorText(err: unknown): string {
    if (err instanceof Error) {
        const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
        return `${err.message}${cause}`;
    }
    return String(err);
}

export function createKeyVaultReporter(deps: KeyVaultReporterDeps) {
    const { db, health, diagnostics } = deps;
    const options = { ...DEFAULT_REPORTER_OPTIONS, ...deps.options };
    const fetchFn = deps.fetchFn ?? fetch;
    const now = deps.now ?? Date.now;

    const sinceById = new Map<string, { status: ReportedStatus; sinceMs: number }>();
    const hashCache = new Map<string, string>();
    const shutdownController = new AbortController();
    // Ends the report on its way when the settings change, so the old token and URL are
    // not used again and the new settings are reported at once.
    let settingsAbort = new AbortController();

    let started = false;
    let stopped = false;
    let snapshotSeen = false;
    let inFlight = false;
    let resendRequested = false;
    let lastAttemptAtMs: number | null = null;
    let lastSuccessAtMs: number | null = null;
    let lastSignature: string | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let changeTimer: NodeJS.Timeout | null = null;
    // A failure episode starts with the first failed report and ends with the next
    // good one; it is logged once at each end, however many reports fail in between.
    let episode: { sinceMs: number; failedReports: number } | null = null;
    // A failure to build the report (a database error) has its own episode.
    let buildFailing = false;

    let config: KeyVaultConfig | null = null;
    // The endpoint without its query: where the reports go, for the log.
    let endpoint = '';

    function endpointOf(c: KeyVaultConfig | null): string {
        if (!c) return '';
        const target = new URL(c.url);
        return `${target.origin}${target.pathname}`;
    }

    function settingsKey(c: KeyVaultConfig | null): string {
        return c ? JSON.stringify(c) : '';
    }

    // Reads the saved settings. A stored value that cannot be used turns the reporter off
    // and says so, once per read.
    function loadConfig(): void {
        try {
            config = deps.getConfig();
        } catch (err) {
            config = null;
            const error = errorText(err);
            console.error(`[key-vault] saved settings are not usable, reporting is off: ${error}`);
            diagnostics?.event('key-vault-settings-invalid', { error });
        }
        endpoint = endpointOf(config);
    }

    // For logs and diagnostics only: a failing read of the name must not break the
    // failure path that is reporting something else. (build() reads it unguarded; its
    // failure is reported as a build failure.)
    function instanceForLog(): string {
        try {
            return deps.getInstance();
        } catch {
            return '(unknown)';
        }
    }

    function hashOf(url: string): string {
        let hash = hashCache.get(url);
        if (hash === undefined) {
            if (hashCache.size >= MAX_HASH_CACHE) hashCache.clear();
            hash = hashDestination(config!.hashSecret, url);
            hashCache.set(url, hash);
        }
        return hash;
    }

    function failedAttemptsOf(outputId: string): number {
        const stop = db
            .getOutputErrorHistory(outputId)
            .filter((record) => record.kind === 'stopped' && record.failedAttempts)
            .at(-1);
        return stop?.failedAttempts ?? 0;
    }

    function build(): KeyVaultPayload {
        return buildPayload({
            instance: deps.getInstance(),
            hashSecret: config!.hashSecret,
            pipelines: db.listPipelines(),
            outputs: db.listOutputs(),
            health: health.getSnapshot().pipelines,
            failedAttemptsOf,
            sinceById,
            nowMs: now(),
            hashOf,
        });
    }

    function sleep(ms: number, cancel: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            timer.unref();
            cancel.addEventListener(
                'abort',
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                { once: true },
            );
        });
    }

    async function postOnce(cfg: KeyVaultConfig, body: string, cancel: AbortSignal): Promise<void> {
        let response: Response;
        try {
            response = await fetchFn(cfg.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${cfg.token}`,
                },
                body,
                // A redirect would send the token somewhere else, or turn the POST into a GET.
                redirect: 'error',
                signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs), cancel]),
            });
        } catch (err) {
            const timedOut = err instanceof Error && err.name === 'TimeoutError';
            throw new ReportError(
                timedOut ? `timed out after ${options.timeoutMs} ms` : errorText(err),
                null,
                true,
            );
        }
        // The answer is not used; free the connection.
        try {
            await response.body?.cancel();
        } catch {
            // Already closed.
        }
        if (!response.ok) {
            // A client error (a wrong token, a rejected payload) will not pass by waiting.
            const retryable =
                response.status >= 500 || response.status === 408 || response.status === 429;
            throw new ReportError(`HTTP ${response.status}`, response.status, retryable);
        }
    }

    // One report: the first try and, while the failure may pass, the retries.
    async function post(cfg: KeyVaultConfig, body: string, cancel: AbortSignal): Promise<number> {
        for (let attempt = 1; ; attempt++) {
            try {
                await postOnce(cfg, body, cancel);
                return attempt;
            } catch (err) {
                const retryDelay = options.retryDelaysMs[attempt - 1];
                const retryable = err instanceof ReportError ? err.retryable : true;
                if (!retryable || retryDelay === undefined || cancel.aborted) {
                    if (err instanceof ReportError) throw Object.assign(err, { attempts: attempt });
                    throw err;
                }
                await sleep(retryDelay, cancel);
                if (cancel.aborted) throw err;
            }
        }
    }

    function recordFailure(err: unknown, reason: SendReason): void {
        const error = errorText(err);
        const attempts = (err as { attempts?: number }).attempts ?? 1;
        if (episode) {
            episode.failedReports += 1;
            return;
        }
        episode = { sinceMs: now(), failedReports: 1 };
        console.error(
            `[key-vault] report to ${endpoint} failed: ${error} (further failures are not logged until it recovers)`,
        );
        diagnostics?.event('key-vault-report-failed', {
            instance: instanceForLog(),
            endpoint,
            reason,
            error,
            status: err instanceof ReportError ? err.status : null,
            attempts,
        });
    }

    function recordSuccess(outputs: number, attempts: number): void {
        lastSuccessAtMs = now();
        if (!episode) return;
        const { failedReports, sinceMs } = episode;
        episode = null;
        console.log(
            `[key-vault] reporting to ${endpoint} recovered after ${failedReports} failed report(s)`,
        );
        diagnostics?.event('key-vault-report-recovered', {
            instance: instanceForLog(),
            endpoint,
            failedReports,
            downMs: now() - sinceMs,
            outputs,
            attempts,
        });
    }

    function scheduleHeartbeat(): void {
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
        if (stopped || !config) return;
        heartbeatTimer = setTimeout(() => void send('heartbeat'), options.heartbeatMs);
        heartbeatTimer.unref();
    }

    // Sends a report; never throws, and never starts a second one while one is on its way.
    async function send(reason: SendReason): Promise<void> {
        if (stopped || !config) return;
        // Nothing true to say before the first health poll; the poll itself triggers the first report.
        if (!snapshotSeen) {
            scheduleHeartbeat();
            return;
        }
        if (inFlight) {
            resendRequested = true;
            return;
        }
        const cfg = config;
        const cancel = AbortSignal.any([shutdownController.signal, settingsAbort.signal]);
        inFlight = true;
        lastAttemptAtMs = now();
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = null;
        try {
            let payload: KeyVaultPayload;
            try {
                payload = build();
                if (buildFailing) {
                    buildFailing = false;
                    diagnostics?.event('key-vault-report-build-recovered', {});
                }
            } catch (err) {
                reportBuildFailure(err);
                return;
            }
            // Whatever happens next, an unchanged status waits for the next heartbeat.
            lastSignature = payloadSignature(payload);
            try {
                const attempts = await post(cfg, JSON.stringify(payload), cancel);
                if (cancel.aborted) return;
                recordSuccess(payload.outputs.length, attempts);
            } catch (err) {
                // Shut down, or the settings changed: this report is of no interest any more.
                if (cancel.aborted) return;
                recordFailure(err, reason);
            }
        } catch (err) {
            // Nothing above should throw; this is the last guard before the control plane.
            reportBuildFailure(err);
        } finally {
            inFlight = false;
            scheduleHeartbeat();
            if (resendRequested) {
                resendRequested = false;
                requestChangeSend();
            }
        }
    }

    function reportBuildFailure(err: unknown): void {
        if (buildFailing) return;
        buildFailing = true;
        const error = errorText(err);
        console.error(`[key-vault] could not build the report (will retry): ${error}`);
        diagnostics?.event('key-vault-report-build-failed', { error });
    }

    // A change is sent at once unless a report went out less than minChangeIntervalMs
    // ago; then one is sent when that time is up.
    function requestChangeSend(): void {
        if (stopped || !config || changeTimer) return;
        const waitMs =
            lastAttemptAtMs === null
                ? 0
                : Math.max(0, lastAttemptAtMs + options.minChangeIntervalMs - now());
        if (waitMs === 0) {
            void send('change');
            return;
        }
        changeTimer = setTimeout(() => {
            changeTimer = null;
            void send('change');
        }, waitMs);
        changeTimer.unref();
    }

    function onSnapshot(): void {
        if (stopped) return;
        snapshotSeen = true;
        if (!config) return;
        try {
            if (inFlight) return;
            const signature = payloadSignature(build());
            if (signature !== lastSignature) requestChangeSend();
        } catch (err) {
            reportBuildFailure(err);
        }
    }

    function logStarted(): void {
        if (!config) return;
        const instance = instanceForLog();
        console.log(`[key-vault] reporting to ${endpoint} as "${instance}"`);
        diagnostics?.event('key-vault-reporter-started', {
            instance,
            endpoint,
            heartbeatMs: options.heartbeatMs,
            minChangeIntervalMs: options.minChangeIntervalMs,
            timeoutMs: options.timeoutMs,
            retryDelaysMs: options.retryDelaysMs,
        });
    }

    // Registered whether or not Key Vault is set up, so that setting it up in Settings
    // needs no restart; while it is off a poll costs one check.
    function start(): void {
        if (started) return;
        started = true;
        loadConfig();
        logStarted();
        health.onSnapshot(onSnapshot);
        scheduleHeartbeat();
    }

    // Applies the settings as they are now. Called after the operator saves them.
    function reconfigure(): void {
        if (!started || stopped) return;
        const before = settingsKey(config);
        loadConfig();
        if (settingsKey(config) === before) return;

        // Everything that belonged to the old settings goes: the report on its way, the
        // waiting timers, the hashes (they are keyed by the old secret), the failure episode.
        settingsAbort.abort();
        settingsAbort = new AbortController();
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        if (changeTimer) clearTimeout(changeTimer);
        heartbeatTimer = null;
        changeTimer = null;
        hashCache.clear();
        lastSignature = null;
        lastAttemptAtMs = null;
        lastSuccessAtMs = null;
        episode = null;
        diagnostics?.event('key-vault-settings-changed', {
            enabled: config !== null,
            instance: config ? instanceForLog() : null,
            endpoint,
        });
        if (!config) {
            console.log('[key-vault] reporting is off');
            return;
        }
        logStarted();
        scheduleHeartbeat();
        // The report on its way ends in finally, which then sends the new one at once.
        if (inFlight) resendRequested = true;
        else requestChangeSend();
    }

    function shutdown(): void {
        stopped = true;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        if (changeTimer) clearTimeout(changeTimer);
        heartbeatTimer = null;
        changeTimer = null;
        shutdownController.abort();
    }

    return {
        start,
        reconfigure,
        shutdown,
        getState: (): KeyVaultReporterState => ({
            enabled: config !== null,
            lastAttemptAtMs,
            lastSuccessAtMs,
            consecutiveFailures: episode?.failedReports ?? 0,
        }),
    };
}

export type KeyVaultReporter = ReturnType<typeof createKeyVaultReporter>;
