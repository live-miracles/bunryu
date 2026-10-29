'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// mediaProbe reads the ffprobe path from bunryu.json when it is loaded.
const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-probe-scheduler-'));
fs.writeFileSync(
    path.join(tempDir, 'bunryu.json'),
    JSON.stringify({
        port: 8080,
        database_path: './db.sqlite',
        srs_config_path: './srs.conf',
        ffmpeg_path: 'ffmpeg',
        ffprobe_path: 'ffprobe',
    }),
);
fs.writeFileSync(path.join(tempDir, 'srs.conf'), 'listen 1935;\nhttp_api {\n    listen 1985;\n}\n');
process.chdir(tempDir);
const { createProbeScheduler } = require('../src/services/probeScheduler');
process.chdir(originalCwd);

const USABLE = {
    video: { codec: 'h264', width: 1920, height: 1080 },
    audio: null,
    audioTracks: [],
};
const UNUSABLE = { video: null, audio: null, audioTracks: [] };
const STATS = { windowSec: 12, spanSec: 12, keyframes: 6, meanGapSec: 2, maxGapSec: 2 };
const SLOW_STATS = { ...STATS, keyframes: 2, meanGapSec: 6, maxGapSec: 6 };

// A scripted ffprobe: every call waits for the test to finish it.
function makeRunner(kind) {
    const calls = [];
    const run = (url, onChild) => {
        const child = {
            exitCode: null,
            signalCode: null,
            killed: [],
            kill(signal) {
                this.killed.push(signal);
            },
        };
        onChild?.(child);
        let finish;
        const promise = new Promise((resolve) => {
            finish = resolve;
        });
        calls.push({ kind, url, child, finish });
        return promise;
    };
    return { run, calls };
}

