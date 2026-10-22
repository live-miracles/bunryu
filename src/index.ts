import './utils/startupGate.js';

import crypto from 'crypto';
import express from 'express';
import compression from 'compression';
import path from 'path';
import { createDb } from './db/index.js';
import { DatabaseSchemaError } from './db/schema.js';
import type { Db } from './types.js';
import { createOutputService } from './services/outputs.js';
import { createSrtRelayService } from './services/srtRelay.js';
import { createHealthService } from './services/health.js';
import { registerPipelineApi } from './api/pipelines.js';
import { registerOutputApi } from './api/outputs.js';
import { registerConfigApi } from './api/config.js';
import { registerMetricsApi, getProcessUsage } from './api/metrics.js';
import { registerSettingsApi } from './api/settings.js';
import { createPreviewService } from './services/preview.js';
import { registerPreviewApi, registerHlsRoute } from './api/preview.js';
import { registerRejectedPublishesApi, registerSrsHooks, registerSrsLogsApi } from './api/srs.js';
import { createInputState } from './services/inputState.js';
import { createRejectedPublishes } from './services/rejectedPublishes.js';
import {
    registerAuthApi,
    requireAuth,
    initializePassword,
    MissingInitialPasswordError,
    checkIsAuthenticated,
} from './api/auth.js';
import { registerVersionApi, readAppVersion } from './api/version.js';
import { readAppConfig } from './utils/appConfig.js';
import { EXIT_NEEDS_OPERATOR } from './utils/configCheck.js';
import { createDiagnosticsLogger, runLogged } from './utils/diagnostics.js';
import { checkFfmpeg } from './utils/ffmpegCheck.js';
import { jsonErrorHandler } from './api/errors.js';
import { createTranslationMixerService } from './services/translationMixer.js';
import { createRenditionReconciler } from './services/renditions.js';
import { enforceDestinationPolicy } from './services/destinationPolicy.js';
import { readSrsConfigValues } from './utils/srsConfig.js';

const app = express();
const PORT = readAppConfig().port;
const HOOK_PORT = readAppConfig().hookPort;
app.disable('x-powered-by');
if (readAppConfig().trustProxy > 0) app.set('trust proxy', readAppConfig().trustProxy);
// Baseline hardening headers. A full CSP is not possible yet (the dashboard
// still uses inline event handlers); framing and sniffing are closed off.
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

// gzip responses. The /api/config and /api/health JSON for dozens of inputs and
// hundreds of outputs is large and re-fetched by every dashboard client on the 5s poll;
// JSON compresses very well, so this cuts response size and bandwidth sharply.
app.use(
    compression({
        // HLS playlists/segments are latency-sensitive live media; letting a
        // proxy/browser transform or buffer them like normal text/static assets
        // increases the odds of stale manifest reuse and live-edge stalls.
        filter(req, res) {
            if (req.path.startsWith('/hls/')) return false;
            return compression.filter(req, res);
        },
    }),
);
// Room for a bulk create of hundreds of outputs with long destination URLs.
app.use(express.json({ limit: '1mb' }));

function openDatabase(): Db {
    try {
        return createDb(undefined, readAppConfig().streamKeyCount);
    } catch (err) {
        if (err instanceof DatabaseSchemaError) {
            console.error(`[server] ${err.message}`);
            process.exit(EXIT_NEEDS_OPERATOR);
        }
        throw err;
    }
}

const db = openDatabase();
const diagnostics = createDiagnosticsLogger(
    path.join(path.dirname(readAppConfig().databasePath), 'diagnostics'),
);
// Random per process start, so restarts are unambiguous in the diagnostics
// trail even when the clock or pid repeats.
const instanceId = crypto.randomBytes(4).toString('hex');
const startedAtMs = Date.now();
diagnostics.event('server-started', {
    instanceId,
    version: readAppVersion(),
    pid: process.pid,
    node: process.version,
});

