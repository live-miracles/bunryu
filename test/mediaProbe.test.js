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
