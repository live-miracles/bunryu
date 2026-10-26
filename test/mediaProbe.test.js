'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalCwd = process.cwd();
let tempDir;

function loadMediaProbe() {
    fs.writeFileSync(
        path.join(tempDir, 'bunryu.json'),
        JSON.stringify({
            port: 8080,
            database_path: './db.sqlite',
            srs_config_path: './srs.conf',
            ffmpeg_path: 'ffmpeg',
            ffprobe_path: 'ffprobe',
        }),
        'utf8',
    );
    delete require.cache[require.resolve('../src/services/mediaProbe')];
    delete require.cache[require.resolve('../src/utils/appConfig')];
    return require('../src/services/mediaProbe');
}

describe('mediaProbe failure reporting', () => {
    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-probe-test-'));
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
        delete require.cache[require.resolve('../src/services/mediaProbe')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    test('reports a killed probe as a timeout with its stderr tail', async (t) => {
        const url = 'rtmp://127.0.0.1:21935/live/key04_0123456789abcdef0123456789abcdef';
        t.mock.method(childProcess, 'execFile', (_cmd, args, _opts, cb) => {
            assert.deepEqual(args.slice(0, 2), ['-v', 'error']);
            const err = Object.assign(new Error('killed'), {
                killed: true,
                signal: 'SIGKILL',
                code: null,
            });
            queueMicrotask(() => cb(err, '', `${url}: Connection timed out key04_deadbeef`));
            return {};
        });
        const { runFfprobe } = loadMediaProbe();
        const failures = [];
        const result = await runFfprobe(url, undefined, (f) => failures.push(f));

        assert.equal(result, null);
        assert.equal(failures.length, 1);
        assert.equal(failures[0].reason, 'timeout');
        assert.equal(failures[0].signal, 'SIGKILL');
        assert.equal(failures[0].stderrTail, `${url}: Connection timed out key04_deadbeef`);
    });

    test('reports a non-zero exit and unparseable output with distinct reasons', async (t) => {
        const outcomes = [
            [Object.assign(new Error('exit 1'), { code: 1 }), ''],
            [null, 'not json'],
        ];
        t.mock.method(childProcess, 'execFile', (_cmd, _args, _opts, cb) => {
            const [err, stdout] = outcomes.shift();
            queueMicrotask(() => cb(err, stdout, 'boom'));
            return {};
        });
        const { runFfprobe } = loadMediaProbe();
        const failures = [];
        await runFfprobe('rtmp://x/live/k', undefined, (f) => failures.push(f));
        await runFfprobe('rtmp://x/live/k', undefined, (f) => failures.push(f));

        assert.deepEqual(
            failures.map((f) => [f.reason, f.exitCode]),
            [
                ['exit', 1],
                ['parse', null],
            ],
        );
    });
});

describe('keyframe interval probe', () => {
    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-probe-test-'));
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
        delete require.cache[require.resolve('../src/services/mediaProbe')];
        delete require.cache[require.resolve('../src/utils/appConfig')];
    });

    // 25 fps packets over `seconds`, a keyframe every `gop` seconds, as ffprobe
    // prints them (pts_time,dts_time,flags).
    function packets(seconds, gop, { first = 0 } = {}) {
        const lines = [];
        for (let i = 0; i < seconds * 25; i++) {
            const t = first + i / 25;
            lines.push(
                `${(t + 0.08).toFixed(6)},${t.toFixed(6)},${i % (gop * 25) === 0 ? 'K__' : '___'}`,
            );
        }
        return lines.join('\n');
    }

    test('measures a steady 2 s GOP', () => {
        const { parseKeyframePackets, keyframeIntervalTooLong } = loadMediaProbe();
        const stats = parseKeyframePackets(packets(12, 2));
        assert.equal(stats.keyframes, 6);
        assert.equal(stats.meanGapSec, 2);
        assert.equal(stats.maxGapSec, 2);
        assert.ok(stats.spanSec > 11.9);
        assert.equal(keyframeIntervalTooLong(stats), false);
    });

    test('flags a 6 s GOP', () => {
        const { parseKeyframePackets, keyframeIntervalTooLong } = loadMediaProbe();
        const stats = parseKeyframePackets(packets(12, 6));
        assert.equal(stats.keyframes, 2);
        assert.equal(stats.maxGapSec, 6);
        assert.equal(keyframeIntervalTooLong(stats), true);
    });

    test('a single keyframe in the window counts the open gap after it', () => {
        const { parseKeyframePackets, keyframeIntervalTooLong } = loadMediaProbe();
        const stats = parseKeyframePackets(packets(12, 30));
        assert.equal(stats.keyframes, 1);
        assert.equal(stats.meanGapSec, null);
        assert.ok(stats.maxGapSec > 11.9);
        assert.equal(keyframeIntervalTooLong(stats), true);
    });

    test('no keyframe at all reads as one gap as long as the window', () => {
        const { parseKeyframePackets, keyframeIntervalTooLong } = loadMediaProbe();
        const stats = parseKeyframePackets(packets(12, 30).replace(/K__/g, '___'));
        assert.equal(stats.keyframes, 0);
        assert.ok(stats.maxGapSec > 11.9);
        assert.equal(keyframeIntervalTooLong(stats), true);
    });

    test('a 4 s GOP is within the platforms limit, frame rounding included', () => {
        const { parseKeyframePackets, keyframeIntervalTooLong } = loadMediaProbe();
        const stats = parseKeyframePackets(packets(12, 4));
        assert.equal(stats.maxGapSec, 4);
        assert.equal(keyframeIntervalTooLong(stats), false);
    });

    test('a window cut short by the stream ending proves nothing', () => {
        const { parseKeyframePackets, keyframeIntervalTooLong } = loadMediaProbe();
        const stats = parseKeyframePackets(packets(5, 30));
        assert.equal(keyframeIntervalTooLong(stats), false);
    });

    test('uses dts_time, falls back to pts_time, and skips N/A and malformed lines', () => {
        const { parseKeyframePackets } = loadMediaProbe();
        const stats = parseKeyframePackets(
            [
                'N/A,0.000000,K__',
                '2.000000,N/A,K__',
                'garbage',
                '',
                'N/A,N/A,K__',
                '4.000000,4.000000,K__',
            ].join('\n'),
        );
        assert.equal(stats.keyframes, 3);
        assert.equal(stats.maxGapSec, 2);
    });

    test('runKeyframeProbe asks ffprobe for the first video stream packets over the window', async (t) => {
        let seen;
        t.mock.method(childProcess, 'execFile', (_cmd, args, opts, cb) => {
            seen = { args, opts };
            queueMicrotask(() => cb(null, packets(12, 2), ''));
            return {};
        });
        const { runKeyframeProbe } = loadMediaProbe();
        const failures = [];
        const stats = await runKeyframeProbe('rtmp://x/live/k', undefined, (f) => failures.push(f));
        assert.deepEqual(failures, []);
        assert.equal(stats.maxGapSec, 2);
        assert.ok(seen.args.includes('v:0'));
        assert.ok(seen.args.includes('%+12'));
        assert.equal(seen.args.at(-1), 'rtmp://x/live/k');
        assert.equal(seen.opts.killSignal, 'SIGKILL');
        assert.ok(seen.opts.timeout > 12000);
    });

    test('runKeyframeProbe reports a timeout and an empty answer as failures', async (t) => {
        const outcomes = [
            [
                Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL', code: null }),
                '',
            ],
            [null, ''],
        ];
        t.mock.method(childProcess, 'execFile', (_cmd, _args, _opts, cb) => {
            const [err, stdout] = outcomes.shift();
            queueMicrotask(() => cb(err, stdout, 'boom'));
            return {};
        });
        const { runKeyframeProbe } = loadMediaProbe();
        const failures = [];
        assert.equal(
            await runKeyframeProbe('rtmp://x/live/k', undefined, (f) => failures.push(f)),
            null,
        );
        assert.equal(
            await runKeyframeProbe('rtmp://x/live/k', undefined, (f) => failures.push(f)),
            null,
        );
        assert.deepEqual(
            failures.map((f) => f.reason),
            ['timeout', 'parse'],
        );
    });
});