// One misbehaving timer, request or callback must not take every output down
// with the process: record the error and keep serving. Startup failures still
// exit through main().catch below.
process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled promise rejection (process kept running):', reason);
    diagnostics.event('unhandled-rejection', { error: errorText(reason) });
});
process.on('uncaughtException', (err) => {
    console.error('[server] uncaught exception (process kept running):', err);
    diagnostics.event('uncaught-exception', { error: errorText(err) });
});

function errorText(err: unknown): string {
    return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

const inputState = createInputState();
const rejectedPublishes = createRejectedPublishes();
const outputService = createOutputService(db, inputState, diagnostics);
const srtRelayService = createSrtRelayService(diagnostics);
const previewService = createPreviewService(db, inputState);
const translationMixerService = createTranslationMixerService(
    db,
    inputState,
    outputService,
    diagnostics,
);
const renditionReconciler = createRenditionReconciler(db, outputService, diagnostics);
const healthService = createHealthService(
    db,
    outputService,
    srtRelayService,
    inputState,
    diagnostics,
    translationMixerService,
    getProcessUsage,
);

// SRS hooks are unauthenticated and trusted, so they live on their own
// loopback-only listener (see main()) — never on the public dashboard port.
const hookApp = express();
hookApp.disable('x-powered-by');
hookApp.use(express.json());
registerSrsHooks(hookApp, db, inputState, rejectedPublishes, diagnostics);
hookApp.use(jsonErrorHandler);

// Readiness only: the installer's SRS unit waits on this before starting.
app.get('/api/ready', (_req, res) => {
    res.json({ ok: true });
});

// Unauthenticated routes
registerAuthApi(app, db);

// Auth middleware for all remaining /api/* routes
app.use('/api', requireAuth);

registerConfigApi(app, db);
registerPipelineApi(app, db, outputService, previewService, srtRelayService);
registerOutputApi(app, db, outputService, healthService);
registerPreviewApi(app, previewService);
registerSettingsApi(app, db);
registerVersionApi(app);
registerMetricsApi(app, srtRelayService);
healthService.registerRoutes(app);
registerSrsLogsApi(app, healthService.getSrsEvents);
registerRejectedPublishesApi(app, rejectedPublishes);

registerHlsRoute(app, previewService);

const publicDir = path.join(__dirname, '..', 'public');

const serveIndexOrRedirect = (req: express.Request, res: express.Response): void => {
    if (checkIsAuthenticated(req)) {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(publicDir, 'index.html'));
    } else {
        res.redirect('/login');
    }
};

app.get('/', serveIndexOrRedirect);
app.get('/index.html', serveIndexOrRedirect);

app.get('/login', (req, res) => {
    if (checkIsAuthenticated(req)) {
        res.redirect('/');
    } else {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(publicDir, 'login.html'));
    }
});

app.use(
    '/',
    express.static(publicDir, {
        setHeaders(res, filePath) {
            if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
                // These bundles are generated outside git and can change while
                // the release version stays the same. Do not let a browser or
                // reverse proxy keep an old module graph after deployment.
                res.setHeader(
                    'Cache-Control',
                    'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0',
                );
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                res.setHeader('Surrogate-Control', 'no-store');
            }
        },
    }),
);

app.use(jsonErrorHandler);

// The repo ships a public default passphrase for dev, and an empty one disables
// the SRT handshake check. Neither is acceptable on a production host; say so
// loudly (visible in journald) rather than refuse to start a live-event server.
function warnOnWeakSrtPassphrase(): void {
    if (process.env.NODE_ENV !== 'production') return;
    try {
        const passphrase = readSrsConfigValues().srtPassphrase;
        if (!passphrase || passphrase === 'bunryu-default-srt-passphrase') {
            console.warn(
                `[security] SRT passphrase in srs.conf is ${passphrase ? 'the public default' : 'empty'}: anyone can publish SRT to this server if they guess a stream key`,
            );
            diagnostics.event('weak-srt-passphrase', { empty: !passphrase });
        }
    } catch (error) {
        console.warn('[security] could not check the SRT passphrase:', error);
    }
}

