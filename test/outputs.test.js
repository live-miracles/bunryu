'use strict';

const { after, describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-outputs-'));
const originalCwd = process.cwd();

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

class FakeFfmpeg extends EventEmitter {
    constructor(pid = 1234) {
        super();
        this.pid = pid;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
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

// Like FakeFfmpeg, but kill() only records the signal — the test controls when
// the process actually exits, so it can interleave calls into the window
// between SIGTERM and the real process exit.
class ManualExitFfmpeg extends EventEmitter {
    constructor(pid = 1234) {
        super();
        this.pid = pid;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.killSignals = [];
    }

    kill(signal) {
        this.killSignals.push(signal);
        return true;
    }

    exit(signal = 'SIGTERM') {
        this.emit('exit', null, signal);
        this.emit('close', null, signal);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDb() {
    const output = {
        id: 'out1',
        pipelineId: 1,
        seq: 1,
        name: 'YouTube',
        desiredState: 'running',
        videoEncoding: 'copy',
        url: 'rtmp://youtube.example/live/key',
        audioEncoding: 'copy',
        lastError: null,
    };
    return {
        lastError: null,
        lastErrorKind: null,
        // Output warnings must stay out of the pipeline History (input issues only).
        appendPipelineLog() {
            throw new Error('outputs must not write to the pipeline History');
        },
        getPipeline(id) {
            return id === 1
                ? { id: 1, name: 'Live', streamKey: 'stream-key', streamKeyId: 1 }
                : null;
        },
        getOutput(id) {
            return id === output.id ? output : null;
        },
        listOutputsForPipeline() {
            return [output];
        },
        listOutputs() {
            return [output];
        },
        errorRecords: [],
        setOutputLastError(_id, message, kind, failedAttempts) {
            this.errorRecords.push({ message, kind, failedAttempts });
            if (kind === 'warning') return;
            this.lastError = `${Date.now()}\n${message}`;
            this.lastErrorKind = kind;
        },
    };
}

function loadOutputService(t, fakeProc, options = {}) {
    fs.writeFileSync(
        path.join(tempDir, 'bunryu.json'),
        JSON.stringify(
            {
                port: 8080,
                database_path: './db.sqlite',
                srs_config_path: './srs.conf',
                ffmpeg_path: 'ffmpeg',
                ffprobe_path: 'ffprobe',
                output_watchdog: {
                    warmup_ms: 10,
                    stall_ms: options.progressStallMs ?? 20,
                    interval_ms: 10,
                    socket_warmup_ms: options.socketWarmupMs ?? 15_000,
                    socket_grace_ms: options.socketGraceMs ?? 30_000,
                    ...(options.memoryLimitMb !== undefined
                        ? { memory_limit_mb: options.memoryLimitMb }
                        : {}),
                },
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

    t.mock.method(childProcess, 'spawn', (_cmd, args) =>
        typeof fakeProc === 'function' ? fakeProc(args) : fakeProc,
    );
    // No retry jitter unless a test asks for it, so back-off steps are exact.
    t.mock.method(Math, 'random', () => options.random ?? 0);
    if (options.ssError) {
        t.mock.method(childProcess, 'execFile', (_cmd, _args, _opts, cb) => {
            queueMicrotask(() => cb(options.ssError, '', ''));
        });
    } else if (options.ssOutput !== undefined) {
        t.mock.method(childProcess, 'execFile', (_cmd, _args, _opts, cb) => {
            queueMicrotask(() => cb(null, options.ssOutput, ''));
        });
    }
    delete require.cache[require.resolve('../src/services/outputs')];
    return require('../src/services/outputs').createOutputService;
}

function makeReadyInputState(options = {}) {
    return {
        isReady() {
            return true;
        },
        isHighRes() {
            return options.highRes ?? false;
        },
        pullUrl(_pipelineId, streamKey) {
            if (options.srt) return `srt://127.0.0.1:10080?streamid=${streamKey}`;
            return `rtmp://127.0.0.1:1935/live/${streamKey}`;
        },
    };
}

describe('output watchdog', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/outputs')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    test('kills and retries a running output when ffmpeg output progress stalls', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc);
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        proc.stderr.write('Connection reset by peer\n');

        await sleep(80);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.equal(service.getStats('out1').status, 'failed');
        assert.equal(service.getStats('out1').failures, 1);
        assert.match(db.lastError, /watchdog: ffmpeg output stalled; restarting process/);
        assert.match(db.lastError, /last_total_size=4096/);
        assert.match(db.lastError, /last_out_time_us=1000000/);
        assert.match(db.lastError, /last_bitrate_kbps=3200/);
        assert.match(db.lastError, /Connection reset by peer/);
        assert.match(db.lastError, /Restarting output: no ffmpeg output progress for \d+s/);

        service.shutdown();
    });

    test('does not kill while ffmpeg output progress continues advancing', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc);
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\n');
        await sleep(15);
        proc.stdout.write('total_size=8192\nout_time_ms=2000000\n');
        await sleep(15);
        proc.stdout.write('total_size=12288\nout_time_ms=3000000\n');

        await sleep(15);

        assert.deepEqual(proc.killSignals, []);
        assert.equal(service.getStats('out1').status, 'running');
        assert.equal(db.lastError, null);

        service.shutdown();
    });

    test('still kills stalled output when recording last_error fails', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        db.setOutputLastError = () => {
            throw new Error('database busy');
        };
        const createOutputService = loadOutputService(t, proc);
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\n');

        await sleep(80);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.equal(service.getStats('out1').status, 'failed');
        assert.equal(service.getStats('out1').failures, 1);

        service.shutdown();
    });

    test('marks warningReason when RSS crosses 70% of the memory limit', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            memoryLimitMb: 200,
        });
        const originalReadFileSync = fs.readFileSync;
        t.mock.method(fs, 'readFileSync', (filePath, ...rest) => {
            if (String(filePath) === `/proc/${proc.pid}/status`) {
                return 'VmRSS:  150000 kB\n'; // ~146MB, 73% of the 200MB limit
            }
            return originalReadFileSync(filePath, ...rest);
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        await sleep(60);

        assert.equal(service.getStats('out1').status, 'running');
        assert.deepEqual(proc.killSignals, []);
        assert.match(service.getStats('out1').warningReason || '', /High memory usage/);
        assert.equal(service.getStats('out1').memoryUsageBytes, 150000 * 1024);
        assert.equal(service.getStats('out1').memoryLimitBytes, 200 * 1024 * 1024);

        service.shutdown();
    });

    test('clears memory warningReason once RSS drops back below the threshold', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            memoryLimitMb: 200,
        });
        let rssKb = 150000; // ~73% of the 200MB limit
        const originalReadFileSync = fs.readFileSync;
        t.mock.method(fs, 'readFileSync', (filePath, ...rest) => {
            if (String(filePath) === `/proc/${proc.pid}/status`) {
                return `VmRSS:  ${rssKb} kB\n`;
            }
            return originalReadFileSync(filePath, ...rest);
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        await sleep(40);
        assert.match(service.getStats('out1').warningReason || '', /High memory usage/);

        rssKb = 50000; // ~24% of the limit
        await sleep(40);
        assert.equal(service.getStats('out1').warningReason, null);
        assert.equal(service.getStats('out1').memoryUsageBytes, 50000 * 1024);
        assert.deepEqual(proc.killSignals, []);

        service.shutdown();
    });

    test('doubles the memory limit for a high-res (4K) input', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            memoryLimitMb: 200,
        });
        const originalReadFileSync = fs.readFileSync;
        t.mock.method(fs, 'readFileSync', (filePath, ...rest) => {
            if (String(filePath) === `/proc/${proc.pid}/status`) {
                return 'VmRSS:  300000 kB\n'; // ~293MB: over the 200MB base limit, under the doubled 400MB limit
            }
            return originalReadFileSync(filePath, ...rest);
        });
        const service = createOutputService(db, makeReadyInputState({ highRes: true }));

        await service.start('out1');
        await sleep(60);

        assert.equal(service.getStats('out1').status, 'running');
        assert.deepEqual(proc.killSignals, []);
        assert.equal(service.getStats('out1').memoryLimitBytes, 200 * 1024 * 1024 * 2);
        assert.match(service.getStats('out1').warningReason || '', /High memory usage/);

        service.shutdown();
    });

    test('warns when RTMP destination socket is closing before grace elapses', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const ssOutput =
            'CLOSE-WAIT 57 0 10.160.0.30:47178 192.178.174.134:1935 users:(("ffmpeg",pid=1234,fd=6))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 500,
            ssOutput,
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(40);

        assert.equal(service.getStats('out1').status, 'running');
        assert.match(service.getStats('out1').warningReason || '', /CLOSE-WAIT/);
        assert.deepEqual(proc.killSignals, []);

        service.shutdown();
    });

    test('does not turn ss failures into missing socket kills', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssError: new Error('ss failed'),
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(80);

        assert.equal(service.getStats('out1').warningReason, null);
        assert.deepEqual(proc.killSignals, []);
        assert.equal(db.lastError, null);

        service.shutdown();
    });

    test('progress watchdog still kills while socket warning grace is open', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const ssOutput =
            'CLOSE-WAIT 57 0 10.160.0.30:47178 192.178.174.134:1935 users:(("ffmpeg",pid=1234,fd=6))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 20,
            socketWarmupMs: 10,
            socketGraceMs: 500,
            ssOutput,
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(80);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.match(db.lastError, /watchdog: ffmpeg output stalled; restarting process/);

        service.shutdown();
    });

    test('kills and retries when RTMP destination socket stays unhealthy', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const ssOutput =
            'CLOSE-WAIT 57 0 10.160.0.30:47178 192.178.174.134:1935 users:(("ffmpeg",pid=1234,fd=6))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssOutput,
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(80);

        assert.deepEqual(proc.killSignals, ['SIGTERM']);
        assert.equal(service.getStats('out1').status, 'failed');
        assert.equal(service.getStats('out1').failures, 1);
        assert.match(db.lastError, /destination socket unhealthy/);
        assert.match(db.lastError, /CLOSE-WAIT/);
        assert.match(
            db.lastError,
            /socket_warning=RTMP socket CLOSE-WAIT on destination port 1935/,
        );
        assert.match(db.lastError, /socket_snapshot:/);
        assert.match(db.lastError, /CLOSE-WAIT peer=192\.178\.174\.134:1935/);
        assert.match(db.lastError, /last_bitrate_kbps=3200/);
        assert.match(
            db.lastError,
            /Restarting output: RTMP socket CLOSE-WAIT on destination port 1935/,
        );

        service.shutdown();
    });

    test('ignores local RTMP outputs in socket watchdog', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        db.getOutput('out1').url = 'rtmp://localhost/live/downstream';
        const ssOutput =
            'CLOSE-WAIT 0 0 127.0.0.1:50100 127.0.0.1:1935 users:(("ffmpeg",pid=1234,fd=5))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssOutput,
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(80);

        assert.equal(service.getStats('out1').warningReason, null);
        assert.deepEqual(proc.killSignals, []);
        assert.equal(db.lastError, null);

        service.shutdown();
    });

    test('ignores IPv6 localhost RTMP outputs in socket watchdog', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        db.getOutput('out1').url = 'rtmp://[::1]:1935/live/downstream';
        const ssOutput = 'CLOSE-WAIT 0 0 [::1]:50100 [::1]:1935 users:(("ffmpeg",pid=1234,fd=5))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssOutput,
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(80);

        assert.equal(service.getStats('out1').warningReason, null);
        assert.deepEqual(proc.killSignals, []);
        assert.equal(db.lastError, null);

        service.shutdown();
    });

    test('keeps RTMP output healthy when remote destination socket is established', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const ssOutput =
            'ESTAB 0 0 10.160.0.30:50532 192.178.174.134:1935 users:(("ffmpeg",pid=1234,fd=6))\n';
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 500,
            socketWarmupMs: 10,
            socketGraceMs: 20,
            ssOutput,
        });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        await sleep(40);

        assert.equal(service.getStats('out1').warningReason, null);
        assert.deepEqual(proc.killSignals, []);

        service.shutdown();
    });
});

