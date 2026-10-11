import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { context as zmqContext, Request } from 'zeromq';

// Without this, ZeroMQ's default context blocks the whole process at exit
// forever trying to deliver any still-queued message on a socket that has no
// peer (e.g. a control socket for a translator whose ffmpeg-side azmq server
// never came up or already died) — even after that socket has been closed.
// This gives every new socket a zero linger instead, so shutdown can't hang.
zmqContext.blocky = false;
import { buildTranslationMixerArgs, volumePercentToAmplitude } from '../utils/ffmpeg.js';
import { readAppConfig, outputMemoryLimitBytes } from '../utils/appConfig.js';
import { readProcRssBytes, createProcCpuTracker } from '../utils/procStats.js';
import type { Db, Output, TranslationConfig } from '../types.js';
import type { InputProtocol, InputState } from './inputState.js';
import type { OutputService } from './outputs.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';

const RECONCILE_INTERVAL_MS = 1000;
const SIGKILL_DELAY_MS = 5000;
// Same cadence as the output watchdog's own RSS/CPU sampling (its default
// intervalMs); reconcile ticks every second, so each job is sampled every 5th tick.
const USAGE_SAMPLE_INTERVAL_MS = 5000;
const STDERR_TAIL_BYTES = 3000;
const MIXER_CONTROL_PORT_BASE = 31000;
const MIXER_CONTROL_PORT_RANGE = 20000;
const MODE_SWITCH_DOWN_GRACE_MS = 12000;
const MODE_SWITCH_UP_GRACE_MS = 3000;
// Bounds how long ffmpeg blocks reading the translator leg when SRS holds
// that pull open with no payload (its publisher went away) but doesn't close
// the connection. Without this, that read can hang indefinitely — verified
// against production (ffmpeg 7.1 / SRS 6.0): the whole mixer process stalls,
// not just the translator leg, and the only recovery is the coarse
// output-progress-stalled watchdog (tens of seconds later). A short bound
// here lets ffmpeg's own graph (amix duration=longest) drop the translator
// leg and keep the source flowing, the way it was designed to. Deliberately
// much shorter than the source's own pull timeout — a translator glitch
// should recover in a few seconds, not linger for minutes.
const TRANSLATOR_PULL_TIMEOUT_US = 5 * 1_000_000;
const METER_VOICE_PATTERN = /lavfi\.astats\.Overall\.Peak_level=(-?\d+(?:\.\d+)?|-inf)/;
// astats reports true digital silence as -inf, which JSON.stringify turns
// into null (JSON has no Infinity) — indistinguishable, over the API, from
// "no meter sample has arrived yet". Floor it to a finite sentinel instead,
// so the health snapshot/UI can tell "genuinely silent" from "never sampled".
// Matches the voiceThresholdDb input's own floor (see api/outputs.ts).
const METER_SILENCE_FLOOR_DB = -100;
const appConfig = readAppConfig();

interface MixerJob {
    process: ChildProcess;
    mode: 'source-only' | 'translated';
    fingerprint: string;
    configFingerprint: string;
    translatorLive: boolean;
    translatorProtocol: 'srt' | 'rtmp' | null;
    stderrTail: string;
    controller: MixerStateController;
    controlPort: number | null;
    startedAtMs: number;
    lastOutputProgressAtMs: number;
    lastUsageSampleAtMs: number;
    lastRssBytes: number | null;
    lastOutTimeUs: number | null;
    lastTotalSizeBytes: number | null;
    lastBitrateKbps: number | null;
    lastTranslatorMeterAtMs: number;
    lastTranslatorMeterDb: number | null;
}

interface MixerStateSnapshot {
    state: DuckState;
    sourceVolumePercent: number;
}

interface MixerStateController {
    onMeterPeakDb(db: number): void;
    onTranslatorUnavailable(): void;
    getSnapshot(): MixerStateSnapshot;
    close(): void;
}

// Live duck/source-volume state for one translation output, surfaced through
// health.ts so the dashboard can show what the mixer is actually doing right
// now instead of only finding out after the fact from logs.
export interface TranslationOutputState {
    mode: 'source-only' | 'translated';
    duckState: DuckState;
    sourceVolumePercent: number;
    lastTranslatorMeterDb: number | null;
}

export interface TranslationMixerService {
    start(): void;
    getState(outputId: string): TranslationOutputState | null;
    shutdown(): void;
}

