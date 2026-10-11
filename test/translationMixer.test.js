'use strict';

const { after, afterEach, beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-srs-translation-mixer-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
fs.writeFileSync(
    path.join(tempDir, 'restream.json'),
    JSON.stringify(
        {
            port: 8080,
            database_path: './db.sqlite',
            srs_config_path: './srs.conf',
            ffmpeg_path: 'ffmpeg',
            ffprobe_path: 'ffprobe',
        },
        null,
        4,
    ),
    'utf8',
);
fs.writeFileSync(
    path.join(tempDir, 'srs.conf'),
    'listen 1935;\nhttp_api {\n    listen 1985;\n}\n',
    'utf8',
);

const {
    isTranslatorMeterStale,
    nextDebouncedMode,
    nextDuckDecision,
    selectControlPort,
    shouldRestartForStaleTranslatorMeter,
} = require('../src/services/translationMixer');

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// stdio index 3 is the pipe carrying astats/ametadata "translator meter" lines
// (see METER_VOICE_PATTERN in translationMixer.ts); leaving it silent
// simulates a translator whose audio leg never produces a sample.
class FakeMixerFfmpeg extends EventEmitter {
    constructor(pid = 4242) {
        super();
        this.pid = pid;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.stdio = [null, this.stdout, this.stderr, new PassThrough()];
        this.killSignals = [];
    }

    kill(signal) {
        this.killSignals.push(signal);
        queueMicrotask(() => {
            this.emit('exit', null, signal);
            this.emit('close', null, signal);
        });
        return true;
    }
}

function makeTranslationOutput() {
    return {
        id: 'out1',
        pipelineId: 1,
        seq: 1,
        name: 'Dest',
        desiredState: 'running',
        videoEncoding: 'copy',
        url: 'rtmp://dest.example/live/key',
        audioEncoding: 'translation',
        translation: {
            translatorStreamKey: 'xlt-key',
            sourceTrackIndex: 0,
            translatorTrackIndex: 0,
            translationDelayMs: 0,
            voiceThresholdDb: -30,
            duckVolumePercent: 20,
            duckDurationMs: 200,
            restoreSilenceMs: 500,
            restoreVolumePercent: 80,
            restoreDurationMs: 200,
        },
        lastError: null,
        hasErrorHistory: false,
    };
}

function makeTranslationDb(output) {
    const pipelines = new Map([
        [1, { id: 1, name: 'Source', streamKey: 'src-key', streamKeyId: 1 }],
        [2, { id: 2, name: 'Translator', streamKey: 'xlt-key', streamKeyId: 2 }],
    ]);
    return {
        lastError: null,
        lastErrorKind: null,
        getPipeline(id) {
            return pipelines.get(id) ?? null;
        },
        getPipelineByStreamKey(streamKey) {
            for (const pipeline of pipelines.values()) {
                if (pipeline.streamKey === streamKey) return pipeline;
            }
            return null;
        },
        getOutput(id) {
            return id === output.id ? output : null;
        },
        listOutputs() {
            return [output];
        },
        setOutputLastError(_id, message, kind) {
            this.lastError = message;
            this.lastErrorKind = kind;
        },
    };
}

function makeTranslationInputState() {
    return {
        isLive() {
            return true;
        },
        getProtocol() {
            return 'rtmp';
        },
        isHighRes() {
            return false;
        },
        pullUrl(_pipelineId, streamKey) {
            return `rtmp://127.0.0.1:1935/live/${streamKey}`;
        },
    };
}

function makeDiagnosticsRecorder() {
    return {
        events: [],
        event(name, fields) {
            this.events.push({ name, fields });
        },
        close() {},
    };
}

function loadTranslationMixerService(t, spawnNext, watchdogOverrides = {}) {
    fs.writeFileSync(
        path.join(tempDir, 'restream.json'),
        JSON.stringify(
            {
                port: 8080,
                database_path: './db.sqlite',
                srs_config_path: './srs.conf',
                ffmpeg_path: 'ffmpeg',
                ffprobe_path: 'ffprobe',
                output_watchdog: {
                    warmup_ms: watchdogOverrides.warmupMs ?? 5,
                    stall_ms: 60_000,
                    translator_meter_stale_ms: watchdogOverrides.translatorMeterStaleMs ?? 5,
                },
            },
            null,
            4,
        ),
        'utf8',
    );
    t.mock.method(childProcess, 'spawn', () => spawnNext());
    delete require.cache[require.resolve('../src/services/translationMixer')];
    delete require.cache[require.resolve('../src/utils/appConfig')];
    return require('../src/services/translationMixer').createTranslationMixerService;
}

// These constants mirror translationMixer.ts's MODE_SWITCH_*_GRACE_MS; kept in
// sync here rather than exported, since they're an implementation detail the
// tests only need to stay comfortably inside/outside of.
const DOWN_GRACE_MS = 12000;
const UP_GRACE_MS = 3000;

describe('nextDebouncedMode', () => {
    test('starts in translated mode when the translator is already live', () => {
        const { tracker, mode } = nextDebouncedMode(undefined, true, 0);
        assert.equal(mode, 'translated');
        assert.equal(tracker.effectiveLive, true);
    });

    test('starts in source-only mode when the translator is not live', () => {
        const { mode } = nextDebouncedMode(undefined, false, 0);
        assert.equal(mode, 'source-only');
    });

    test('a brief translator drop shorter than the down-grace window does not switch modes', () => {
        let state = nextDebouncedMode(undefined, true, 0);
        assert.equal(state.mode, 'translated');

        // Translator drops, but recovers well before the down-grace window elapses.
        state = nextDebouncedMode(state.tracker, false, 1000);
        assert.equal(state.mode, 'translated', 'must not flip on a momentary drop');

        state = nextDebouncedMode(state.tracker, true, 2000);
        assert.equal(state.mode, 'translated');
    });

    test('a translator drop sustained past the down-grace window switches to source-only', () => {
        let state = nextDebouncedMode(undefined, true, 0);
        state = nextDebouncedMode(state.tracker, false, 100);
        assert.equal(state.mode, 'translated', 'not yet — still inside the grace window');

        state = nextDebouncedMode(state.tracker, false, 100 + DOWN_GRACE_MS + 1);
        assert.equal(state.mode, 'source-only', 'grace window elapsed with translator still down');
    });

    test('recovery only switches back after the shorter up-grace window', () => {
        let state = nextDebouncedMode(undefined, false, 0);
        state = nextDebouncedMode(state.tracker, true, 100);
        assert.equal(state.mode, 'source-only', 'not yet — still inside the up-grace window');

        state = nextDebouncedMode(state.tracker, true, 100 + UP_GRACE_MS + 1);
        assert.equal(state.mode, 'translated');
    });

    test('a re-drop before the up-grace window elapses cancels the pending recovery', () => {
        let state = nextDebouncedMode(undefined, false, 0);
        state = nextDebouncedMode(state.tracker, true, 100);
        // Translator flickers back down before recovery would have completed.
        state = nextDebouncedMode(state.tracker, false, 100 + UP_GRACE_MS - 1);
        assert.equal(state.mode, 'source-only');

        // Since the "since" timestamp reset on the last flip, the down-grace
        // window (measured from the most recent change) must elapse again —
        // it must not still be counted as live since time 100.
        state = nextDebouncedMode(state.tracker, false, 100 + UP_GRACE_MS - 1 + 50);
        assert.equal(state.mode, 'source-only');
    });
});

describe('nextDuckDecision', () => {
    const mix = {
        voiceThresholdDb: -20,
        duckVolumePercent: 6,
        duckDurationMs: 900,
        restoreSilenceMs: 2000,
        restoreVolumePercent: 50,
        restoreDurationMs: 5000,
    };

    test('ignores silence until the translator has ever spoken', () => {
        const { tracker, ramp } = nextDuckDecision(undefined, -Infinity, 0, mix);
        assert.equal(ramp, null);
        assert.equal(tracker.state, 'resting');
        assert.equal(tracker.hasDetectedVoice, false);
    });

    test('ducks as soon as speech crosses the threshold', () => {
        const { tracker, ramp } = nextDuckDecision(undefined, -10, 0, mix);
        assert.equal(tracker.state, 'ducked');
        assert.deepEqual(ramp, { targetPercent: 6, durationMs: 900 });
    });

    test('does not re-issue a ramp for continued speech while already ducked', () => {
        let state = nextDuckDecision(undefined, -10, 0, mix);
        state = nextDuckDecision(state.tracker, -10, 100, mix);
        assert.equal(state.ramp, null, 'must not restart the duck ramp on every sample');
        assert.equal(state.tracker.state, 'ducked');
    });

    test('stays ducked through silence shorter than the hold window', () => {
        let state = nextDuckDecision(undefined, -10, 0, mix);
        state = nextDuckDecision(state.tracker, -Infinity, mix.restoreSilenceMs - 1, mix);
        assert.equal(state.ramp, null, 'restore must not fire before the hold elapses');
        assert.equal(state.tracker.state, 'ducked');
    });

    test('restores once silence has held for the full window', () => {
        let state = nextDuckDecision(undefined, -10, 0, mix);
        state = nextDuckDecision(state.tracker, -Infinity, mix.restoreSilenceMs, mix);
        assert.deepEqual(state.ramp, { targetPercent: 50, durationMs: 5000 });
        assert.equal(state.tracker.state, 'resting');
    });

    test('a fresh voice sample mid-restore ducks again instead of finishing the climb', () => {
        // Duck at t=0, go silent long enough to trigger the restore ramp at
        // t=2000 (state flips to 'resting' and a restore ramp is issued), then
        // the translator starts speaking again at t=2500 — while the gain
        // would still be climbing back up in the real ramp. The very next
        // voice sample must immediately win and duck again.
        let state = nextDuckDecision(undefined, -10, 0, mix);
        state = nextDuckDecision(state.tracker, -Infinity, mix.restoreSilenceMs, mix);
        assert.equal(state.tracker.state, 'resting');

        state = nextDuckDecision(state.tracker, -10, mix.restoreSilenceMs + 500, mix);
        assert.deepEqual(
            state.ramp,
            { targetPercent: 6, durationMs: 900 },
            'must duck again rather than let the restore ramp finish',
        );
        assert.equal(state.tracker.state, 'ducked');
    });

    test('a brief dip below threshold during speech does not reset the hold clock incorrectly', () => {
        let state = nextDuckDecision(undefined, -10, 0, mix);
        // Quiet sample, but well within the hold window.
        state = nextDuckDecision(state.tracker, -Infinity, 500, mix);
        assert.equal(state.ramp, null);
        // Speech resumes before the hold window elapses — still ducked, no new ramp.
        state = nextDuckDecision(state.tracker, -10, 800, mix);
        assert.equal(state.ramp, null);
        assert.equal(state.tracker.state, 'ducked');
        // Now silence for the full window measured from the latest speech sample.
        state = nextDuckDecision(state.tracker, -Infinity, 800 + mix.restoreSilenceMs, mix);
        assert.deepEqual(state.ramp, { targetPercent: 50, durationMs: 5000 });
    });
});

describe('selectControlPort', () => {
    test('is stable for the same outputId when no ports are taken', () => {
        const a = selectControlPort('pipeline-1-out-1', new Set());
        const b = selectControlPort('pipeline-1-out-1', new Set());
        assert.equal(a, b);
    });

    test('picks a different port when the deterministic choice is already used', () => {
        const used = new Set();
        const first = selectControlPort('same-id', used);
        used.add(first);
        const second = selectControlPort('same-id', used);
        assert.notEqual(second, first, 'must not hand out an already-claimed port');
        assert.ok(!used.has(second));
    });

    test('never collides across a batch of different output ids', () => {
        const used = new Set();
        for (let i = 0; i < 50; i++) {
            const port = selectControlPort(`output-${i}`, used);
            assert.ok(!used.has(port), `port ${port} was already handed out`);
            used.add(port);
        }
        assert.equal(used.size, 50);
    });
});

describe('isTranslatorMeterStale', () => {
    test('flags a translator whose audio leg stopped producing meter samples', () => {
        assert.equal(isTranslatorMeterStale(0, 10_001, 10_000), true);
        assert.equal(isTranslatorMeterStale(0, 10_000, 10_000), false);
    });
});

describe('shouldRestartForStaleTranslatorMeter', () => {
    const baseJob = {
        mode: 'translated',
        translatorLive: true,
        startedAtMs: 0,
        lastTranslatorMeterAtMs: 0,
    };

    test('does not fire during the startup warmup window even once the meter looks stale', () => {
        assert.equal(shouldRestartForStaleTranslatorMeter(baseJob, 10_001, 90_000, 10_000), false);
    });

    test('fires once warmup has elapsed and the meter has gone stale', () => {
        assert.equal(shouldRestartForStaleTranslatorMeter(baseJob, 90_001, 90_000, 10_000), true);
    });

    test('does not fire in source-only mode', () => {
        assert.equal(
            shouldRestartForStaleTranslatorMeter(
                { ...baseJob, mode: 'source-only' },
                90_001,
                90_000,
                10_000,
            ),
            false,
        );
    });

    test('does not fire when the translator is already known to be down', () => {
        assert.equal(
            shouldRestartForStaleTranslatorMeter(
                { ...baseJob, translatorLive: false },
                90_001,
                90_000,
                10_000,
            ),
            false,
        );
    });

    test('a translator that never sends a single meter sample is still caught once warmup elapses', () => {
        // lastTranslatorMeterAtMs is initialized to the job's start time when no
        // sample has arrived yet, so a translator whose audio never decodes
        // isn't invisible forever — it's flagged as soon as warmup passes.
        const neverSampled = { ...baseJob, lastTranslatorMeterAtMs: baseJob.startedAtMs };
        assert.equal(
            shouldRestartForStaleTranslatorMeter(neverSampled, 90_001, 90_000, 10_000),
            true,
        );
    });
});

// These run the real createTranslationMixerService against a mocked
// child_process.spawn and a real zeromq control socket (connected to a port
// nothing is listening on — the mixer doesn't require a reply to keep
// running, so this exercises the same "no peer yet" path a real restart
// does). translationMixer.ts's reconcile loop ticks on a hardcoded 1s
// interval (not config-driven, unlike output_watchdog's other timings), so
// these wait past one real tick rather than a fake clock.
describe('translation mixer watchdog integration', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/translationMixer')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    test('restarts a translated-mode job whose translator meter never produces a sample', async (t) => {
        const procs = [];
        const spawnNext = () => {
            const proc = new FakeMixerFfmpeg(4242 + procs.length);
            procs.push(proc);
            return proc;
        };
        const output = makeTranslationOutput();
        const db = makeTranslationDb(output);
        const diagnostics = makeDiagnosticsRecorder();
        const createTranslationMixerService = loadTranslationMixerService(t, spawnNext);
        const service = createTranslationMixerService(
            db,
            makeTranslationInputState(),
            { reportExternalStatus() {}, reportExternalProgress() {}, reportExternalUsage() {} },
            diagnostics,
        );

        service.start();
        await sleep(1200);
        service.shutdown();

        assert.ok(procs.length >= 2, 'expected a replacement ffmpeg to have been spawned');
        assert.deepEqual(procs[0].killSignals, ['SIGTERM']);
        assert.match(db.lastError, /watchdog: translator audio meter stalled/);
        assert.equal(db.lastErrorKind, 'crash');

        const restartEvent = diagnostics.events.find((e) => e.name === 'translation-mixer-restart');
        assert.ok(restartEvent, 'expected a translation-mixer-restart diagnostics event');
        assert.equal(restartEvent.fields.reason, 'translator audio meter stalled');
        assert.equal(restartEvent.fields.outputId, output.id);
        assert.equal(restartEvent.fields.pipelineId, output.pipelineId);
    });

    test('does not restart while still inside the startup warmup window', async (t) => {
        const procs = [];
        const spawnNext = () => {
            const proc = new FakeMixerFfmpeg(4242 + procs.length);
            procs.push(proc);
            return proc;
        };
        const output = makeTranslationOutput();
        const db = makeTranslationDb(output);
        const diagnostics = makeDiagnosticsRecorder();
        const createTranslationMixerService = loadTranslationMixerService(t, spawnNext, {
            warmupMs: 60_000,
        });
        const service = createTranslationMixerService(
            db,
            makeTranslationInputState(),
            { reportExternalStatus() {}, reportExternalProgress() {}, reportExternalUsage() {} },
            diagnostics,
        );

        service.start();
        await sleep(1200);

        assert.equal(procs.length, 1, 'must not have restarted while still warming up');
        assert.deepEqual(procs[0].killSignals, [], 'must not have been killed by a watchdog');
        assert.equal(db.lastError, null);

        service.shutdown();
    });
    // Serves a fake /proc/<pid>/status for the mixer's ffmpeg pid; every other
    // read (including the CPU tracker's /proc/<pid>/stat) goes to the real fs.
    function mockMixerRss(t, pid, rssMb) {
        const realReadFileSync = fs.readFileSync;
        t.mock.method(fs, 'readFileSync', (file, ...rest) =>
            file === `/proc/${pid}/status`
                ? `Name:\tffmpeg\nVmRSS:\t${rssMb * 1024} kB\n`
                : realReadFileSync(file, ...rest),
        );
    }

    test('reports the mixer ffmpeg RSS and limit for getStats/health without restarting under the limit', async (t) => {
        mockMixerRss(t, 4242, 50);
        const usage = [];
        const diagnostics = makeDiagnosticsRecorder();
        const procs = [];
        const spawnNext = () => {
            const proc = new FakeMixerFfmpeg(4242);
            procs.push(proc);
            return proc;
        };
        const createTranslationMixerService = loadTranslationMixerService(t, spawnNext, {
            translatorMeterStaleMs: 60_000,
        });
        const service = createTranslationMixerService(
            makeTranslationDb(makeTranslationOutput()),
            makeTranslationInputState(),
            {
                reportExternalStatus() {},
                reportExternalProgress() {},
                reportExternalUsage: (id, u) => usage.push({ id, ...u }),
            },
            diagnostics,
        );

        service.start();
        await sleep(1200);
        procs[0].emit('exit', 137, null); // crash: the exit event should carry the last RSS
        service.shutdown();

        assert.equal(procs.length, 1, 'must not restart while under the memory limit');
        const exited = diagnostics.events.find((e) => e.name === 'translation-mixer-exited');
        assert.ok(exited, 'expected an exit event');
        assert.equal(exited.fields.lastRssMb, 50);
        assert.equal(exited.fields.code, 137);
        assert.equal(typeof exited.fields.uptimeSec, 'number');
        assert.ok(usage.length >= 1, 'expected at least one usage report');
        assert.equal(usage[0].id, 'out1');
        assert.equal(usage[0].rssBytes, 50 * 1024 * 1024);
        assert.equal(usage[0].limitBytes, 200 * 1024 * 1024); // default 'copy' limit
    });

    test('restarts a mixer whose ffmpeg exceeds the memory limit and records why', async (t) => {
        mockMixerRss(t, 4242, 250);
        const procs = [];
        const spawnNext = () => {
            const proc = new FakeMixerFfmpeg(4242);
            procs.push(proc);
            return proc;
        };
        const db = makeTranslationDb(makeTranslationOutput());
        const diagnostics = makeDiagnosticsRecorder();
        const createTranslationMixerService = loadTranslationMixerService(t, spawnNext, {
            translatorMeterStaleMs: 60_000,
        });
        const service = createTranslationMixerService(
            db,
            makeTranslationInputState(),
            { reportExternalStatus() {}, reportExternalProgress() {}, reportExternalUsage() {} },
            diagnostics,
        );

        service.start();
        await sleep(1200);
        service.shutdown();

        assert.deepEqual(procs[0].killSignals, ['SIGTERM']);
        assert.match(db.lastError, /memory limit exceeded/);
        assert.match(db.lastError, /rss=250MB limit=200MB/);
        assert.equal(db.lastErrorKind, 'crash');
        const restart = diagnostics.events.find((e) => e.name === 'translation-mixer-restart');
        assert.ok(restart, 'expected a translation-mixer-restart diagnostics event');
        assert.equal(restart.fields.reason, 'memory limit exceeded');
        assert.equal(restart.fields.rssMb, 250);
        assert.equal(restart.fields.limitMb, 200);
        assert.equal(restart.fields.pid, 4242);
    });
});