describe('output stop/start race', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/outputs')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    test('restarts an output when start arrives while a stop kill is in flight', async (t) => {
        const procs = [];
        const spawnNext = () => {
            const proc = new ManualExitFfmpeg(1000 + procs.length);
            procs.push(proc);
            return proc;
        };
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, spawnNext, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        assert.equal(procs.length, 1);
        assert.equal(service.getStats('out1').status, 'running');

        // Operator clicks Stop: desiredState flips first (API order), then the
        // kill is issued. The process has not exited yet.
        output.desiredState = 'stopped';
        service.stop('out1');
        assert.deepEqual(procs[0].killSignals, ['SIGTERM']);
        assert.equal(service.getStats('out1').status, 'running');

        // Operator clicks Start again before ffmpeg finishes dying. start()
        // still sees status 'running' and returns without spawning.
        output.desiredState = 'running';
        await service.start('out1');
        assert.equal(procs.length, 1);

        // The old process now exits from the SIGTERM. The requested-stop exit
        // must notice desiredState is 'running' again and respawn.
        procs[0].exit();
        await sleep(30);

        assert.equal(procs.length, 2, 'a replacement ffmpeg should have been spawned');
        assert.equal(service.getStats('out1').status, 'running');
        assert.equal(service.getStats('out1').failures, 0);

        service.shutdown();
    });

    test('does not restart when the output stays stopped', async (t) => {
        const procs = [];
        const spawnNext = () => {
            const proc = new ManualExitFfmpeg(1000 + procs.length);
            procs.push(proc);
            return proc;
        };
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, spawnNext, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        output.desiredState = 'stopped';
        service.stop('out1');
        procs[0].exit();
        await sleep(30);

        assert.equal(procs.length, 1);
        assert.equal(service.getStats('out1').status, 'stopped');

        service.shutdown();
    });

    test('stopping during a retry backoff (no live process) still records a stopped marker', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        // Simulate ffmpeg crashing on its own (not via kill()) — the close
        // handler records a 'crash' entry, clears `processes`, and schedules
        // a retry a second or two out. No SIGTERM was sent, so this differs
        // from the SIGTERM-in-flight race covered above.
        proc.emit('close', 1, null);

        assert.equal(db.lastErrorKind, 'crash');
        assert.equal(service.getStats('out1').status, 'failed');

        // Operator clicks Stop while the output sits in that retry-backoff
        // gap — there's no live process for service.stop() to kill, so the
        // close handler (which normally writes the 'stopped' marker) never
        // runs. stop() must record it directly, or the crash above stays
        // the newest history entry forever and keeps showing as current.
        output.desiredState = 'stopped';
        service.stop('out1');

        assert.equal(service.getStats('out1').status, 'stopped');
        assert.equal(db.lastErrorKind, 'stopped');
        assert.match(db.lastError, /\n$/);

        service.shutdown();
    });

    test('stopping after repeated failed attempts records the count and the last failure', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        for (let i = 0; i < 5; i++) {
            proc.stderr.write(
                'Connection to tcp://youtube.example:1935 failed: Connection refused\n',
            );
            await sleep(5);
            proc.emit('close', 1, null);
        }
        assert.equal(service.getStats('out1').failures, 5);

        output.desiredState = 'stopped';
        service.stop('out1');

        const stop = db.errorRecords.at(-1);
        assert.equal(stop.kind, 'stopped');
        assert.equal(stop.failedAttempts, 5);
        assert.equal(
            stop.message,
            'Stopped after 5 failed attempts. Last error: Connection to tcp://youtube.example:1935 failed: Connection refused',
        );

        service.shutdown();
    });

    test('stopping after fewer failed attempts is a plain stop', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        for (let i = 0; i < 4; i++) {
            proc.emit('close', 1, null);
        }

        output.desiredState = 'stopped';
        service.stop('out1');

        const stop = db.errorRecords.at(-1);
        assert.equal(stop.kind, 'stopped');
        assert.equal(stop.failedAttempts, undefined);
        assert.equal(stop.message, '');

        service.shutdown();
    });

    test('a run that stays up for a minute breaks the streak of failed attempts', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        for (let i = 0; i < 4; i++) proc.emit('close', 1, null);

        // The next attempt runs for over a minute before it dies, then one more
        // quick failure: the streak restarts, so 4 + 1 does not reach 5.
        const realNow = Date.now;
        let now = realNow();
        t.mock.method(Date, 'now', () => now);
        service.reportExternalStatus('out1', 'running', 4321);
        now += 61_000;
        proc.emit('close', 1, null);
        proc.emit('close', 1, null);

        output.desiredState = 'stopped';
        service.stop('out1');

        assert.equal(db.errorRecords.at(-1).failedAttempts, undefined);

        service.shutdown();
    });

    test('the retry delay starts over after a run that stayed up', async (t) => {
        const procs = [];
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(
            t,
            () => {
                const proc = new FakeFfmpeg(1000 + procs.length);
                procs.push(proc);
                return proc;
            },
            { progressStallMs: 1e9, socketWarmupMs: 1e9 },
        );
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
        const settle = () => new Promise((resolve) => setImmediate(resolve));
        const service = createOutputService(makeDb(), makeReadyInputState(), diagnostics);

        await service.start('out1');
        // Five quick failures walk the back-off up to its 16 s cap...
        for (const delayMs of [1000, 2000, 4000, 8000, 16000]) {
            procs.at(-1).emit('close', 1, null);
            t.mock.timers.tick(delayMs);
            await settle();
        }
        // ...then a run that stays up for two minutes before dropping.
        t.mock.timers.tick(120_000);
        procs.at(-1).emit('close', 1, null);
        await settle();

        const retries = diagnostics.events.filter((e) => e.event === 'ffmpeg-retry-scheduled');
        assert.equal(retries.length, 6);
        assert.ok(retries[4].delayMs > 8000, 'the fifth quick failure waits the longest');
        assert.ok(
            retries[5].delayMs <= 1000,
            `a drop after a stable run must retry fast, got ${retries[5].delayMs} ms`,
        );
        assert.equal(service.getStats('out1').failures, 6, 'failures still counts every exit');

        service.shutdown();
    });

    test('retry delays are shortened by up to a quarter at random', async (t) => {
        const proc = new FakeFfmpeg();
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 1e9,
            random: 0.999,
        });
        const service = createOutputService(makeDb(), makeReadyInputState(), diagnostics);

        await service.start('out1');
        proc.emit('close', 1, null);

        const retry = diagnostics.events.find((e) => e.event === 'ffmpeg-retry-scheduled');
        assert.equal(retry.delayMs, 750);

        service.shutdown();
    });

    test('an output left with nothing driving it is started again by the backstop', async (t) => {
        const procs = [];
        const db = makeDb();
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(
            t,
            () => {
                const proc = new FakeFfmpeg(1000 + procs.length);
                procs.push(proc);
                return proc;
            },
            { progressStallMs: 1e9, socketWarmupMs: 1e9 },
        );
        const service = createOutputService(db, makeReadyInputState(), diagnostics);

        await service.start('out1');
        // The retry's start throws (a transient DB error), which leaves the
        // output desired-running with no process and no timer.
        const getPipeline = db.getPipeline;
        db.getPipeline = () => {
            db.getPipeline = getPipeline;
            throw new Error('database is locked');
        };
        procs[0].emit('close', 1, null);
        await sleep(1500);

        assert.equal(procs.length, 2, 'the backstop must start the orphaned output');
        assert.ok(diagnostics.events.some((e) => e.event === 'output-start-failed'));
        assert.ok(diagnostics.events.some((e) => e.event === 'output-restarted-by-backstop'));

        service.shutdown();
    });

    test('a start that fails before spawning leaves one Error History record per episode', async (t) => {
        const procs = [];
        const db = makeDb();
        const createOutputService = loadOutputService(
            t,
            () => {
                const proc = new FakeFfmpeg(1000 + procs.length);
                procs.push(proc);
                return proc;
            },
            { progressStallMs: 1e9, socketWarmupMs: 1e9 },
        );
        const service = createOutputService(db, makeReadyInputState());
        const started = () => db.errorRecords.filter((r) => /^Start failed/.test(r.message));
        const watchdog = () => db.errorRecords.filter((r) => /^Watchdog: /.test(r.message));

        await service.start('out1');
        const getPipeline = db.getPipeline;
        db.getPipeline = () => {
            throw new Error('database is locked');
        };
        procs[0].emit('close', 1, null);
        // The retry fails, then the backstop kicks and fails again, repeatedly.
        await sleep(1700);

        assert.equal(started().length, 1, 'every failed attempt must not add a record');
        assert.equal(started()[0].kind, 'crash');
        assert.match(started()[0].message, /database is locked/);
        assert.equal(watchdog().length, 1);
        assert.equal(watchdog()[0].kind, 'warning');

        // Once it spawns again the episode is over: the next one is recorded.
        db.getPipeline = getPipeline;
        await sleep(400);
        assert.equal(procs.length, 2, 'the backstop must start the output once it can');
        db.getPipeline = () => {
            throw new Error('database is locked');
        };
        procs[1].emit('close', 1, null);
        // Its retry waits 2 s: the second quick failure in a row.
        await sleep(2400);

        assert.equal(started().length, 2);

        service.shutdown();
    });

    test('never spawns a second ffmpeg while one is registered for the output', async (t) => {
        const procs = [];
        const createOutputService = loadOutputService(
            t,
            () => {
                const proc = new ManualExitFfmpeg(1000 + procs.length);
                procs.push(proc);
                return proc;
            },
            { progressStallMs: 1e9, socketWarmupMs: 1e9 },
        );
        const service = createOutputService(makeDb(), makeReadyInputState());

        await service.start('out1');
        assert.equal(procs.length, 1);

        // The status check in start() and tryStart() is what normally stops a
        // second spawn; with it defeated, the spawn itself must still refuse.
        service.reportExternalStatus('out1', 'stopped', null);
        await service.start('out1');
        assert.equal(procs.length, 1, 'a second ffmpeg would orphan the first');

        service.shutdown();
    });

    test('stopping a live attempt after repeated failed attempts records the count and the last failure', async (t) => {
        const procs = [];
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(
            t,
            () => {
                const proc = new FakeFfmpeg(1000 + procs.length);
                procs.push(proc);
                return proc;
            },
            { progressStallMs: 60_000 },
        );
        // Only timeouts are mocked, so the retry back-off (1, 2, 4, 8 s) can be
        // stepped through instantly; setImmediate still lets the retry's awaits settle.
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const settle = () => new Promise((resolve) => setImmediate(resolve));
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        for (const delayMs of [1000, 2000, 4000, 8000]) {
            procs.at(-1).stderr.write('Connection refused\n');
            await settle();
            procs.at(-1).emit('close', 1, null);
            t.mock.timers.tick(delayMs);
            await settle();
        }
        // The fifth attempt fails too and the sixth is running when Stop is pressed.
        procs.at(-1).stderr.write('Connection refused\n');
        await settle();
        procs.at(-1).emit('close', 1, null);
        t.mock.timers.tick(16_000);
        await settle();
        assert.equal(procs.length, 6);
        assert.equal(service.getStats('out1').status, 'running');
        assert.equal(service.getStats('out1').failures, 5);

        output.desiredState = 'stopped';
        service.stop('out1');
        await settle();

        assert.deepEqual(procs.at(-1).killSignals, ['SIGTERM']);
        const stop = db.errorRecords.at(-1);
        assert.equal(stop.kind, 'stopped');
        assert.equal(stop.failedAttempts, 5);
        assert.equal(
            stop.message,
            'Stopped after 5 failed attempts. Last error: Connection refused',
        );
        assert.equal(service.getStats('out1').status, 'stopped');

        service.shutdown();
    });

    test('stopping an output that recovered and has stayed up for a minute is a plain stop', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        for (let i = 0; i < 5; i++) proc.emit('close', 1, null);

        // It then connects and runs healthily; the failed attempts are behind it.
        let now = Date.now();
        t.mock.method(Date, 'now', () => now);
        service.reportExternalStatus('out1', 'running', 4321);
        now += 61_000;

        output.desiredState = 'stopped';
        service.stop('out1');

        assert.equal(db.errorRecords.at(-1).kind, 'stopped');
        assert.equal(db.errorRecords.at(-1).failedAttempts, undefined);

        service.shutdown();
    });

    test('stopping an output with pending stderr records it as a stopped-kind diagnostic entry', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stderr.write('Connection stuck, retrying handshake...\n');
        await sleep(15);

        output.desiredState = 'stopped';
        service.stop('out1');
        await sleep(15);

        assert.equal(service.getStats('out1').status, 'stopped');
        assert.equal(db.lastErrorKind, 'stopped');
        assert.match(db.lastError, /Connection stuck, retrying handshake/);

        service.shutdown();
    });

    test('stopping a clean output still records an empty stopped-kind marker', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        await sleep(15);

        output.desiredState = 'stopped';
        service.stop('out1');
        await sleep(15);

        // Written unconditionally (even with no stderr) so it becomes the
        // newest history entry and immediately supersedes any earlier crash,
        // instead of leaving a stale crash as the "current" error.
        assert.equal(service.getStats('out1').status, 'stopped');
        assert.equal(db.lastErrorKind, 'stopped');
        assert.match(db.lastError, /\n$/);

        service.shutdown();
    });

    test('shutdown does not record diagnostic entries even with pending stderr', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        proc.stderr.write('some routine warning\n');
        await sleep(15);

        service.shutdown();
        await sleep(15);

        assert.equal(db.lastError, null);
    });
});