function mb(bytes: number | null): number | null {
    return bytes == null ? null : Math.round(bytes / (1024 * 1024));
}

function appendTail(existing: string, chunk: Buffer): string {
    const next = existing + chunk.toString('utf8');
    return next.length > STDERR_TAIL_BYTES ? next.slice(-STDERR_TAIL_BYTES) : next;
}

// Mirrors outputs.ts's own parseBitrateKbps — same '-progress pipe:1' line format.
function parseBitrateKbps(line: string): number | null {
    const val = line.slice('bitrate='.length).trim();
    if (val === 'N/A' || val === '0.0kbits/s') return null;
    const match = val.match(/^([\d.]+)kbits\/s$/);
    return match ? parseFloat(match[1]) : null;
}

export type DuckState = 'resting' | 'ducked';

export interface DuckTracker {
    state: DuckState;
    hasDetectedVoice: boolean;
    lastVoiceAt: number;
}

export interface DuckMixConfig {
    voiceThresholdDb: number;
    duckVolumePercent: number;
    duckDurationMs: number;
    restoreSilenceMs: number;
    restoreVolumePercent: number;
    restoreDurationMs: number;
}

export interface DuckDecision {
    tracker: DuckTracker;
    // Present only on the sample that should kick off a new ramp — repeat
    // samples in the same state (e.g. continued speech, or silence still
    // inside the hold window) return null so the caller doesn't restart an
    // already-running ramp/timer for no reason.
    ramp: { targetPercent: number; durationMs: number } | null;
}

// One meter sample in, one decision out — no timers, no I/O. Speech detected
// at any point (even mid-restore) immediately wins over a pending or
// in-progress restore, so a translator that resumes speaking while the
// source is still climbing back up gets ducked again from wherever the gain
// currently sits, instead of finishing the climb first.
export function nextDuckDecision(
    tracker: DuckTracker | undefined,
    db: number,
    now: number,
    mix: DuckMixConfig,
): DuckDecision {
    const next = tracker
        ? { ...tracker }
        : { state: 'resting' as const, hasDetectedVoice: false, lastVoiceAt: 0 };
    const speaking = Number.isFinite(db) && db >= mix.voiceThresholdDb;
    if (speaking) {
        next.hasDetectedVoice = true;
        next.lastVoiceAt = now;
        if (next.state !== 'ducked') {
            next.state = 'ducked';
            return {
                tracker: next,
                ramp: { targetPercent: mix.duckVolumePercent, durationMs: mix.duckDurationMs },
            };
        }
        return { tracker: next, ramp: null };
    }
    if (!next.hasDetectedVoice) return { tracker: next, ramp: null };
    const silenceMs = now - next.lastVoiceAt;
    if (next.state === 'ducked' && silenceMs >= mix.restoreSilenceMs) {
        next.state = 'resting';
        return {
            tracker: next,
            ramp: { targetPercent: mix.restoreVolumePercent, durationMs: mix.restoreDurationMs },
        };
    }
    return { tracker: next, ramp: null };
}

