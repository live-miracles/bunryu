'use strict';

// Real ffmpeg against a destination that accepts the TCP connection and never
// answers: the case the socket watchdog cannot see (the socket is ESTABLISHED).
// The args come from buildFfmpegArgs, so this fails if the output -rw_timeout is
// dropped, moved, or stops working after an ffmpeg upgrade. RTMPS needs no
// certificate: the TLS handshake simply never completes.

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');

const { buildFfmpegArgs, OUTPUT_IO_TIMEOUT_US } = require('../src/utils/ffmpeg');

const probe = spawnSync('ffmpeg', ['-version']);
const skip = !probe.error && probe.status === 0 ? false : 'ffmpeg is not available on PATH';

// ffmpeg's built-in test pattern: no media file is needed (test/*.mp4 is gitignored),
// because the hang happens while the output is being opened, before any muxing.
const SOURCE = 'testsrc=size=64x64:rate=5';
// The real timeout is 10 s; the mechanism is the same at 2 s and the test stays quick.
const TEST_TIMEOUT_US = 2_000_000;

const servers = [];
after(() => {
    for (const s of servers) s.close();
});

function silentServer() {
    return new Promise((resolve) => {
        const sockets = [];
        const server = net.createServer((socket) => {
            sockets.push(socket); // accept, then say nothing
            socket.on('error', () => {});
        });
        server.listen(0, '127.0.0.1', () => {
            const close = server.close.bind(server);
            server.close = () => {
                sockets.forEach((s) => s.destroy());
                close();
            };
            servers.push(server);
            resolve(server.address().port);
        });
    });
}

// The args Bunryu builds for a copy output, reading a test pattern instead of SRS.
function bunryuArgs(url, { outputTimeoutUs = TEST_TIMEOUT_US } = {}) {
    const args = buildFfmpegArgs(SOURCE, url, 'copy');
    const at = args.lastIndexOf('-rw_timeout');
    assert.equal(at, args.length - 3, 'the output timeout is expected right before the url');
    assert.equal(args[at + 1], String(OUTPUT_IO_TIMEOUT_US));
    if (outputTimeoutUs === null) args.splice(at, 2);
    else args[at + 1] = String(outputTimeoutUs);
    // The input's own -rw_timeout is for network pulls; the lavfi source rejects it.
    args.splice(args.indexOf('-rw_timeout'), 2);
    args.splice(args.indexOf('-i'), 0, '-f', 'lavfi');
    return args;
}

// Resolves with how ffmpeg ended, or { stillRunning: true } if it was still going
// after waitMs (then it is killed).
function runFfmpeg(args, waitMs) {
    return new Promise((resolve) => {
        const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        p.stderr.on('data', (d) => (stderr += d));
        const startedAt = Date.now();
        let killedByTest = false;
        p.on('close', (code) => {
            const ms = Date.now() - startedAt;
            resolve(killedByTest ? { stillRunning: true, ms } : { code, ms, stderr });
        });
        setTimeout(() => {
            killedByTest = true;
            p.kill('SIGKILL');
        }, waitMs);
    });
}

describe('output write timeout, real ffmpeg', { skip }, () => {
    for (const scheme of ['rtmp', 'rtmps']) {
        test(`${scheme}: a destination that never answers makes ffmpeg exit on its own`, async () => {
            const port = await silentServer();
            const result = await runFfmpeg(
                bunryuArgs(`${scheme}://127.0.0.1:${port}/live/key`),
                12_000,
            );
            assert.ok(!result.stillRunning, 'ffmpeg must give up by itself');
            assert.notEqual(result.code, 0);
            assert.match(result.stderr, /timed out/i);
            assert.ok(result.ms >= 1500, `gave up too early (${result.ms} ms)`);
            assert.ok(result.ms < 9000, `took too long (${result.ms} ms)`);
        });
    }

    test('control: without the option the same destination holds ffmpeg open', async () => {
        const port = await silentServer();
        const result = await runFfmpeg(
            bunryuArgs(`rtmp://127.0.0.1:${port}/live/key`, { outputTimeoutUs: null }),
            6_000,
        );
        assert.ok(result.stillRunning, 'without the option ffmpeg waits indefinitely');
    });
});