describe('output service control surface', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/outputs')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    test('start() never spawns for a translation-audio output', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        db.getOutput('out1').audioEncoding = 'translation';
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        assert.equal(service.getStats('out1').status, 'stopped');

        service.shutdown();
    });

    test('reportExternalStatus lets another service (the translation mixer) report real status', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        service.reportExternalStatus('out1', 'running', 4242);
        assert.equal(service.getStats('out1').status, 'running');
        assert.equal(service.getStats('out1').pid, 4242);
        assert.ok(service.getStats('out1').startedAtMs);

        service.reportExternalStatus('out1', 'stopped', null);
        assert.equal(service.getStats('out1').status, 'stopped');
        assert.equal(service.getStats('out1').pid, null);

        service.shutdown();
    });

    test('reportExternalUsage surfaces mixer RSS/CPU and the high-memory warning, and clears on stop', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());
        const mb = 1024 * 1024;

        // A late sample for an output that isn't running must not create state.
        service.reportExternalUsage('out1', {
            rssBytes: 10 * mb,
            limitBytes: 200 * mb,
            cpuPercent: 5,
        });
        assert.equal(service.getStats('out1').memoryUsageBytes, null);

        service.reportExternalStatus('out1', 'running', 4242);
        service.reportExternalUsage('out1', {
            rssBytes: 100 * mb,
            limitBytes: 200 * mb,
            cpuPercent: 12,
        });
        let stats = service.getStats('out1');
        assert.equal(stats.memoryUsageBytes, 100 * mb);
        assert.equal(stats.memoryLimitBytes, 200 * mb);
        assert.equal(stats.cpuPercent, 12);
        assert.equal(stats.warningReason, null);

        service.reportExternalUsage('out1', {
            rssBytes: 150 * mb,
            limitBytes: 200 * mb,
            cpuPercent: 12,
        });
        assert.match(
            service.getStats('out1').warningReason,
            /High memory usage: 150MB \/ 200MB limit \(75%\)/,
        );

        service.reportExternalUsage('out1', {
            rssBytes: 100 * mb,
            limitBytes: 200 * mb,
            cpuPercent: null,
        });
        stats = service.getStats('out1');
        assert.equal(stats.warningReason, null);
        assert.equal(stats.cpuPercent, null);

        service.reportExternalStatus('out1', 'stopped', null);
        assert.equal(service.getStats('out1').memoryUsageBytes, null);

        service.shutdown();
    });

    test('a high-memory episode is recorded once, in the output Error History, when it clears', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState(), diagnostics);
        const mb = 1024 * 1024;
        const usage = (rss) => ({ rssBytes: rss * mb, limitBytes: 200 * mb, cpuPercent: 1 });

        service.reportExternalStatus('out1', 'running', 4242);
        service.reportExternalUsage('out1', usage(150));
        service.reportExternalUsage('out1', usage(160));
        assert.equal(db.errorRecords.length, 0, 'nothing is recorded while the episode is open');

        service.reportExternalUsage('out1', usage(100));
        assert.deepEqual(
            db.errorRecords.map((r) => r.kind),
            ['warning'],
        );
        assert.match(db.errorRecords[0].message, /High memory usage: 150MB.*lasted \d+s\)/);
        assert.deepEqual(
            diagnostics.events.map((e) => [e.event, e.kind]),
            [
                ['ffmpeg-warning-started', 'memory'],
                ['ffmpeg-warning-ended', 'memory'],
            ],
        );

        // An episode still open when the process stops is recorded on exit.
        service.reportExternalUsage('out1', usage(150));
        service.reportExternalStatus('out1', 'stopped', null);
        assert.equal(db.errorRecords.length, 1, 'second episode is inside the 10 min limit');
        assert.equal(diagnostics.events.at(-1).reason, 'ended with ffmpeg exit');

        service.shutdown();
    });

    test('an unhealthy destination socket episode that clears by itself is recorded', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(t, proc, {
            progressStallMs: 1e9,
            socketWarmupMs: 10,
            socketGraceMs: 1e9,
            ssOutput:
                'CLOSE-WAIT 57 0 10.160.0.30:47178 192.178.174.134:1935 users:(("ffmpeg",pid=1234,fd=6))\n',
        });
        const service = createOutputService(db, makeReadyInputState(), diagnostics);

        await service.start('out1');
        await sleep(80);
        assert.match(service.getStats('out1').warningReason, /CLOSE-WAIT/);
        assert.equal(db.errorRecords.length, 0);

        await service.stopAndWait('out1');
        const warning = db.errorRecords.find((r) => r.kind === 'warning');
        assert.match(warning.message, /Destination socket unhealthy: .*CLOSE-WAIT.*lasted/);
        assert.ok(diagnostics.events.some((e) => e.event === 'ffmpeg-warning-started'));
        assert.ok(diagnostics.events.some((e) => e.event === 'ffmpeg-warning-ended'));

        service.shutdown();
    });

    test('a media clock running-fast episode is recorded when pacing returns to realtime', async (t) => {
        const clock = { now: Date.now() };
        t.mock.method(Date, 'now', () => clock.now);
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 1e9 });
        const service = createOutputService(db, makeReadyInputState({ srt: true }), diagnostics);

        await service.start('out1');
        let outTimeUs = 1_000_000;
        const progress = async (wallMs, mediaUs) => {
            clock.now += wallMs;
            outTimeUs += mediaUs;
            proc.stdout.write(`out_time_ms=${outTimeUs}\n`);
            await sleep(10);
        };
        await progress(0, 0);
        for (let i = 0; i < 12; i++) await progress(1000, 2_000_000);
        assert.match(service.getStats('out1').warningReason, /running fast/);
        assert.equal(db.errorRecords.length, 0);

        await progress(1000, 1_000_000);
        assert.equal(service.getStats('out1').warningReason, null);
        assert.deepEqual(
            db.errorRecords.map((r) => r.kind),
            ['warning'],
        );
        assert.match(db.errorRecords[0].message, /media clock is running fast.*lasted/);

        service.shutdown();
    });

    describe('falling behind realtime', () => {
        // Feeds -progress lines on a fake clock: `wallMs` of wall time passes and
        // the output's media clock advances by `mediaUs`.
        async function setup(t) {
            const clock = { now: Date.now() };
            t.mock.method(Date, 'now', () => clock.now);
            const proc = new FakeFfmpeg();
            const db = makeDb();
            const diagnostics = makeDiagnosticsSpy();
            const createOutputService = loadOutputService(t, proc, {
                progressStallMs: 1e9,
                socketWarmupMs: 1e9,
            });
            const service = createOutputService(db, makeReadyInputState(), diagnostics);
            await service.start('out1');
            let outTimeUs = 1_000_000;
            const progress = async (wallMs, mediaUs) => {
                clock.now += wallMs;
                outTimeUs += mediaUs;
                proc.stdout.write(`out_time_ms=${outTimeUs}\n`);
                await sleep(5);
            };
            await progress(0, 0);
            return { service, db, diagnostics, progress, clock };
        }

        test('two slow 30 s windows raise a warning, and one good window clears it', async (t) => {
            const { service, db, diagnostics, progress } = await setup(t);

            for (let i = 0; i < 70; i++) await progress(1000, 500_000);
            assert.match(service.getStats('out1').warningReason, /0\.50x realtime.*falling behind/);
            assert.ok(
                diagnostics.events.some(
                    (e) => e.event === 'ffmpeg-warning-started' && e.kind === 'falling-behind',
                ),
            );
            assert.equal(db.errorRecords.length, 0, 'recorded when it ends, not when it starts');

            for (let i = 0; i < 65; i++) await progress(1000, 1_000_000);
            assert.equal(service.getStats('out1').warningReason, null);
            assert.deepEqual(
                db.errorRecords.map((r) => r.kind),
                ['warning'],
            );
            assert.match(db.errorRecords[0].message, /falling behind.*lasted/);

            service.shutdown();
        });

        test('reports when the warning started, and nothing once it clears', async (t) => {
            const { service, progress, clock } = await setup(t);
            const startedAt = clock.now;
            assert.equal(service.getStats('out1').warningSinceMs, null);

            for (let i = 0; i < 70; i++) await progress(1000, 500_000);
            // The second slow window closed 60 s after the first sample.
            assert.equal(service.getStats('out1').warningSinceMs, startedAt + 60_000);

            for (let i = 0; i < 65; i++) await progress(1000, 1_000_000);
            assert.equal(service.getStats('out1').warningSinceMs, null);
            service.shutdown();
        });

        test('one slow window (a brief input hiccup) does not warn', async (t) => {
            const { service, progress } = await setup(t);

            for (let i = 0; i < 30; i++) await progress(1000, 500_000);
            for (let i = 0; i < 90; i++) await progress(1000, 1_000_000);

            assert.equal(service.getStats('out1').warningReason, null);
            service.shutdown();
        });

        test('realtime pacing never warns', async (t) => {
            const { service, diagnostics, progress } = await setup(t);

            for (let i = 0; i < 120; i++) await progress(1000, 1_000_000);

            assert.equal(service.getStats('out1').warningReason, null);
            assert.ok(!diagnostics.events.some((e) => e.kind === 'falling-behind'));
            service.shutdown();
        });

        test('a long gap in progress ends the warning instead of leaving it stale', async (t) => {
            const { service, progress } = await setup(t);

            for (let i = 0; i < 70; i++) await progress(1000, 500_000);
            assert.match(service.getStats('out1').warningReason, /falling behind/);

            // Nothing advances for a minute (input down, stall watchdog's case),
            // then media flows again: the old slow windows no longer apply.
            await progress(60_000, 1_000_000);
            assert.equal(service.getStats('out1').warningReason, null);
            service.shutdown();
        });
    });

    test('start() throws for an unknown output id and never spawns', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await assert.rejects(() => service.start('does-not-exist'), /Output not found/);
        assert.equal(service.getStats('does-not-exist').status, 'stopped');

        service.shutdown();
    });

    test('start() throws for an invalid destination URL and never spawns', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        db.getOutput('out1').url = 'not-a-url';
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await assert.rejects(() => service.start('out1'), /Invalid output URL/);
        assert.equal(service.getStats('out1').status, 'stopped');

        service.shutdown();
    });

    test('start() does not spawn while the input is not ready, and getStats stays stopped', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const notReady = {
            isReady: () => false,
            isHighRes: () => false,
            pullUrl: () => 'rtmp://x',
        };
        const service = createOutputService(db, notReady);

        await service.start('out1');

        assert.equal(service.getStats('out1').status, 'stopped');
        assert.equal(service.getStats('out1').pid, null);

        service.shutdown();
    });

    test('a second concurrent start() while one is already running does not spawn twice', async (t) => {
        let spawnCount = 0;
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, () => {
            spawnCount++;
            return proc;
        });
        const service = createOutputService(db, makeReadyInputState());

        await Promise.all([service.start('out1'), service.start('out1')]);

        assert.equal(spawnCount, 1);
        assert.equal(service.getStats('out1').status, 'running');

        service.shutdown();
    });

    test('getStats for an output that was never started returns stopped defaults', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        const stats = service.getStats('out1');
        assert.deepEqual(stats, {
            status: 'stopped',
            pid: null,
            bitrateKbps: null,
            startedAtMs: null,
            failures: 0,
            warningReason: null,
            warningSinceMs: null,
            memoryUsageBytes: null,
            memoryLimitBytes: null,
            cpuPercent: null,
            lastOutTimeUs: null,
            lastTotalSizeBytes: null,
            progressAgeMs: null,
            outputProgressAgeMs: null,
            role: 'output',
            renditionId: null,
            ready: null,
        });

        service.shutdown();
    });

    test('stopAndWait resolves only after the process actually exits', async (t) => {
        const proc = new ManualExitFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        let resolved = false;
        const p = service.stopAndWait('out1').then(() => {
            resolved = true;
        });

        await sleep(15);
        assert.equal(resolved, false, 'must not resolve before the process exits');
        assert.deepEqual(proc.killSignals, ['SIGTERM']);

        proc.exit();
        await p;
        assert.equal(resolved, true);
        assert.equal(service.getStats('out1').status, 'stopped');

        service.shutdown();
    });

    test('stopAndWait on an already-stopped output resolves immediately', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.stopAndWait('out1');
        assert.equal(service.getStats('out1').status, 'stopped');

        service.shutdown();
    });

    test('clearRetryState cancels a pending scheduled retry so it never fires', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const output = db.getOutput('out1');
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState());

        await service.start('out1');
        // Crash: schedules a retry ~1s out via RETRY_DELAYS_MS[0].
        proc.emit('close', 1, null);
        assert.equal(service.getStats('out1').status, 'failed');
        assert.equal(service.getStats('out1').failures, 1);

        service.clearRetryState('out1');
        output.desiredState = 'stopped';
        // Give the (cancelled) retry timer a chance to fire if it wasn't
        // actually cancelled — if it fires, tryStart would spawn a 2nd proc.
        await sleep(30);

        assert.equal(service.getStats('out1').status, 'failed');

        service.shutdown();
    });
});