function createMixerStateController(
    mix: TranslationConfig,
    socket: Request,
    outputId: string,
    diagnostics?: DiagnosticsLogger,
): MixerStateController {
    let currentGain = volumePercentToAmplitude(mix.restoreVolumePercent);
    let tracker: DuckTracker = { state: 'resting', hasDetectedVoice: false, lastVoiceAt: 0 };
    let rampTimer: NodeJS.Timeout | null = null;
    let commandChain = Promise.resolve();
    let closed = false;

    function sendGain(gain: number): void {
        if (closed) return;
        const bounded = Math.max(0, Math.min(1, gain));
        commandChain = commandChain
            .then(async () => {
                await socket.send(`volume@source_gain volume ${bounded}`);
                await socket.receive();
            })
            .catch(() => {});
    }

    function rampTo(target: number, durationMs: number): void {
        if (rampTimer) clearInterval(rampTimer);
        const start = currentGain;
        const boundedTarget = Math.max(0, Math.min(1, target));
        const duration = Math.max(0, durationMs);
        if (duration === 0) {
            currentGain = boundedTarget;
            sendGain(currentGain);
            return;
        }
        const startedAt = Date.now();
        rampTimer = setInterval(() => {
            const progress = Math.min(1, (Date.now() - startedAt) / duration);
            currentGain = start + (boundedTarget - start) * progress;
            sendGain(currentGain);
            if (progress >= 1 && rampTimer) {
                clearInterval(rampTimer);
                rampTimer = null;
            }
        }, 50);
        rampTimer.unref?.();
    }

    function onMeterPeakDb(db: number): void {
        const decision = nextDuckDecision(tracker, db, Date.now(), mix);
        tracker = decision.tracker;
        if (decision.ramp) {
            // Live state is queryable via getSnapshot()/getState() for the UI —
            // this is just the structured, non-spammy breadcrumb trail for
            // after-the-fact incident review (rotated diagnostics files, not
            // stdout/journalctl).
            diagnostics?.event('translation-mixer-duck-transition', {
                outputId,
                state: decision.tracker.state,
                meterDb: db,
                targetPercent: decision.ramp.targetPercent,
                rampMs: decision.ramp.durationMs,
            });
            rampTo(volumePercentToAmplitude(decision.ramp.targetPercent), decision.ramp.durationMs);
        }
    }

    sendGain(currentGain);
    return {
        onMeterPeakDb,
        onTranslatorUnavailable: () => {
            diagnostics?.event('translation-mixer-duck-transition', {
                outputId,
                state: 'resting',
                reason: 'translator unavailable',
            });
            tracker = { state: 'resting', hasDetectedVoice: false, lastVoiceAt: 0 };
            rampTo(volumePercentToAmplitude(mix.restoreVolumePercent), mix.restoreDurationMs);
        },
        getSnapshot: () => ({
            state: tracker.state,
            sourceVolumePercent: Math.round(currentGain * 100),
        }),
        close: () => {
            closed = true;
            if (rampTimer) clearInterval(rampTimer);
        },
    };
}

export interface ModeTracker {
    candidateLive: boolean;
    since: number;
    effectiveLive: boolean;
}

export function nextDebouncedMode(
    tracker: ModeTracker | undefined,
    rawLive: boolean,
    now: number,
): { tracker: ModeTracker; mode: 'source-only' | 'translated' } {
    const next = tracker ?? { candidateLive: rawLive, since: now, effectiveLive: rawLive };
    if (rawLive !== next.candidateLive) {
        next.candidateLive = rawLive;
        next.since = now;
    }
    const graceMs = next.candidateLive ? MODE_SWITCH_UP_GRACE_MS : MODE_SWITCH_DOWN_GRACE_MS;
    if (next.candidateLive !== next.effectiveLive && now - next.since >= graceMs) {
        next.effectiveLive = next.candidateLive;
    }
    return { tracker: next, mode: next.effectiveLive ? 'translated' : 'source-only' };
}

export function isTranslatorMeterStale(
    lastTranslatorMeterAtMs: number,
    now: number,
    staleMs: number,
): boolean {
    return now - lastTranslatorMeterAtMs > staleMs;
}

// `lastTranslatorMeterAtMs` is initialized to the job's start time and only
// ever moves forward from real meter samples, so a translator that never
// produces a single sample is still caught once `warmupMs` passes — it isn't
// invisible forever, and a job that's merely still warming up (one early
// sample, then normal startup jitter) isn't flagged before `warmupMs` either.
export function shouldRestartForStaleTranslatorMeter(
    job: {
        mode: 'source-only' | 'translated';
        translatorLive: boolean;
        startedAtMs: number;
        lastTranslatorMeterAtMs: number;
    },
    now: number,
    warmupMs: number,
    staleMs: number,
): boolean {
    return (
        job.mode === 'translated' &&
        job.translatorLive &&
        now - job.startedAtMs >= warmupMs &&
        isTranslatorMeterStale(job.lastTranslatorMeterAtMs, now, staleMs)
    );
}

export function selectControlPort(outputId: string, usedPorts: ReadonlySet<number>): number {
    const hash = [...outputId].reduce(
        (value, char) => (value * 31 + char.charCodeAt(0)) % MIXER_CONTROL_PORT_RANGE,
        0,
    );
    for (let offset = 0; offset < MIXER_CONTROL_PORT_RANGE; offset++) {
        const port = MIXER_CONTROL_PORT_BASE + ((hash + offset) % MIXER_CONTROL_PORT_RANGE);
        if (!usedPorts.has(port)) return port;
    }
    return MIXER_CONTROL_PORT_BASE + hash;
}