function setup(t, { onUsableProbe } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const ffprobe = makeRunner('ffprobe');
    const keyframe = makeRunner('keyframe');
    const logs = [];
    const events = [];
    const usable = [];
    const scheduler = createProbeScheduler({
        db: { appendPipelineLog: (id, event, message) => logs.push({ id, event, message }) },
        diagnostics: {
            event: (event, fields = {}) => events.push({ event, ...fields }),
            close() {},
        },
        onUsableProbe: onUsableProbe ?? ((id, result) => usable.push({ id, result })),
        runners: { runFfprobe: ffprobe.run, runKeyframeProbe: keyframe.run },
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    return { scheduler, ffprobe, keyframe, logs, events, usable, settle };
}

describe('probe scheduler', () => {
    test('probes a connected input once, staggered, and stops after a usable result', async (t) => {
        const { scheduler, ffprobe, usable, settle } = setup(t);

        scheduler.ensure(1, 'key01', 'rtmp', 0);
        scheduler.ensure(2, 'key02', 'rtmp', 1);
        assert.equal(ffprobe.calls.length, 0, 'the launch waits for its timer');

        t.mock.timers.tick(0);
        await settle();
        assert.equal(ffprobe.calls.length, 1);
        t.mock.timers.tick(200);
        await settle();
        assert.equal(ffprobe.calls.length, 2, 'the second pipeline starts one stagger later');
        assert.equal(scheduler.inFlightSince(1), 1_000_000);

        ffprobe.calls[0].finish(USABLE);
        await settle();
        assert.equal(scheduler.status(1).ok, true);
        assert.equal(scheduler.inFlightSince(1), null);
        assert.deepEqual(
            usable.map((u) => u.id),
            [1],
            'the callback sees each usable result',
        );

        t.mock.timers.tick(120_000);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        assert.equal(ffprobe.calls.filter((c) => c.url.includes('key01')).length, 1);
    });

    test('a failed probe retries only after 30 s, logs the first failure and the recovery once', async (t) => {
        t.mock.method(console, 'warn', () => {});
        const { scheduler, ffprobe, logs, events, settle } = setup(t);

        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        ffprobe.calls[0].finish(UNUSABLE);
        await settle();
        assert.equal(scheduler.status(1).ok, false);
        assert.equal(scheduler.status(1).failedAttempts, 1);
        assert.deepEqual(
            logs.map((l) => l.event),
            ['probe_failed'],
        );

        t.mock.timers.tick(29_000);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        assert.equal(ffprobe.calls.length, 1, 'not before the refresh interval');

        t.mock.timers.tick(1_000);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        assert.equal(ffprobe.calls.length, 2);
        ffprobe.calls[1].finish(UNUSABLE);
        await settle();
        assert.equal(scheduler.status(1).failedAttempts, 2);
        assert.equal(logs.length, 1, 'a persistently bad input does not flood the pipeline log');

        t.mock.timers.tick(30_000);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        ffprobe.calls[2].finish(USABLE);
        await settle();
        assert.equal(scheduler.status(1).failedAttempts, 0);
        assert.deepEqual(
            logs.map((l) => l.event),
            ['probe_failed', 'probe_recovered'],
        );
        assert.deepEqual(
            events.map((e) => e.event),
            ['media-probe-failed', 'media-probe-failed', 'media-probe-recovered'],
        );
    });

    test('clear() cancels a pending launch', async (t) => {
        const { scheduler, ffprobe, settle } = setup(t);

        scheduler.ensure(1, 'key01', 'rtmp', 5);
        scheduler.clear(1);
        t.mock.timers.tick(5_000);
        await settle();

        assert.equal(ffprobe.calls.length, 0);
    });

    test('clear() kills the running ffprobe and drops the result when it lands', async (t) => {
        const { scheduler, ffprobe, usable, settle } = setup(t);

        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        scheduler.clear(1);
        assert.deepEqual(ffprobe.calls[0].child.killed, ['SIGKILL']);
        assert.equal(scheduler.inFlightSince(1), null);

        // The old publisher's probe finishing late must not become the new one's result.
        ffprobe.calls[0].finish(USABLE);
        await settle();
        assert.equal(scheduler.status(1), null);
        assert.deepEqual(usable, []);

        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        assert.equal(ffprobe.calls.length, 2, 'the next publisher is probed afresh');
    });

    test('keepOnly() clears the pipelines that are gone and leaves the others', async (t) => {
        const { scheduler, ffprobe, settle } = setup(t);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        scheduler.ensure(2, 'key02', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        ffprobe.calls[0].finish(USABLE);
        ffprobe.calls[1].finish(USABLE);
        await settle();

        scheduler.keepOnly(new Set([2]));

        assert.equal(scheduler.status(1), null);
        assert.equal(scheduler.status(2).ok, true);
    });

    test('the keyframe check runs once, 60 s after the first usable probe', async (t) => {
        const { scheduler, ffprobe, keyframe, events, logs, settle } = setup(t);
        scheduler.ensure(1, 'key01', 'srt', 0);
        t.mock.timers.tick(0);
        await settle();
        ffprobe.calls[0].finish(USABLE);
        await settle();

        t.mock.timers.tick(59_000);
        scheduler.ensure(1, 'key01', 'srt', 0);
        assert.equal(keyframe.calls.length, 0, 'too early to be representative');

        t.mock.timers.tick(1_000);
        scheduler.ensure(1, 'key01', 'srt', 0);
        scheduler.ensure(1, 'key01', 'srt', 0);
        assert.equal(keyframe.calls.length, 1, 'queued once however often it is asked');

        keyframe.calls[0].finish(SLOW_STATS);
        await settle();
        assert.equal(scheduler.keyframes(1).maxGapSec, 6);
        assert.deepEqual(
            events.map((e) => e.event).filter((e) => e.startsWith('keyframe')),
            ['keyframe-interval'],
        );
        assert.equal(logs.at(-1).event, 'keyframe_interval');

        scheduler.ensure(1, 'key01', 'srt', 0);
        assert.equal(keyframe.calls.length, 1, 'never re-measured for the same publisher');
    });

    test('keyframe checks run four at a time and a cleared pipeline never runs its queued one', async (t) => {
        const { scheduler, ffprobe, keyframe, settle } = setup(t);
        for (let id = 1; id <= 6; id++) scheduler.ensure(id, `key0${id}`, 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        for (const call of ffprobe.calls) call.finish(USABLE);
        await settle();

        t.mock.timers.tick(60_000);
        for (let id = 1; id <= 6; id++) scheduler.ensure(id, `key0${id}`, 'rtmp', 0);
        assert.equal(keyframe.calls.length, 4, 'the rest wait for a free slot');

        scheduler.clear(6);
        keyframe.calls[0].finish(STATS);
        await settle();
        assert.equal(keyframe.calls.length, 5, 'pipeline 5 takes the free slot');
        keyframe.calls[1].finish(STATS);
        await settle();
        assert.equal(keyframe.calls.length, 5, 'pipeline 6 was cleared while it waited');
    });

    test('a keyframe check that lands after clear() is dropped', async (t) => {
        const { scheduler, ffprobe, keyframe, events, settle } = setup(t);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        ffprobe.calls[0].finish(USABLE);
        await settle();
        t.mock.timers.tick(60_000);
        scheduler.ensure(1, 'key01', 'rtmp', 0);

        scheduler.clear(1);
        assert.deepEqual(keyframe.calls[0].child.killed, ['SIGKILL']);
        keyframe.calls[0].finish(STATS);
        await settle();

        assert.equal(scheduler.keyframes(1), null);
        assert.equal(events.filter((e) => e.event === 'keyframe-interval').length, 0);
    });

    test('shutdown() kills what is running and starts nothing more', async (t) => {
        const { scheduler, ffprobe, keyframe, settle } = setup(t);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        scheduler.ensure(2, 'key02', 'rtmp', 3);
        t.mock.timers.tick(0);
        await settle();

        scheduler.shutdown();
        assert.deepEqual(ffprobe.calls[0].child.killed, ['SIGKILL']);

        t.mock.timers.tick(10_000);
        await settle();
        assert.equal(ffprobe.calls.length, 1, 'the staggered launch was cancelled');

        // A probe still landing must not start a keyframe check.
        ffprobe.calls[0].finish(USABLE);
        await settle();
        t.mock.timers.tick(60_000);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        assert.equal(keyframe.calls.length, 0);
    });

    test('a failing onUsableProbe callback is contained and the result is still kept', async (t) => {
        t.mock.method(console, 'error', () => {});
        const { scheduler, ffprobe, settle } = setup(t, {
            onUsableProbe: () => {
                throw new Error('boom');
            },
        });
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();

        ffprobe.calls[0].finish(USABLE);
        await settle();

        assert.equal(scheduler.status(1).ok, true);
        assert.equal(scheduler.inFlightSince(1), null, 'the in-flight marker is released');
    });
});