describe('restartPipelineOutputs', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/outputs')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    function makeMultiDb(outputs) {
        const byId = new Map(outputs.map((o) => [o.id, o]));
        return {
            lastError: null,
            lastErrorKind: null,
            getPipeline(id) {
                return id === 1
                    ? { id: 1, name: 'Live', streamKey: 'stream-key', streamKeyId: 1 }
                    : null;
            },
            getOutput(id) {
                return byId.get(id) ?? null;
            },
            listOutputsForPipeline(pipelineId) {
                return outputs.filter((o) => o.pipelineId === pipelineId);
            },
            setOutputLastError(_id, message, kind) {
                this.lastError = `${Date.now()}\n${message}`;
                this.lastErrorKind = kind;
            },
        };
    }

    function makeOutput(id, overrides = {}) {
        return {
            id,
            pipelineId: 1,
            seq: 1,
            name: id,
            desiredState: 'running',
            videoEncoding: 'copy',
            url: 'rtmp://youtube.example/live/key',
            audioEncoding: 'copy',
            lastError: null,
            ...overrides,
        };
    }

    test('only schedules outputs whose desiredState is running, and returns that count', async (t) => {
        const spawned = [];
        const createOutputService = loadOutputService(
            t,
            () => {
                const p = new FakeFfmpeg(1000 + spawned.length);
                spawned.push(p);
                return p;
            },
            { progressStallMs: 60_000 },
        );
        const db = makeMultiDb([
            makeOutput('a', { desiredState: 'running' }),
            makeOutput('b', { desiredState: 'stopped' }),
            makeOutput('c', { desiredState: 'running' }),
        ]);
        const service = createOutputService(db, makeReadyInputState());

        const scheduled = service.restartPipelineOutputs(1, 0);
        assert.equal(scheduled, 2);

        await sleep(700);
        assert.equal(service.getStats('a').status, 'running');
        assert.equal(service.getStats('b').status, 'stopped');
        assert.equal(service.getStats('c').status, 'running');

        service.shutdown();
    });

    test('skips outputs already actively running instead of double-spawning', async (t) => {
        const spawned = [];
        const createOutputService = loadOutputService(
            t,
            () => {
                const p = new FakeFfmpeg(1000 + spawned.length);
                spawned.push(p);
                return p;
            },
            { progressStallMs: 60_000 },
        );
        const db = makeMultiDb([makeOutput('a', { desiredState: 'running' })]);
        const service = createOutputService(db, makeReadyInputState());

        await service.start('a');
        assert.equal(spawned.length, 1);

        const scheduled = service.restartPipelineOutputs(1, 0);
        assert.equal(scheduled, 0);

        await sleep(300);
        assert.equal(
            spawned.length,
            1,
            'must not spawn a second ffmpeg for an already-running output',
        );

        service.shutdown();
    });

    test('staggers restarts and resets each failure counter to 0', async (t) => {
        const spawned = [];
        const createOutputService = loadOutputService(
            t,
            () => {
                const p = new FakeFfmpeg(1000 + spawned.length);
                spawned.push(p);
                return p;
            },
            { progressStallMs: 60_000 },
        );
        const db = makeMultiDb([
            makeOutput('a', { desiredState: 'running' }),
            makeOutput('b', { desiredState: 'running' }),
        ]);
        const service = createOutputService(db, makeReadyInputState());

        // Give 'a' a prior failure (simulating an earlier crash, not a
        // deliberate stop) so we can confirm the restart resets its counter.
        await service.start('a');
        spawned[0].emit('close', 1, null);
        assert.equal(service.getStats('a').status, 'failed');
        assert.equal(service.getStats('a').failures, 1);

        const scheduled = service.restartPipelineOutputs(1, 0);
        assert.equal(scheduled, 2);

        // Immediately after scheduling, staggering means not everything has
        // spawned yet (spacing is on the order of hundreds of ms).
        await sleep(10);
        assert.ok(spawned.length < 3, 'restarts should be staggered, not instantaneous');

        await sleep(700);
        assert.equal(service.getStats('a').status, 'running');
        assert.equal(service.getStats('a').failures, 0);
        assert.equal(service.getStats('b').status, 'running');
        assert.equal(service.getStats('b').failures, 0);

        service.shutdown();
    });

    test('never spawns ffmpeg for a translation-audio output — the mixer owns those', async (t) => {
        // Regression test: restartPipelineOutputs() runs on every source-pipeline
        // reconnect (see health.ts) and previously reached startJob() for
        // translation outputs too, since only start() (not tryStart()) carried the
        // audioEncoding === 'translation' guard. That spawned a second ffmpeg
        // pushing straight to the same destination the translation mixer already
        // publishes to.
        const spawned = [];
        const createOutputService = loadOutputService(
            t,
            () => {
                const p = new FakeFfmpeg(1000 + spawned.length);
                spawned.push(p);
                return p;
            },
            { progressStallMs: 60_000 },
        );
        const db = makeMultiDb([
            makeOutput('a', { desiredState: 'running' }),
            makeOutput('mix', { desiredState: 'running', audioEncoding: 'translation' }),
        ]);
        const service = createOutputService(db, makeReadyInputState());

        const scheduled = service.restartPipelineOutputs(1, 0);
        assert.equal(
            scheduled,
            1,
            'the translation output must not count toward scheduled restarts',
        );

        await sleep(700);
        assert.equal(spawned.length, 1, 'only the plain output should have spawned ffmpeg');
        assert.equal(service.getStats('a').status, 'running');
        assert.equal(
            service.getStats('mix').status,
            'stopped',
            'translation outputs are not tracked by this service at all',
        );

        service.shutdown();
    });

    test('a nonexistent pipeline schedules nothing and does not throw', async (t) => {
        const proc = new FakeFfmpeg();
        const createOutputService = loadOutputService(t, proc);
        const db = makeMultiDb([]);
        const service = createOutputService(db, makeReadyInputState());

        const scheduled = service.restartPipelineOutputs(9999, 0);
        assert.equal(scheduled, 0);

        service.shutdown();
    });
});

function makeDiagnosticsSpy() {
    const events = [];
    return {
        events,
        event(event, fields = {}) {
            events.push({ event, ...fields });
        },
        close() {},
    };
}