function terminateProcess(process: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            resolve();
        };
        const killTimer = setTimeout(() => {
            try {
                if (!process.kill('SIGKILL')) finish();
            } catch {
                finish();
            }
        }, SIGKILL_DELAY_MS);
        killTimer.unref?.();
        process.once('exit', finish);
        try {
            if (!process.kill('SIGTERM')) finish();
        } catch {
            finish();
        }
    });
}

export function createTranslationMixerService(
    db: Db,
    inputState: InputState,
    outputService: OutputService,
    diagnostics?: DiagnosticsLogger,
): TranslationMixerService {
    const jobs = new Map<string, MixerJob>();
    const modeTrackers = new Map<string, ModeTracker>();
    const stopRequested = new Set<string>();
    const usedControlPorts = new Set<number>();
    const cpuTracker = createProcCpuTracker();
    let reconciling = false;
    let shuttingDown = false;

    const timer = setInterval(() => {
        void reconcile();
    }, RECONCILE_INTERVAL_MS);
    timer.unref?.();

    function allocateControlPort(outputId: string): number {
        const port = selectControlPort(outputId, usedControlPorts);
        usedControlPorts.add(port);
        return port;
    }

    async function stopJob(outputId: string, requestedStop = true): Promise<void> {
        const job = jobs.get(outputId);
        if (!job) return;
        jobs.delete(outputId);
        if (requestedStop) stopRequested.add(outputId);
        job.controller.close();
        await terminateProcess(job.process);
    }

    async function restartWatchdogJob(
        output: Output,
        job: MixerJob,
        opts: {
            headline: string;
            reason: string;
            contextLine: string;
            extra?: Record<string, unknown>;
        },
    ): Promise<void> {
        const message = [
            opts.headline,
            `pid=${job.process.pid ?? 'unknown'}`,
            opts.contextLine,
            job.stderrTail.trim()
                ? `ffmpeg stderr tail:\n${job.stderrTail.trim()}`
                : 'ffmpeg stderr tail: <empty>',
        ].join('\n');
        try {
            db.setOutputLastError(output.id, message, 'crash');
        } catch (error) {
            diagnostics?.event('translation-mixer-watchdog-log-error', {
                outputId: output.id,
                pipelineId: output.pipelineId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
        diagnostics?.event('translation-mixer-restart', {
            outputId: output.id,
            pipelineId: output.pipelineId,
            reason: opts.reason,
            pid: job.process.pid ?? null,
            rssMb: mb(job.lastRssBytes),
            ...opts.extra,
        });
        await stopJob(output.id, false);
    }

    function configFingerprint(output: Output, mix: TranslationConfig): string {
        return JSON.stringify({
            translatorStreamKey: mix.translatorStreamKey,
            sourceTrackIndex: mix.sourceTrackIndex,
            translatorTrackIndex: mix.translatorTrackIndex,
            sourceProtocol: inputState.getProtocol(output.pipelineId),
            delay: mix.translationDelayMs,
            thresholdDb: mix.voiceThresholdDb,
            duckVolume: mix.duckVolumePercent,
            duckDuration: mix.duckDurationMs,
            restoreSilence: mix.restoreSilenceMs,
            restoreVolume: mix.restoreVolumePercent,
            restoreDuration: mix.restoreDurationMs,
            outputUrl: output.url,
            videoEncoding: output.videoEncoding,
        });
    }

    function jobFingerprint(
        output: Output,
        mix: TranslationConfig,
        mode: 'source-only' | 'translated',
        translatorProtocol: InputProtocol | null,
    ): string {
        return JSON.stringify({
            config: configFingerprint(output, mix),
            mode,
            translatorProtocol: mode === 'translated' ? translatorProtocol : null,
        });
    }

    async function startJob(
        mix: TranslationConfig,
        output: Output,
        mode: 'source-only' | 'translated',
        fingerprint: string,
        configFp: string,
    ): Promise<void> {
        const source = db.getPipeline(output.pipelineId);
        const translator = db.getPipelineByStreamKey(mix.translatorStreamKey);
        if (!source) return;
        const sourceUrl = inputState.pullUrl(source.id, source.streamKey);
        const translatorProtocol = translator ? inputState.getProtocol(translator.id) : null;
        const translatorUrl =
            mode === 'translated' && translator
                ? inputState.pullUrl(
                      translator.id,
                      translator.streamKey,
                      TRANSLATOR_PULL_TIMEOUT_US,
                  )
                : null;
        const controlPort = mode === 'translated' ? allocateControlPort(output.id) : null;
        const args = buildTranslationMixerArgs(sourceUrl, translatorUrl, output.url, {
            ...mix,
            videoEncoding: output.videoEncoding,
            controlPort: controlPort ?? MIXER_CONTROL_PORT_BASE,
        });
        let child: ChildProcess;
        const control = controlPort === null ? null : new Request();
        try {
            child = spawn(appConfig.ffmpegPath, args, {
                stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
                env: process.env,
            });
            control?.connect(`tcp://127.0.0.1:${controlPort}`);
        } catch (error) {
            try {
                control?.close();
            } catch {
                /* already closed */
            }
            if (controlPort !== null) usedControlPorts.delete(controlPort);
            throw error;
        }
        const controller =
            control === null
                ? {
                      // Source-only mode has no gain filter at all (nothing to
                      // duck against), so the source always plays at full volume.
                      onMeterPeakDb: () => {},
                      onTranslatorUnavailable: () => {},
                      getSnapshot: () => ({
                          state: 'resting' as const,
                          sourceVolumePercent: 100,
                      }),
                      close: () => {},
                  }
                : createMixerStateController(mix, control, output.id, diagnostics);
        const job: MixerJob = {
            process: child,
            mode,
            fingerprint,
            configFingerprint: configFp,
            translatorLive: translator ? inputState.isLive(translator.id) : false,
            translatorProtocol,
            stderrTail: '',
            controller,
            controlPort,
            startedAtMs: Date.now(),
            lastOutputProgressAtMs: Date.now(),
            lastUsageSampleAtMs: 0,
            lastRssBytes: null,
            lastOutTimeUs: null,
            lastTotalSizeBytes: null,
            lastBitrateKbps: null,
            lastTranslatorMeterAtMs: Date.now(),
            lastTranslatorMeterDb: null,
        };
        jobs.set(output.id, job);
        stopRequested.delete(output.id);
        outputService.reportExternalStatus(output.id, 'running', child.pid ?? null);
        diagnostics?.event('translation-mixer-started', {
            outputId: output.id,
            pid: child.pid ?? null,
            mode,
            sourcePipelineId: output.pipelineId,
            translatorPipelineId: translator?.id ?? null,
            outputUrl: output.url,
        });

        let progressBuffer = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            progressBuffer += chunk.toString();
            const lines = progressBuffer.split(/\r?\n/);
            progressBuffer = lines.pop() ?? '';
            let progressed = false;
            for (const line of lines) {
                if (line.startsWith('total_size=')) {
                    const value = Number(line.slice('total_size='.length));
                    if (
                        Number.isFinite(value) &&
                        (job.lastTotalSizeBytes === null || value > job.lastTotalSizeBytes)
                    ) {
                        job.lastTotalSizeBytes = value;
                        job.lastOutputProgressAtMs = Date.now();
                        progressed = true;
                    }
                } else if (line.startsWith('out_time_ms=')) {
                    const value = Number(line.slice('out_time_ms='.length));
                    if (
                        Number.isFinite(value) &&
                        (job.lastOutTimeUs === null || value > job.lastOutTimeUs)
                    ) {
                        job.lastOutTimeUs = value;
                        job.lastOutputProgressAtMs = Date.now();
                        progressed = true;
                    }
                } else if (line.startsWith('bitrate=')) {
                    job.lastBitrateKbps = parseBitrateKbps(line);
                    progressed = true;
                }
            }
            if (progressed) {
                outputService.reportExternalProgress(output.id, {
                    bitrateKbps: job.lastBitrateKbps,
                    lastOutTimeUs: job.lastOutTimeUs,
                    lastTotalSizeBytes: job.lastTotalSizeBytes,
                });
            }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            const current = jobs.get(output.id);
            if (current?.process === child)
                current.stderrTail = appendTail(current.stderrTail, chunk);
        });
        child.stdio?.[3]?.on('data', (chunk: Buffer) => {
            for (const line of chunk.toString('utf8').split(/\r?\n/)) {
                const match = line.match(METER_VOICE_PATTERN);
                if (match) {
                    const db = match[1] === '-inf' ? -Infinity : Number(match[1]);
                    const current = jobs.get(output.id);
                    if (current?.process === child && current.mode === 'translated') {
                        current.lastTranslatorMeterAtMs = Date.now();
                        current.lastTranslatorMeterDb = Number.isFinite(db)
                            ? db
                            : METER_SILENCE_FLOOR_DB;
                    }
                    controller.onMeterPeakDb(db);
                }
            }
        });
        child.once('error', (error) => {
            diagnostics?.event('translation-mixer-error', {
                outputId: output.id,
                message: error.message,
            });
        });
        child.once('exit', (code, signal) => {
            controller.close();
            cpuTracker.delete(output.id);
            void control?.close();
            if (controlPort !== null) usedControlPorts.delete(controlPort);
            const wasStop = stopRequested.delete(output.id);
            const current = jobs.get(output.id);
            if (current?.process === child) {
                jobs.delete(output.id);
                const message =
                    current.stderrTail.trim() || `FFmpeg exited code=${code} signal=${signal}`;
                diagnostics?.event('translation-mixer-exited', {
                    outputId: output.id,
                    pid: child.pid ?? null,
                    code,
                    signal,
                    message,
                    requestedStop: wasStop,
                    lastRssMb: mb(current.lastRssBytes),
                    uptimeSec: Math.round((Date.now() - current.startedAtMs) / 1000),
                });
                if (!shuttingDown) {
                    try {
                        db.setOutputLastError(
                            output.id,
                            wasStop ? current.stderrTail.trim() : message,
                            wasStop ? 'stopped' : 'crash',
                        );
                    } catch {
                        /* non-critical */
                    }
                }
            }
            if (!jobs.has(output.id) || jobs.get(output.id)?.process === child) {
                outputService.reportExternalStatus(output.id, wasStop ? 'stopped' : 'failed', null);
            }
        });
    }

    // Samples the mixer ffmpeg's RSS/CPU for getStats()/health and restarts it if
    // it crosses the same per-encoding memory limit copy/transcode outputs get
    // (the 2026-07-10 swresample blow-up applies to any ffmpeg fed a corrupt
    // input). Returns true when it restarted the job.
    async function checkMixerUsage(output: Output, job: MixerJob, now: number): Promise<boolean> {
        if (now - job.lastUsageSampleAtMs < USAGE_SAMPLE_INTERVAL_MS) return false;
        job.lastUsageSampleAtMs = now;
        const pid = job.process.pid;
        const rssBytes = pid == null ? null : readProcRssBytes(pid);
        const limitBytes = outputMemoryLimitBytes(
            appConfig.outputWatchdog,
            output.videoEncoding,
            inputState.isHighRes(output.pipelineId),
        );
        job.lastRssBytes = rssBytes;
        outputService.reportExternalUsage(output.id, {
            rssBytes,
            limitBytes,
            cpuPercent: pid == null ? null : cpuTracker.sample(output.id, pid),
        });
        if (
            rssBytes == null ||
            rssBytes < limitBytes ||
            now - job.startedAtMs < appConfig.outputWatchdog.warmupMs
        )
            return false;
        await restartWatchdogJob(output, job, {
            headline: 'watchdog: translation mixer memory limit exceeded; restarting process',
            reason: 'memory limit exceeded',
            contextLine: `rss=${mb(rssBytes)}MB limit=${mb(limitBytes)}MB`,
            extra: { limitMb: mb(limitBytes) },
        });
        return true;
    }

    async function checkMixerWatchdogs(): Promise<void> {
        const now = Date.now();
        const { warmupMs, stallMs, translatorMeterStaleMs } = appConfig.outputWatchdog;
        for (const [outputId, job] of jobs) {
            const output = db.getOutput(outputId);
            if (!output || output.desiredState !== 'running') continue;
            if (await checkMixerUsage(output, job, now)) continue;
            if (!inputState.isLive(output.pipelineId)) continue;

            if (shouldRestartForStaleTranslatorMeter(job, now, warmupMs, translatorMeterStaleMs)) {
                const staleSeconds = Math.round((now - job.lastTranslatorMeterAtMs) / 1000);
                await restartWatchdogJob(output, job, {
                    headline:
                        'watchdog: translator audio meter stalled; restarting translation mixer',
                    reason: 'translator audio meter stalled',
                    contextLine: `no_translator_meter_for=${staleSeconds}s`,
                    extra: { staleSeconds },
                });
                continue;
            }

            if (now - job.startedAtMs < warmupMs || now - job.lastOutputProgressAtMs <= stallMs)
                continue;
            const noProgressSeconds = Math.round((now - job.lastOutputProgressAtMs) / 1000);
            await restartWatchdogJob(output, job, {
                headline: 'watchdog: translation mixer output stalled; restarting process',
                reason: 'output progress stalled',
                contextLine: `no_output_progress_for=${noProgressSeconds}s`,
            });
        }
    }

    async function reconcile(): Promise<void> {
        if (reconciling || shuttingDown) return;
        reconciling = true;
        try {
            await checkMixerWatchdogs();
            const configured = db
                .listOutputs()
                .filter(
                    (output) =>
                        output.desiredState === 'running' &&
                        output.audioEncoding === 'translation' &&
                        output.translation !== null,
                );
            const configuredIds = new Set(configured.map((output) => output.id));
            for (const outputId of jobs.keys()) {
                if (!configuredIds.has(outputId)) await stopJob(outputId);
            }
            for (const output of configured) {
                try {
                    if (!inputState.isLive(output.pipelineId)) {
                        if (jobs.has(output.id)) await stopJob(output.id);
                        continue;
                    }
                    const mix = output.translation!;
                    const translatorPipeline = db.getPipelineByStreamKey(mix.translatorStreamKey);
                    const translatorLive = translatorPipeline
                        ? inputState.isLive(translatorPipeline.id)
                        : false;
                    const translatorProtocol = translatorPipeline
                        ? inputState.getProtocol(translatorPipeline.id)
                        : null;
                    const modeState = nextDebouncedMode(
                        modeTrackers.get(output.id),
                        translatorLive,
                        Date.now(),
                    );
                    modeTrackers.set(output.id, modeState.tracker);
                    const configFp = configFingerprint(output, mix);
                    const current = jobs.get(output.id);

                    if (current?.mode === 'translated' && !translatorLive) {
                        if (current.translatorLive) current.controller.onTranslatorUnavailable();
                        current.translatorLive = false;
                        // Keep the existing translated graph alive. amix keeps
                        // the source leg flowing while the translator leg is
                        // silent/ended, so a translator outage does not drop
                        // the destination output.
                        if (current.configFingerprint === configFp) continue;
                    }

                    if (
                        current?.mode === 'translated' &&
                        translatorLive &&
                        !current.translatorLive
                    ) {
                        // The network input has reached EOF, so it cannot see
                        // the new translator session. Reopen only this mixer
                        // after a short stable-live grace period; this is the
                        // one deliberate small destination interruption.
                        if (modeState.mode !== 'translated') continue;
                        await stopJob(output.id);
                        await startJob(
                            mix,
                            output,
                            'translated',
                            jobFingerprint(output, mix, 'translated', translatorProtocol),
                            configFp,
                        );
                        continue;
                    }

                    const fingerprint = jobFingerprint(
                        output,
                        mix,
                        modeState.mode,
                        translatorProtocol,
                    );
                    if (current?.mode === modeState.mode && current.fingerprint === fingerprint) {
                        current.translatorLive = translatorLive;
                        continue;
                    }
                    if (current) await stopJob(output.id);
                    await startJob(mix, output, modeState.mode, fingerprint, configFp);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    diagnostics?.event('translation-mixer-reconcile-error', {
                        outputId: output.id,
                        message,
                    });
                    outputService.reportExternalStatus(output.id, 'failed', null);
                    console.error(`[translation-mixer] ${output.id} reconcile failed: ${message}`);
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            diagnostics?.event('translation-mixer-reconcile-failed', { message });
            console.error(`[translation-mixer] reconcile failed: ${message}`);
        } finally {
            reconciling = false;
        }
    }

    function start(): void {
        void reconcile();
    }

    function getState(outputId: string): TranslationOutputState | null {
        const job = jobs.get(outputId);
        if (!job) return null;
        const snapshot = job.controller.getSnapshot();
        return {
            mode: job.mode,
            duckState: snapshot.state,
            sourceVolumePercent: snapshot.sourceVolumePercent,
            lastTranslatorMeterDb: job.lastTranslatorMeterDb,
        };
    }

    function shutdown(): void {
        if (shuttingDown) return;
        shuttingDown = true;
        clearInterval(timer);
        for (const outputId of jobs.keys()) void stopJob(outputId);
    }

    return { start, getState, shutdown };
}