// A missing or incomplete ffmpeg build otherwise shows up only as every output
// failing; say so once at startup. Not fatal: ingest and the dashboard still work.
async function reportFfmpegCheck(): Promise<void> {
    const { ffmpegPath, ffprobePath } = readAppConfig();
    const result = await checkFfmpeg(ffmpegPath, ffprobePath);
    diagnostics.event('ffmpeg-check', { ffmpegPath, ffprobePath, ...result });
    if (result.ok) {
        console.log(
            `[ffmpeg] ${ffmpegPath} ${result.version ?? '(unknown version)'} has every needed feature`,
        );
    } else if (result.error) {
        console.error(`[ffmpeg] ${result.error}; outputs, previews and probes will fail`);
    } else {
        console.error(
            `[ffmpeg] ${ffmpegPath} ${result.version ?? ''} is missing: ${result.missing.join(', ')}; outputs that need them will fail`,
        );
    }
}

async function main(): Promise<void> {
    // Must finish before listen(): seeds the initial password hash (only if the
    // database has none) and loads persisted sessions, which the auth middleware
    // consults on every request.
    await initializePassword(db, readAppConfig().dashboardPassword);

    void enforceDestinationPolicy(db, outputService, diagnostics);
    warnOnWeakSrtPassphrase();
    void reportFfmpegCheck();
    srtRelayService.start();
    translationMixerService.start();
    renditionReconciler.start();
    healthService.start();

    // Hooks first: /api/ready (what SRS waits for) must not answer before the
    // hook listener can. A hook-port failure is fatal on purpose — without it SRS
    // would reject every publish.
    await new Promise<void>((resolve, reject) => {
        const server = hookApp.listen(HOOK_PORT, '127.0.0.1', () => {
            console.log(`[server] SRS hooks listening on http://127.0.0.1:${HOOK_PORT}`);
            resolve();
        });
        server.once('error', reject);
    });
    // Express 5 hands a listen error (EADDRINUSE) only to this callback; ignoring
    // it would leave the process up with no dashboard, which systemd never
    // restarts. Exit instead, like a hook-port failure.
    await new Promise<void>((resolve, reject) => {
        app.listen(PORT, (err?: Error) => {
            if (err) {
                reject(err);
                return;
            }
            console.log(`[server] listening on http://0.0.0.0:${PORT}`);
            resolve();
        });
    });
}

const DIAGNOSTICS_FLUSH_TIMEOUT_MS = 2000;

let shuttingDown = false;
function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, killing media jobs`);
    // A throwing step must not leave the others (and the exit) undone: the
    // uncaughtException handler would keep the process alive, ignoring a second signal.
    const step = <T>(name: string, fn: () => T): T | undefined =>
        runLogged(`shutdown-${name}`, fn, diagnostics);
    step('renditions', () => renditionReconciler.shutdown());
    const killedOutputIds = step('outputs', () => outputService.shutdown()) ?? [];
    step('translation', () => translationMixerService.shutdown());
    step('health', () => healthService.shutdown());
    step('relay', () => srtRelayService.shutdown());
    step('preview', () => previewService.shutdown());
    // The killed outputs' exit handlers never run before process.exit, so this
    // one record stands in for their ffmpeg-exited events.
    diagnostics.event('server-shutdown', {
        instanceId,
        signal,
        uptimeSec: Math.round((Date.now() - startedAtMs) / 1000),
        killedOutputIds,
    });
    flushDiagnosticsAndExit(0);
}

function flushDiagnosticsAndExit(code: number): void {
    const timeout = new Promise((resolve) => setTimeout(resolve, DIAGNOSTICS_FLUSH_TIMEOUT_MS));
    void Promise.race([diagnostics.close(), timeout]).then(() => process.exit(code));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
    // No password to seed the database with: only an operator can fix that, so
    // exit 78 and stay down (see EXIT_NEEDS_OPERATOR) instead of restarting.
    const needsOperator = err instanceof MissingInitialPasswordError;
    if (needsOperator) console.error(`[server] ${err.message}`);
    else console.error('Fatal startup error:', err);
    diagnostics.event('server-start-failed', { instanceId, error: errorText(err) });
    flushDiagnosticsAndExit(needsOperator ? EXIT_NEEDS_OPERATOR : 1);
});