describe('output diagnostics events', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/outputs')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    test('emits started, timestamp-warning, restart, exited, and retry-scheduled events across a stall/kill/retry cycle', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(t, proc);
        const service = createOutputService(db, makeReadyInputState(), diagnostics);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        proc.stderr.write(
            'Application provided invalid, non monotonically increasing dts to muxer in stream 0: non-monotonous DTS\n',
        );

        await sleep(80);

        assert.deepEqual(
            diagnostics.events.map((e) => e.event),
            [
                'ffmpeg-started',
                'ffmpeg-timestamp-warning',
                'ffmpeg-restart',
                'ffmpeg-exited',
                'ffmpeg-retry-scheduled',
            ],
        );

        const started = diagnostics.events[0];
        assert.equal(started.outputId, 'out1');
        assert.equal(started.outputName, 'YouTube');
        assert.equal(started.pid, proc.pid);
        assert.equal(started.inputProtocol, 'rtmp');
        assert.equal(started.outputProtocol, 'rtmp');

        const warning = diagnostics.events[1];
        assert.equal(warning.outputId, 'out1');
        assert.match(warning.line, /non-monotonous DTS/i);

        const restart = diagnostics.events[2];
        assert.equal(restart.outputId, 'out1');
        assert.equal(restart.reason, 'output progress stalled');
        assert.equal(restart.pid, proc.pid);

        const exited = diagnostics.events[3];
        assert.equal(exited.outputId, 'out1');
        assert.equal(exited.signal, 'SIGTERM');
        assert.equal(exited.status, 'failed');
        assert.equal(exited.watchdog, true);

        const retry = diagnostics.events[4];
        assert.equal(retry.outputId, 'out1');
        assert.equal(retry.attempt, 1);
        assert.equal(retry.delayMs, 1000);

        service.shutdown();
    });

    test('tags every event of one run with the pipeline, a run id and the pid', async (t) => {
        const proc = new FakeFfmpeg();
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(t, proc);
        const service = createOutputService(makeDb(), makeReadyInputState(), diagnostics);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\nbitrate=3200.0kbits/s\n');
        proc.stderr.write(
            'Application provided invalid, non monotonically increasing dts to muxer in stream 0: non-monotonous DTS\n',
        );
        await sleep(80);

        const runEvents = diagnostics.events.filter((e) => e.outputId === 'out1');
        assert.ok(runEvents.length >= 5);
        for (const e of runEvents) {
            assert.equal(e.pipelineId, 1, `${e.event} lacks pipelineId`);
            assert.equal(e.runId, 'out1#1', `${e.event} lacks runId`);
            assert.equal(e.pid, proc.pid, `${e.event} lacks pid`);
        }
        const exited = runEvents.find((e) => e.event === 'ffmpeg-exited');
        assert.equal(typeof exited.ranMs, 'number');

        service.shutdown();
    });

    test('a timestamp warning split across two stderr reads is still recognized', async (t) => {
        const proc = new FakeFfmpeg();
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(makeDb(), makeReadyInputState(), diagnostics);

        await service.start('out1');
        proc.stderr.write('Application provided invalid, non monoton');
        await sleep(5);
        proc.stderr.write('ically increasing dts to muxer in stream 0: non-monotonous DTS\n');
        await sleep(15);

        const warnings = diagnostics.events.filter((e) => e.event === 'ffmpeg-timestamp-warning');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].line, /^Application provided invalid.*non-monotonous DTS$/);

        service.shutdown();
    });

    test('an exit with the same stderr tail as the previous exit does not repeat it', async (t) => {
        const procs = [];
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(
            t,
            () => {
                const proc = new FakeFfmpeg(1000 + procs.length);
                procs.push(proc);
                return proc;
            },
            { progressStallMs: 60_000 },
        );
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const settle = () => new Promise((resolve) => setImmediate(resolve));
        const service = createOutputService(makeDb(), makeReadyInputState(), diagnostics);

        await service.start('out1');
        for (const [delayMs, line] of [
            [1000, 'Connection refused'],
            [2000, 'Connection refused'],
            [4000, 'Broken pipe'],
        ]) {
            procs.at(-1).stderr.write(`${line}\n`);
            await settle();
            procs.at(-1).emit('close', 1, null);
            t.mock.timers.tick(delayMs);
            await settle();
        }

        const exits = diagnostics.events.filter((e) => e.event === 'ffmpeg-exited');
        assert.equal(exits.length, 3);
        assert.equal(exits[0].stderrTail, 'Connection refused');
        assert.equal(exits[1].stderrTail, null);
        assert.equal(exits[1].stderrTailSameAsPrevious, true);
        assert.equal(exits[2].stderrTail, 'Broken pipe');
        assert.deepEqual(
            exits.map((e) => e.runId),
            ['out1#1', 'out1#2', 'out1#3'],
        );

        service.shutdown();
    });

    test('does not emit a second media-clock-recovered event when media pacing was never flagged as fast', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState(), diagnostics);

        await service.start('out1');
        proc.stdout.write('total_size=4096\nout_time_ms=1000000\n');
        await sleep(15);
        proc.stdout.write('total_size=8192\nout_time_ms=2000000\n');
        await sleep(15);

        assert.ok(
            !diagnostics.events.some((e) => e.event.startsWith('ffmpeg-media-clock')),
            'realtime-paced progress must not emit any media-clock diagnostics event',
        );

        service.shutdown();
    });

    test('does not emit a diagnostics event for unstructured stderr that matches no known warning pattern', async (t) => {
        const proc = new FakeFfmpeg();
        const db = makeDb();
        const diagnostics = makeDiagnosticsSpy();
        const createOutputService = loadOutputService(t, proc, { progressStallMs: 60_000 });
        const service = createOutputService(db, makeReadyInputState(), diagnostics);

        await service.start('out1');
        proc.stderr.write('Connection reset by peer\n');
        await sleep(15);

        assert.ok(
            !diagnostics.events.some((e) => e.event === 'ffmpeg-timestamp-warning'),
            'routine stderr noise must not be classified as a timestamp warning',
        );

        service.shutdown();
    });
    describe('timestamp warning bursts', () => {
        const audioLine = (n) =>
            `[aist#0:0/aac @ 0x5c4063a05240] timestamp discontinuity (stream id=256): -14980000, new offset= -${5160000 + n}\n`;
        const videoLine = (n) =>
            `[vist#0:1/h264 @ 0x62c407ef8200] timestamp discontinuity (stream id=257): 14980000, new offset= -${20140000 + n}\n`;
        const flood = (pairs) =>
            Array.from({ length: pairs }, (_, i) => audioLine(i) + videoLine(i)).join('');
        const eventsNamed = (diagnostics, name) =>
            diagnostics.events.filter((e) => e.event === name);

        // Real timers drive the watchdog tick and stream delivery; only Date.now
        // is controlled, so minutes of burst history can be simulated instantly.
        function startWithClock(t) {
            const clock = { now: Date.now() };
            t.mock.method(Date, 'now', () => clock.now);
            return clock;
        }

        test('folds a flood into one event per kind, then a summary and a recovery', async (t) => {
            const clock = startWithClock(t);
            const t0 = clock.now;
            const proc = new FakeFfmpeg();
            const diagnostics = makeDiagnosticsSpy();
            const createOutputService = loadOutputService(t, proc, {
                progressStallMs: 1e9,
                socketWarmupMs: 1e9,
            });
            const service = createOutputService(makeDb(), makeReadyInputState(), diagnostics);

            await service.start('out1');
            proc.stderr.write(flood(200));
            await sleep(25);

            assert.equal(
                eventsNamed(diagnostics, 'ffmpeg-timestamp-warning').length,
                2,
                '400 lines of two kinds (audio/video) log one event each, not one per line',
            );
            assert.equal(eventsNamed(diagnostics, 'ffmpeg-timestamp-warning-summary').length, 0);

            // Every gap stays under the 30 s quiet window, and the assertions
            // allow the watchdog tick to run just before or after each chunk
            // is delivered (it runs on a real timer while only Date.now is mocked).
            clock.now = t0 + 29_000;
            proc.stderr.write(flood(50));
            await sleep(25);
            assert.equal(eventsNamed(diagnostics, 'ffmpeg-timestamp-warning-summary').length, 0);

            clock.now = t0 + 58_000;
            proc.stderr.write(flood(1));
            await sleep(25);
            const summaries = eventsNamed(diagnostics, 'ffmpeg-timestamp-warning-summary');
            assert.ok(summaries.length >= 1, 'a summary follows 30 s of suppressed lines');
            for (const summary of summaries) {
                assert.equal(
                    Object.values(summary.kinds).reduce((a, b) => a + b, 0),
                    summary.count,
                );
            }
            assert.match(
                service.getStats('out1').warningReason,
                /^FFmpeg reported: .*timestamp discontinuity/,
            );

            clock.now = t0 + 58_000 + 31_000;
            await sleep(25);
            const recovered = eventsNamed(diagnostics, 'ffmpeg-timestamp-recovered');
            assert.equal(recovered.length, 1);
            assert.equal(recovered[0].durationMs, 58_000);
            assert.equal(recovered[0].count, 502);
            assert.equal(
                eventsNamed(diagnostics, 'ffmpeg-timestamp-warning-summary').reduce(
                    (total, summary) => total + summary.count,
                    0,
                ),
                500,
                'every suppressed line (502 total minus the 2 logged individually) is counted',
            );
            const after = service.getStats('out1');
            assert.equal(after.warningReason, null);

            service.shutdown();
        });

        test('decode errors alone are logged, shown on the card only once sustained', async (t) => {
            const clock = startWithClock(t);
            const proc = new FakeFfmpeg();
            const diagnostics = makeDiagnosticsSpy();
            const createOutputService = loadOutputService(t, proc, {
                progressStallMs: 1e9,
                socketWarmupMs: 1e9,
            });
            const db = makeDb();
            const service = createOutputService(db, makeReadyInputState(), diagnostics);

            await service.start('out1');
            proc.stderr.write(
                '[h264 @ 0x580060534940] non-existing PPS 0 referenced\n[h264 @ 0x580060534940] decode_slice_header error\n',
            );
            await sleep(25);

            assert.equal(eventsNamed(diagnostics, 'ffmpeg-timestamp-warning').length, 2);
            // Brief join noise is not shown on the output card...
            assert.equal(service.getStats('out1').warningReason, null);
            assert.equal(db.errorRecords.length, 0);

            // ...but a burst that persists past the grace period is.
            clock.now += 11_000;
            proc.stderr.write('[h264 @ 0x580060534940] decode_slice_header error\n');
            await sleep(25);
            assert.match(service.getStats('out1').warningReason, /decode_slice_header error/);

            // The finished burst is recorded in the output's own Error History.
            clock.now += 31_000;
            await sleep(40);
            assert.equal(db.errorRecords.length, 1);
            assert.equal(db.errorRecords[0].kind, 'warning');
            assert.match(
                db.errorRecords[0].message,
                /decode warnings stopped.*First: .*non-existing PPS/,
            );
            assert.equal(db.lastErrorKind, null, 'a warning is not the output error');

            service.shutdown();
        });

        test('brief join-noise bursts are never written to the output History', async (t) => {
            const clock = startWithClock(t);
            const proc = new FakeFfmpeg();
            const diagnostics = makeDiagnosticsSpy();
            const createOutputService = loadOutputService(t, proc, {
                progressStallMs: 1e9,
                socketWarmupMs: 1e9,
            });
            const db = makeDb();
            const service = createOutputService(db, makeReadyInputState(), diagnostics);
            const noise = '[h264 @ 0x580060534940] non-existing PPS 0 referenced\n';

            await service.start('out1');
            proc.stderr.write(noise);
            await sleep(25);
            clock.now += 31_000;
            await sleep(40);
            assert.equal(eventsNamed(diagnostics, 'ffmpeg-timestamp-recovered').length, 1);

            // Also when the burst is cut short by the output being stopped.
            proc.stderr.write(noise);
            await sleep(25);
            await service.stopAndWait('out1');

            assert.deepEqual(
                db.errorRecords.map((r) => r.kind),
                ['stopped'],
            );

            service.shutdown();
        });

        test('a timestamp burst is recorded once, at its end, in the output Error History', async (t) => {
            const clock = startWithClock(t);
            const proc = new FakeFfmpeg();
            const createOutputService = loadOutputService(t, proc, {
                progressStallMs: 1e9,
                socketWarmupMs: 1e9,
            });
            const db = makeDb();
            const service = createOutputService(db, makeReadyInputState(), makeDiagnosticsSpy());

            await service.start('out1');
            proc.stderr.write(flood(50));
            await sleep(25);
            assert.equal(db.errorRecords.length, 0, 'nothing while the burst is still open');

            clock.now += 31_000;
            await sleep(40);
            assert.deepEqual(
                db.errorRecords.map((r) => r.kind),
                ['warning'],
            );
            assert.match(db.errorRecords[0].message, /timestamp warnings stopped.*100 warnings/);

            service.shutdown();
        });

        test('timestamp bursts reach the output Error History at most once per interval', async (t) => {
            const clock = startWithClock(t);
            const proc = new FakeFfmpeg();
            const createOutputService = loadOutputService(t, proc, {
                progressStallMs: 1e9,
                socketWarmupMs: 1e9,
            });
            const db = makeDb();
            const service = createOutputService(db, makeReadyInputState(), makeDiagnosticsSpy());

            await service.start('out1');
            proc.stderr.write(flood(5));
            await sleep(25);
            clock.now += 31_000;
            await sleep(40);
            assert.equal(db.errorRecords.length, 1);

            // A flapping input: another burst inside the interval writes nothing.
            proc.stderr.write(flood(5));
            await sleep(25);
            clock.now += 31_000;
            await sleep(40);
            assert.equal(db.errorRecords.length, 1);

            // After the interval a new burst is recorded again.
            clock.now += 10 * 60_000;
            proc.stderr.write(flood(5));
            await sleep(25);
            clock.now += 31_000;
            await sleep(40);
            assert.equal(db.errorRecords.length, 2);

            service.shutdown();
        });

        test('a timestamp burst cut short by an output stop is recorded before the stop marker', async (t) => {
            startWithClock(t);
            const proc = new FakeFfmpeg();
            const createOutputService = loadOutputService(t, proc, {
                progressStallMs: 1e9,
                socketWarmupMs: 1e9,
            });
            const db = makeDb();
            const service = createOutputService(db, makeReadyInputState(), makeDiagnosticsSpy());

            await service.start('out1');
            proc.stderr.write(flood(5));
            await sleep(25);
            await service.stopAndWait('out1');

            assert.deepEqual(
                db.errorRecords.map((r) => r.kind),
                ['warning', 'stopped'],
            );
            assert.match(db.errorRecords[0].message, /ended with ffmpeg exit/);

            service.shutdown();
        });

        test('records an open burst on the ffmpeg-exited event', async (t) => {
            startWithClock(t);
            const proc = new FakeFfmpeg();
            const diagnostics = makeDiagnosticsSpy();
            const createOutputService = loadOutputService(t, proc, {
                progressStallMs: 1e9,
                socketWarmupMs: 1e9,
            });
            const service = createOutputService(makeDb(), makeReadyInputState(), diagnostics);

            await service.start('out1');
            proc.stderr.write(flood(1));
            await sleep(25);
            await service.stopAndWait('out1');

            const exited = eventsNamed(diagnostics, 'ffmpeg-exited')[0];
            assert.deepEqual(exited.timestampBurst, { durationMs: 0, count: 2 });

            service.shutdown();
        });
    });
});

// ── Shared renditions ──────────────────────────────────────────────────────
describe('shared renditions', () => {
    const { buildFfmpegArgs } = require('../src/utils/ffmpeg');
    const RENDITION_URL = 'rtmp://127.0.0.1:1935/internal/r1_720p_a1';
    const YOUTUBE = 'rtmp://youtube.example/live/key';
    const TWITCH = 'rtmp://twitch.example/live/key';

    beforeEach(() => {
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete require.cache[require.resolve('../src/services/outputs')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    // A pipeline with a 720p/track-1 rendition (1-1) and two outputs sharing it
    // (1-2, 1-3). Rows can be replaced to build other shapes.
    function makeFleetDb(rows) {
        const outputs = new Map();
        const add = (o) =>
            outputs.set(o.id, {
                pipelineId: 1,
                seq: 1,
                desiredState: 'running',
                videoEncoding: 'copy',
                audioEncoding: 'copy',
                translation: null,
                lastError: null,
                ...o,
            });
        for (const row of rows ?? [
            {
                id: '1-1',
                name: 'Shared encode 720p · track 1',
                url: RENDITION_URL,
                videoEncoding: '720p',
                audioEncoding: '1',
            },
            { id: '1-2', name: 'YouTube', url: YOUTUBE, videoEncoding: '720p', audioEncoding: '1' },
            { id: '1-3', name: 'Twitch', url: TWITCH, videoEncoding: '720p', audioEncoding: '1' },
        ]) {
            add(row);
        }
        return {
            outputs,
            errorRecords: [],
            appendPipelineLog() {
                throw new Error('outputs must not write to the pipeline History');
            },
            getPipeline: (id) =>
                id === 1 ? { id: 1, name: 'Live', streamKey: 'stream-key', streamKeyId: 1 } : null,
            getOutput: (id) => outputs.get(id) ?? null,
            listOutputsForPipeline: () => [...outputs.values()],
            setOutputLastError(id, message, kind) {
                this.errorRecords.push({ id, message, kind });
            },
            recordsFor(id, kind) {
                return this.errorRecords.filter((r) => r.id === id && (!kind || r.kind === kind));
            },
        };
    }

    // Every spawn is recorded; each process exits when killed, like a real one.
    function makeFleet(t, options = {}) {
        const spawned = [];
        let pid = 100;
        const factory = (args) => {
            const proc = new FakeFfmpeg(pid++);
            spawned.push({ args, proc, dest: args[args.length - 1] });
            return proc;
        };
        const createOutputService = loadOutputService(t, factory, {
            progressStallMs: 1e9,
            socketWarmupMs: 1e9,
            ...options,
        });
        return {
            spawned,
            createOutputService,
            procFor: (dest) => spawned.findLast((s) => s.dest === dest)?.proc,
            spawnsTo: (dest) => spawned.filter((s) => s.dest === dest),
        };
    }

    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const markReady = (proc) => proc.stdout.write('total_size=4096\nout_time_ms=1000000\n');
    const crashRecords = (db, id) => db.recordsFor(id, 'crash');

    describe('arguments', () => {
        test('outputs that are not shared spawn with byte-identical arguments', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb([
                { id: '1-1', name: 'plain', url: YOUTUBE },
                {
                    id: '1-2',
                    name: 'multi',
                    url: 'srt://dest.example:9000?mode=caller',
                    audioEncoding: '0,1',
                },
            ]);
            const service = fleet.createOutputService(db, makeReadyInputState());
            const srtService = fleet.createOutputService(db, makeReadyInputState({ srt: true }));

            await service.start('1-1');
            await srtService.start('1-2');

            assert.deepEqual(fleet.spawned[0].args, [
                '-nostats',
                '-loglevel',
                'warning',
                '-stats_period',
                '3',
                '-fflags',
                '+discardcorrupt',
                '-err_detect',
                'crccheck+bitstream',
                '-rw_timeout',
                '600000000',
                '-i',
                'rtmp://127.0.0.1:1935/live/stream-key',
                '-progress',
                'pipe:1',
                '-map',
                '0:v:0?',
                '-map',
                '0:a:0?',
                '-c:v',
                'copy',
                '-c:a',
                'copy',
                '-f',
                'flv',
                // The output-side bound on a blocked destination (OUTPUT_IO_TIMEOUT_US).
                '-rw_timeout',
                '10000000',
                'rtmp://youtube.example/live/key',
            ]);
            assert.deepEqual(fleet.spawned[1].args, [
                '-nostats',
                '-loglevel',
                'warning',
                '-stats_period',
                '3',
                '-fflags',
                '+discardcorrupt',
                '-err_detect',
                'crccheck+bitstream',
                '-rw_timeout',
                '600000000',
                '-i',
                'srt://127.0.0.1:10080?streamid=stream-key',
                '-progress',
                'pipe:1',
                '-map',
                '0:v:0',
                '-map',
                '0:a:0',
                '-map',
                '0:a:1',
                '-c:v',
                'copy',
                '-af',
                'aresample=async=1:first_pts=0',
                '-c:a',
                'aac',
                '-b:a',
                '128k',
                '-ac',
                '2',
                '-ar',
                '48000',
                '-f',
                'mpegts',
                'srt://dest.example:9000?mode=caller',
            ]);

            service.shutdown();
            srtService.shutdown();
        });

        test('a translation output is never started by this service, shared recipe or not', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb([
                {
                    id: '1-1',
                    name: 'tr',
                    url: YOUTUBE,
                    videoEncoding: '720p',
                    audioEncoding: 'translation',
                },
            ]);
            const service = fleet.createOutputService(db, makeReadyInputState());

            await service.start('1-1');

            assert.equal(fleet.spawned.length, 0);
            service.shutdown();
        });

        test('a shared output copies the rendition stream and nothing else', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();

            await service.start('1-2');

            assert.deepEqual(
                fleet.spawnsTo(YOUTUBE)[0].args,
                buildFfmpegArgs(RENDITION_URL, YOUTUBE, 'copy', 'copy'),
            );
            assert.equal(
                fleet.spawnsTo(YOUTUBE)[0].args[fleet.spawnsTo(YOUTUBE)[0].args.indexOf('-i') + 1],
                RENDITION_URL,
            );
            service.shutdown();
        });

        test('a shared output to an SRT destination copies the rendition into mpegts', async (t) => {
            const fleet = makeFleet(t);
            const srtDest = 'srt://dest.example:9000?mode=caller';
            const db = makeFleetDb([
                {
                    id: '1-1',
                    name: 'r',
                    url: RENDITION_URL,
                    videoEncoding: '720p',
                    audioEncoding: '1',
                },
                { id: '1-2', name: 'srt', url: srtDest, videoEncoding: '720p', audioEncoding: '1' },
                {
                    id: '1-3',
                    name: 'other',
                    url: YOUTUBE,
                    videoEncoding: '720p',
                    audioEncoding: '1',
                },
            ]);
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();

            await service.start('1-2');

            assert.deepEqual(
                fleet.spawnsTo(srtDest)[0].args,
                buildFfmpegArgs(RENDITION_URL, srtDest, 'copy', 'copy'),
            );
            service.shutdown();
        });

        test('the rendition itself takes the existing path: pull the input, encode, publish', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState({ srt: true }));

            await service.start('1-1');

            const args = fleet.spawnsTo(RENDITION_URL)[0].args;
            assert.deepEqual(
                args,
                buildFfmpegArgs(
                    'srt://127.0.0.1:10080?streamid=stream-key',
                    RENDITION_URL,
                    '1',
                    '720p',
                ),
            );
            assert.ok(args.includes('-readrate'), 'SRT origin to RTMP is paced');
            assert.ok(args.includes('aresample=async=1:first_pts=0'));
            service.shutdown();
        });
    });

    describe('readiness', () => {
        test('a shared output waits for its rendition and re-checks every second', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());
            t.mock.timers.enable({ apis: ['setTimeout'] });

            await service.start('1-2');
            assert.equal(fleet.spawned.length, 0, 'no rendition yet: nothing to pull');
            t.mock.timers.tick(1000);
            await flush();
            assert.equal(fleet.spawned.length, 0);

            // Rendition process is up but has not written anything: still not ready.
            await service.start('1-1');
            assert.equal(fleet.spawned.length, 1);
            t.mock.timers.tick(1000);
            await flush();
            assert.equal(fleet.spawnsTo(YOUTUBE).length, 0);
            assert.equal(service.getStats('1-1').ready, false);

            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            assert.equal(service.getStats('1-1').ready, true);
            t.mock.timers.tick(999);
            await flush();
            assert.equal(fleet.spawnsTo(YOUTUBE).length, 0, 'next re-check is 1 s after the last');
            t.mock.timers.tick(1);
            await flush();
            assert.equal(fleet.spawnsTo(YOUTUBE).length, 1);
            service.shutdown();
        });

        test('total_size=0 is not ready', async (t) => {
            const fleet = makeFleet(t);
            const service = fleet.createOutputService(makeFleetDb(), makeReadyInputState());
            await service.start('1-1');

            fleet.procFor(RENDITION_URL).stdout.write('total_size=0\n');
            await flush();

            assert.equal(service.getStats('1-1').ready, false);
            service.shutdown();
        });

        test('a shared output does not start while the input is down, even with the rendition running', async (t) => {
            const fleet = makeFleet(t);
            let ready = true;
            const inputState = { ...makeReadyInputState(), isReady: () => ready };
            const service = fleet.createOutputService(makeFleetDb(), inputState);
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            ready = false;

            await service.start('1-2');

            assert.equal(fleet.spawnsTo(YOUTUBE).length, 0);
            service.shutdown();
        });

        test('direct outputs still gate on the input, with the 5 s re-check', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb([{ id: '1-1', name: 'plain', url: YOUTUBE }]);
            let ready = false;
            const service = fleet.createOutputService(db, {
                ...makeReadyInputState(),
                isReady: () => ready,
            });
            t.mock.timers.enable({ apis: ['setTimeout'] });

            await service.start('1-1');
            ready = true;
            t.mock.timers.tick(4999);
            await flush();
            assert.equal(fleet.spawned.length, 0);
            t.mock.timers.tick(1);
            await flush();
            assert.equal(fleet.spawned.length, 1);
            service.shutdown();
        });
    });

    describe('rendition failure', () => {
        async function runningFleet(t, options) {
            const fleet = makeFleet(t, options);
            const db = makeFleetDb([
                {
                    id: '1-1',
                    name: 'Shared encode 720p · track 1',
                    url: RENDITION_URL,
                    videoEncoding: '720p',
                    audioEncoding: '1',
                },
                {
                    id: '1-2',
                    name: 'YouTube',
                    url: YOUTUBE,
                    videoEncoding: '720p',
                    audioEncoding: '1',
                },
                {
                    id: '1-3',
                    name: 'Twitch',
                    url: TWITCH,
                    videoEncoding: '720p',
                    audioEncoding: '1',
                },
                { id: '1-4', name: 'Direct', url: 'rtmp://direct.example/live/k' },
                {
                    id: '1-5',
                    name: 'Other recipe',
                    url: 'rtmp://other.example/live/k',
                    videoEncoding: 'copy',
                    audioEncoding: '0',
                },
                {
                    id: '1-7',
                    name: 'Other recipe too',
                    url: 'rtmp://other2.example/live/k',
                    videoEncoding: 'copy',
                    audioEncoding: '0',
                },
                {
                    id: '1-6',
                    name: 'Other rendition',
                    url: 'rtmp://127.0.0.1:1935/internal/r1_copy_a0',
                    videoEncoding: 'copy',
                    audioEncoding: '0',
                },
            ]);
            const diagnostics = makeDiagnosticsSpy();
            const service = fleet.createOutputService(db, makeReadyInputState(), diagnostics);
            await service.start('1-1');
            await service.start('1-6');
            markReady(fleet.procFor(RENDITION_URL));
            markReady(fleet.procFor('rtmp://127.0.0.1:1935/internal/r1_copy_a0'));
            await flush();
            for (const id of ['1-2', '1-3', '1-4', '1-5', '1-7']) await service.start(id);
            assert.equal(service.getStats('1-2').status, 'running');
            assert.equal(service.getStats('1-5').status, 'running');
            return { fleet, db, diagnostics, service };
        }

        test('an unexpected exit restarts every running dependent, with one explanatory record each', async (t) => {
            const { fleet, db, diagnostics, service } = await runningFleet(t);
            const rendition = fleet.procFor(RENDITION_URL);

            rendition.stderr.write('Connection reset by peer\n');
            rendition.emit('exit', 1, null);
            rendition.emit('close', 1, null);
            await flush();
            await flush();

            for (const id of ['1-2', '1-3']) {
                const proc = fleet.procFor(id === '1-2' ? YOUTUBE : TWITCH);
                assert.deepEqual(proc.killSignals, ['SIGTERM'], id);
                const records = crashRecords(db, id);
                assert.equal(records.length, 1, `${id}: no second crash from its own kill`);
                assert.match(
                    records[0].message,
                    /^Shared encode 720p · track 1 failed: exit=1\nConnection reset by peer/,
                );
                assert.equal(service.getStats(id).status, 'failed');
                assert.equal(service.getStats(id).failures, 1);
            }
            // The rendition's own record is the usual one; unrelated outputs are untouched.
            assert.equal(crashRecords(db, '1-1').length, 1);
            assert.match(crashRecords(db, '1-1')[0].message, /^exit=1/);
            for (const [id, dest] of [
                ['1-4', 'rtmp://direct.example/live/k'],
                ['1-5', 'rtmp://other.example/live/k'],
            ]) {
                assert.deepEqual(fleet.procFor(dest).killSignals, [], id);
                assert.equal(service.getStats(id).status, 'running', id);
            }
            assert.deepEqual(
                fleet.procFor('rtmp://127.0.0.1:1935/internal/r1_copy_a0').killSignals,
                [],
            );

            const event = diagnostics.events.find(
                (e) => e.event === 'rendition-dependents-restarted',
            );
            assert.deepEqual(event.outputIds.sort(), ['1-2', '1-3']);
            assert.equal(event.renditionId, '1-1');
            assert.match(event.reason, /exit=1/);
            service.shutdown();
        });

        test('a dependent that was only waiting to start also gets the record', async (t) => {
            const { fleet, db, service } = await runningFleet(t);
            await service.stopAndWait('1-3');
            db.outputs.get('1-3').desiredState = 'running'; // desired running, not running
            db.errorRecords.length = 0;
            const rendition = fleet.procFor(RENDITION_URL);

            rendition.emit('exit', 1, null);
            rendition.emit('close', 1, null);
            await flush();

            assert.equal(crashRecords(db, '1-3').length, 1);
            assert.equal(
                fleet.procFor(TWITCH).killSignals.length,
                1,
                'only the earlier stop signal',
            );
            service.shutdown();
        });

        test('a dependent whose desired state is stopped gets nothing', async (t) => {
            const { fleet, db, service } = await runningFleet(t);
            await service.stopAndWait('1-3');
            db.outputs.get('1-3').desiredState = 'stopped';
            db.errorRecords.length = 0;

            const rendition = fleet.procFor(RENDITION_URL);
            rendition.emit('exit', 1, null);
            rendition.emit('close', 1, null);
            await flush();

            assert.equal(db.recordsFor('1-3').length, 0);
            service.shutdown();
        });

        test('a deliberate stop of the rendition leaves its dependents alone', async (t) => {
            const { fleet, db, service } = await runningFleet(t);
            db.errorRecords.length = 0;

            await service.stopAndWait('1-1');
            await flush();

            assert.deepEqual(fleet.procFor(YOUTUBE).killSignals, []);
            assert.deepEqual(fleet.procFor(TWITCH).killSignals, []);
            assert.equal(db.recordsFor('1-2').length, 0);
            assert.equal(db.recordsFor('1-3').length, 0);
            service.shutdown();
        });

        test('a watchdog-killed rendition explains the watchdog reason to its dependents', async (t) => {
            const fleet = makeFleet(t, { progressStallMs: 20 });
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            await service.start('1-2');
            fleet.procFor(YOUTUBE).stdout.write('total_size=10\n');
            // The rendition now stops making output progress; the dependent keeps going.
            const keepAlive = setInterval(
                () => fleet.procFor(YOUTUBE)?.stdout.write(`total_size=${Date.now()}\n`),
                5,
            );
            t.after(() => clearInterval(keepAlive));

            await sleep(120);

            assert.deepEqual(fleet.procFor(RENDITION_URL).killSignals, ['SIGTERM']);
            const records = crashRecords(db, '1-2');
            assert.equal(records.length, 1);
            assert.match(
                records[0].message,
                /^Shared encode 720p · track 1 failed: watchdog: output progress stalled/,
            );
            service.shutdown();
        });
    });

    describe('watchdog and limits', () => {
        test('the watchdog skips a shared output while its rendition is not ready', async (t) => {
            const fleet = makeFleet(t, { progressStallMs: 20 });
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            await service.start('1-2');
            fleet.procFor(YOUTUBE).stdout.write('total_size=10\n');
            // Rendition goes away deliberately: not ready from now on.
            await service.stopAndWait('1-1');
            db.outputs.get('1-1').desiredState = 'stopped';

            await sleep(120);

            assert.equal(service.getStats('1-1').ready, false);
            assert.deepEqual(fleet.procFor(YOUTUBE).killSignals, [], 'not killed for stalling');
            assert.equal(service.getStats('1-2').status, 'running');
            service.shutdown();
        });

        test('control: the same stall with a ready rendition does kill the shared output', async (t) => {
            const fleet = makeFleet(t, { progressStallMs: 20 });
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            const keepAlive = setInterval(
                () => fleet.procFor(RENDITION_URL)?.stdout.write(`total_size=${Date.now()}\n`),
                5,
            );
            t.after(() => clearInterval(keepAlive));
            await flush();
            await service.start('1-2');
            fleet.procFor(YOUTUBE).stdout.write('total_size=10\n');

            await sleep(120);

            assert.deepEqual(fleet.procFor(YOUTUBE).killSignals, ['SIGTERM']);
            service.shutdown();
        });

        test('the watchdog still skips a shared output while the input is down', async (t) => {
            const fleet = makeFleet(t, { progressStallMs: 20 });
            let ready = true;
            const service = fleet.createOutputService(makeFleetDb(), {
                ...makeReadyInputState(),
                isReady: () => ready,
            });
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            const keepAlive = setInterval(
                () => fleet.procFor(RENDITION_URL)?.stdout.write(`total_size=${Date.now()}\n`),
                5,
            );
            t.after(() => clearInterval(keepAlive));
            await flush();
            await service.start('1-2');
            fleet.procFor(YOUTUBE).stdout.write('total_size=10\n');
            ready = false;

            await sleep(120);

            assert.deepEqual(fleet.procFor(YOUTUBE).killSignals, []);
            service.shutdown();
        });

        test('the memory limit of a shared output is the copy limit; the rendition keeps its preset limit', async (t) => {
            const fleet = makeFleet(t, { memoryLimitMb: 200 });
            const db = makeFleetDb();
            const originalReadFileSync = fs.readFileSync;
            t.mock.method(fs, 'readFileSync', (filePath, ...rest) => {
                if (/^\/proc\/\d+\/status$/.test(String(filePath))) return 'VmRSS:  100000 kB\n';
                return originalReadFileSync(filePath, ...rest);
            });
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            await service.start('1-2');

            await sleep(60);

            assert.equal(service.getStats('1-2').memoryLimitBytes, 200 * 1024 * 1024);
            assert.ok(
                service.getStats('1-1').memoryLimitBytes > 200 * 1024 * 1024,
                'the 720p preset limit applies to the encode',
            );
            service.shutdown();
        });
    });

    describe('restart', () => {
        test('returns false for an output that is not running', async (t) => {
            const fleet = makeFleet(t);
            const service = fleet.createOutputService(makeFleetDb(), makeReadyInputState());

            assert.equal(service.restart('1-2'), false);
            assert.equal(service.restart('nope'), false);
            service.shutdown();
        });

        test('restarting an ordinary output stops it with a "Restarted by user" record and starts it again', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb([{ id: '1-1', name: 'plain', url: YOUTUBE }]);
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            t.mock.timers.enable({ apis: ['setTimeout'] });

            assert.equal(service.restart('1-1'), true);
            await flush();

            assert.deepEqual(fleet.spawnsTo(YOUTUBE)[0].proc.killSignals, ['SIGTERM']);
            assert.equal(db.recordsFor('1-1', 'crash').length, 0);
            const stopped = db.recordsFor('1-1', 'stopped');
            assert.equal(stopped.length, 1);
            assert.match(stopped[0].message, /^Restarted by user/);
            assert.equal(service.getStats('1-1').failures, 0);

            t.mock.timers.tick(0);
            await flush();
            assert.equal(fleet.spawnsTo(YOUTUBE).length, 2, 'respawned');
            assert.equal(service.getStats('1-1').status, 'running');
            service.shutdown();
        });

        test('restarting a rendition restarts its dependents first, none of it counted as a failure', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            await service.start('1-2');
            await service.start('1-3');
            const order = [];
            for (const [id, dest] of [
                ['1-1', RENDITION_URL],
                ['1-2', YOUTUBE],
                ['1-3', TWITCH],
            ]) {
                const proc = fleet.procFor(dest);
                const kill = proc.kill.bind(proc);
                proc.kill = (signal) => {
                    order.push(id);
                    return kill(signal);
                };
            }
            t.mock.timers.enable({ apis: ['setTimeout'] });

            assert.equal(service.restart('1-1'), true);
            await flush();
            await flush();

            assert.deepEqual(order.slice(0, 2).sort(), ['1-2', '1-3']);
            assert.equal(order[2], '1-1', 'the encode goes last so dependents see a stop, not EOF');
            for (const id of ['1-2', '1-3']) {
                assert.equal(db.recordsFor(id, 'crash').length, 0, id);
                const stopped = db.recordsFor(id, 'stopped');
                assert.equal(stopped.length, 1, id);
                assert.match(stopped[0].message, /^Shared encode restarted by user/);
                assert.equal(service.getStats(id).failures, 0, id);
            }
            const own = db.recordsFor('1-1', 'stopped');
            assert.equal(own.length, 1);
            assert.match(own[0].message, /^Restarted by user/);
            assert.equal(service.getStats('1-1').failures, 0);

            // The rendition comes back first; dependents wait for it to be ready.
            t.mock.timers.tick(0);
            await flush();
            assert.equal(fleet.spawnsTo(RENDITION_URL).length, 2);
            t.mock.timers.tick(0);
            t.mock.timers.tick(1000);
            await flush();
            assert.equal(fleet.spawnsTo(YOUTUBE).length, 1, 'still waiting for the new encode');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            t.mock.timers.tick(1000);
            await flush();
            assert.equal(fleet.spawnsTo(YOUTUBE).length, 2);
            assert.equal(fleet.spawnsTo(TWITCH).length, 2);
            service.shutdown();
        });
    });

    describe('restartRunningOutputs', () => {
        const WHY = 'input format changed from h264 1920x1080 to h264 1280x720';
        const OTHER = 'rtmp://other.example/live/key';

        test('restarts the running outputs one stagger apart, recorded as a deliberate stop with the reason', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb([
                { id: '1-1', name: 'a', url: YOUTUBE },
                { id: '1-2', name: 'b', url: TWITCH },
                { id: '1-3', name: 'c', url: OTHER, desiredState: 'stopped' },
            ]);
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            await service.start('1-2');
            t.mock.timers.enable({ apis: ['setTimeout'] });

            assert.equal(service.restartRunningOutputs(1, WHY, Date.now() + 60_000), 2);
            t.mock.timers.tick(0);
            await flush();
            assert.deepEqual(fleet.procFor(YOUTUBE).killSignals, ['SIGTERM']);
            assert.deepEqual(fleet.procFor(TWITCH).killSignals, [], 'the second waits its turn');
            t.mock.timers.tick(200);
            await flush();
            assert.deepEqual(fleet.procFor(TWITCH).killSignals, ['SIGTERM']);

            for (const id of ['1-1', '1-2']) {
                assert.equal(db.recordsFor(id, 'crash').length, 0, id);
                const stopped = db.recordsFor(id, 'stopped');
                assert.equal(stopped.length, 1, id);
                assert.equal(stopped[0].message.split('\n')[0], `Restarted: ${WHY}`);
            }
            assert.equal(db.recordsFor('1-3', 'stopped').length, 0);
            service.shutdown();
        });

        test('leaves outputs that started after the new publisher connected', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb([{ id: '1-1', name: 'a', url: YOUTUBE }]);
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            t.mock.timers.enable({ apis: ['setTimeout'] });

            assert.equal(service.restartRunningOutputs(1, WHY, 0), 0);
            t.mock.timers.tick(1000);
            await flush();
            assert.deepEqual(fleet.procFor(YOUTUBE).killSignals, []);
            service.shutdown();
        });

        test('restarts a shared encode once, with its readers, and not the readers separately', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            await service.start('1-2');
            await service.start('1-3');
            t.mock.timers.enable({ apis: ['setTimeout'] });

            assert.equal(service.restartRunningOutputs(1, WHY, Date.now() + 60_000), 1);
            t.mock.timers.tick(0);
            await flush();
            await flush();
            for (const id of ['1-1', '1-2', '1-3']) {
                assert.equal(db.recordsFor(id, 'stopped').length, 1, id);
                assert.equal(db.recordsFor(id, 'crash').length, 0, id);
            }
            assert.match(db.recordsFor('1-1', 'stopped')[0].message, /^Restarted: input format/);
            assert.match(db.recordsFor('1-2', 'stopped')[0].message, /^Shared encode restarted/);
            service.shutdown();
        });
    });

    describe('stats and diagnostics', () => {
        test('getStats tells renditions from outputs and links shared outputs to their rendition', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());

            assert.equal(service.getStats('1-1').role, 'rendition');
            assert.equal(service.getStats('1-2').role, 'output');
            assert.equal(service.getStats('1-2').renditionId, null);
            assert.equal(service.getStats('1-2').ready, null);

            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            await service.start('1-2');

            assert.equal(service.getStats('1-1').ready, true);
            assert.equal(service.getStats('1-2').renditionId, '1-1');
            await service.stopAndWait('1-2');
            assert.equal(service.getStats('1-2').renditionId, null, 'only while it pulls one');
            service.shutdown();
        });

        test('started, exited and restart events carry role and renditionId', async (t) => {
            const fleet = makeFleet(t, { progressStallMs: 20 });
            const db = makeFleetDb();
            const diagnostics = makeDiagnosticsSpy();
            const service = fleet.createOutputService(db, makeReadyInputState(), diagnostics);
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            await service.start('1-2');
            const keepAlive = setInterval(
                () => fleet.procFor(RENDITION_URL)?.stdout.write(`total_size=${Date.now()}\n`),
                5,
            );
            t.after(() => clearInterval(keepAlive));
            fleet.procFor(YOUTUBE).stdout.write('total_size=10\n');

            await sleep(120);

            const started = diagnostics.events.filter((e) => e.event === 'ffmpeg-started');
            assert.deepEqual(
                started.map((e) => [e.outputId, e.role, e.renditionId]),
                [
                    ['1-1', 'rendition', undefined],
                    ['1-2', 'output', '1-1'],
                ],
            );
            const restart = diagnostics.events.find((e) => e.event === 'ffmpeg-restart');
            assert.equal(restart.outputId, '1-2');
            assert.equal(restart.role, 'output');
            assert.equal(restart.renditionId, '1-1');
            const exited = diagnostics.events.find(
                (e) => e.event === 'ffmpeg-exited' && e.outputId === '1-2',
            );
            assert.equal(exited.role, 'output');
            assert.equal(exited.renditionId, '1-1');
            service.shutdown();
        });
    });
    describe('when to share', () => {
        const SOLO = [
            { id: '1-2', name: 'YouTube', url: YOUTUBE, videoEncoding: '720p', audioEncoding: '1' },
        ];

        test('a single output with a recipe pulls the input directly, with byte-identical arguments', async (t) => {
            const fleet = makeFleet(t);
            const service = fleet.createOutputService(makeFleetDb(SOLO), makeReadyInputState());

            await service.start('1-2');

            assert.deepEqual(
                fleet.spawnsTo(YOUTUBE)[0].args,
                buildFfmpegArgs('rtmp://127.0.0.1:1935/live/stream-key', YOUTUBE, '1', '720p'),
            );
            assert.equal(service.getStats('1-2').renditionId, null);
            service.shutdown();
        });

        test('a single output does not wait for a rendition and uses the 5 s input re-check', async (t) => {
            const fleet = makeFleet(t);
            let ready = false;
            const service = fleet.createOutputService(makeFleetDb(SOLO), {
                ...makeReadyInputState(),
                isReady: () => ready,
            });
            t.mock.timers.enable({ apis: ['setTimeout'] });

            await service.start('1-2');
            ready = true;
            t.mock.timers.tick(1000);
            await flush();
            assert.equal(fleet.spawned.length, 0);
            t.mock.timers.tick(4000);
            await flush();
            assert.equal(fleet.spawnsTo(YOUTUBE).length, 1);
            service.shutdown();
        });

        test('an output that started direct keeps running direct when a second one is configured; the new one shares', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb(SOLO);
            const service = fleet.createOutputService(db, makeReadyInputState());
            await service.start('1-2');
            const direct = fleet.procFor(YOUTUBE);

            // Second output with the same recipe, and the encode the reconciler adds.
            db.outputs.set('1-3', {
                ...db.outputs.get('1-2'),
                id: '1-3',
                name: 'Twitch',
                url: TWITCH,
                desiredState: 'stopped',
            });
            db.outputs.set('1-4', {
                ...db.outputs.get('1-2'),
                id: '1-4',
                name: 'Shared encode 720p · track 1',
                url: RENDITION_URL,
            });
            await service.start('1-4');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            db.outputs.get('1-3').desiredState = 'running';
            await service.start('1-3');

            assert.deepEqual(direct.killSignals, [], 'the first output was not touched');
            assert.equal(service.getStats('1-2').status, 'running');
            assert.equal(service.getStats('1-2').renditionId, null);
            assert.equal(service.getStats('1-3').renditionId, '1-4');
            assert.deepEqual(
                fleet.spawnsTo(TWITCH)[0].args,
                buildFfmpegArgs(RENDITION_URL, TWITCH, 'copy', 'copy'),
            );
            assert.equal(service.readersOf('1-4'), 1, 'only the output that reads it counts');
            service.shutdown();
        });

        test('an output waiting for the encode goes direct if it stops being shared', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());
            t.mock.timers.enable({ apis: ['setTimeout'] });
            await service.start('1-2'); // waits: the encode is not running
            assert.equal(fleet.spawned.length, 0);

            db.outputs.delete('1-3'); // its only partner goes away
            t.mock.timers.tick(1000);
            await flush();

            assert.equal(fleet.spawnsTo(YOUTUBE).length, 1);
            assert.deepEqual(
                fleet.spawnsTo(YOUTUBE)[0].args,
                buildFfmpegArgs('rtmp://127.0.0.1:1935/live/stream-key', YOUTUBE, '1', '720p'),
            );
            service.shutdown();
        });

        test('readersOf counts the running outputs reading a rendition and drops when they stop', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());
            assert.equal(service.readersOf('1-1'), 0);
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            await service.start('1-2');
            await service.start('1-3');
            assert.equal(service.readersOf('1-1'), 2);

            await service.stopAndWait('1-2');
            assert.equal(service.readersOf('1-1'), 1);
            await service.stopAndWait('1-3');
            assert.equal(service.readersOf('1-1'), 0);
            assert.equal(service.readersOf('nope'), 0);
            service.shutdown();
        });

        test('a rendition failure restarts the output reading it, never one that runs direct', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb(); // 1-1 encode, 1-2 and 1-3 share it
            const twitch = db.outputs.get('1-3');
            const service = fleet.createOutputService(db, makeReadyInputState());
            // 1-2 starts while it is the only output with the recipe, so it runs direct.
            db.outputs.delete('1-3');
            await service.start('1-2');
            db.outputs.set('1-3', twitch);
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            await service.start('1-3'); // now shared: reads the encode
            assert.equal(service.getStats('1-2').renditionId, null);
            assert.equal(service.getStats('1-3').renditionId, '1-1');

            const rendition = fleet.procFor(RENDITION_URL);
            rendition.emit('exit', 1, null);
            rendition.emit('close', 1, null);
            await flush();
            await flush();

            assert.deepEqual(fleet.procFor(TWITCH).killSignals, ['SIGTERM'], 'the reader restarts');
            assert.equal(crashRecords(db, '1-3').length, 1);
            assert.deepEqual(
                fleet.procFor(YOUTUBE).killSignals,
                [],
                'the direct output is left alone',
            );
            assert.equal(crashRecords(db, '1-2').length, 0);
            assert.equal(service.getStats('1-2').status, 'running');
            service.shutdown();
        });

        test('a reader that stopped being shared mid-run is still restarted with its rendition', async (t) => {
            const fleet = makeFleet(t);
            const db = makeFleetDb();
            const service = fleet.createOutputService(db, makeReadyInputState());
            t.mock.timers.enable({ apis: ['setTimeout'] });
            await service.start('1-1');
            markReady(fleet.procFor(RENDITION_URL));
            await flush();
            await service.start('1-2'); // reads the encode
            db.outputs.delete('1-3'); // now alone: no longer "shared" by the rule

            assert.equal(service.restart('1-1'), true);
            await flush();
            await flush();

            assert.deepEqual(fleet.procFor(YOUTUBE).killSignals, ['SIGTERM']);
            const stopped = db.recordsFor('1-2', 'stopped');
            assert.match(stopped[0].message, /^Shared encode restarted by user/);
            service.shutdown();
        });
    });
});
