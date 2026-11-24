import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KeyframeStats, ProbeResult } from '../src/services/mediaProbe';
import type { ProbeSchedulerDeps } from '../src/services/probeScheduler';

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
const { createProbeScheduler } =
    require('../src/services/probeScheduler') as typeof import('../src/services/probeScheduler');
process.chdir(originalCwd);

// A probe result with only the fields these tests read, and what a runner finishes with.
type ProbeFixture = Omit<ProbeResult, 'video'> & {
    video: { codec: string; width: number; height: number } | null;
};
type KeyframeFixture = Pick<
    KeyframeStats,
    'windowSec' | 'spanSec' | 'keyframes' | 'meanGapSec' | 'maxGapSec'
>;

const USABLE = {
    video: { codec: 'h264', width: 1920, height: 1080 },
    audio: null,
    audioTracks: [],
};
const UNUSABLE = { video: null, audio: null, audioTracks: [] };
const STATS = { windowSec: 12, spanSec: 12, keyframes: 6, meanGapSec: 2, maxGapSec: 2 };
const SLOW_STATS = { ...STATS, keyframes: 2, meanGapSec: 6, maxGapSec: 6 };

interface FakeChild {
    exitCode: number | null;
    signalCode: string | null;
    killed: (string | undefined)[];
    kill(signal?: string): void;
}
interface RunnerCall<Fixture> {
    kind: string;
    url: string;
    child: FakeChild;
    finish: (result: Fixture | null) => void;
}

// A scripted ffprobe: every call waits for the test to finish it. The fixture a test
// finishes with stands in for the runner's real result type.
function makeRunner<Fixture, Result>(kind: string) {
    const calls: RunnerCall<Fixture>[] = [];
    const run = (url: string, onChild?: (child: ChildProcess) => void): Promise<Result | null> => {
        const child: FakeChild = {
            exitCode: null,
            signalCode: null,
            killed: [],
            kill(signal) {
                this.killed.push(signal);
            },
        };
        onChild?.(child as unknown as ChildProcess);
        let finish: RunnerCall<Fixture>['finish'] = () => {};
        const promise = new Promise<Result | null>((resolve) => {
            finish = (fixture) => resolve(fixture as unknown as Result | null);
        });
        calls.push({ kind, url, child, finish });
        return promise;
    };
    return { run, calls };
}

function setup(
    t: TestContext,
    { onUsableProbe }: { onUsableProbe?: ProbeSchedulerDeps['onUsableProbe'] } = {},
) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const ffprobe = makeRunner<ProbeFixture, ProbeResult>('ffprobe');
    const keyframe = makeRunner<KeyframeFixture, KeyframeStats>('keyframe');
    const logs: { id: number; event: string; message: string }[] = [];
    const events: ({ event: string } & Record<string, unknown>)[] = [];
    const usable: { id: number; result: ProbeResult }[] = [];
    const scheduler = createProbeScheduler({
        db: { appendPipelineLog: (id, event, message) => logs.push({ id, event, message }) },
        diagnostics: {
            event: (event, fields = {}) => events.push({ event, ...fields }),
            close: () => Promise.resolve(),
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
        assert.equal(scheduler.status(1)?.ok, true);
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
        assert.equal(scheduler.status(1)?.ok, false);
        assert.equal(scheduler.status(1)?.failedAttempts, 1);
        const failingSince = scheduler.status(1)?.failingSince;
        assert.equal(typeof failingSince, 'number');
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
        assert.equal(scheduler.status(1)?.failedAttempts, 2);
        assert.equal(scheduler.status(1)?.failingSince, failingSince, 'since the first failure');
        assert.equal(logs.length, 1, 'a persistently bad input does not flood the pipeline log');

        t.mock.timers.tick(30_000);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        ffprobe.calls[2].finish(USABLE);
        await settle();
        assert.equal(scheduler.status(1)?.failedAttempts, 0);
        assert.equal(scheduler.status(1)?.failingSince, null);
        assert.deepEqual(
            logs.map((l) => l.event),
            ['probe_failed', 'probe_recovered'],
        );
        assert.deepEqual(
            events.map((e) => e.event),
            ['media-probe-failed', 'media-probe-failed', 'media-probe-recovered'],
        );
    });

    // An output's watchdog found its input stuck while the input still looks fine (an
    // encoder that keeps sending after its source is gone): look at the media again.
    describe('suspect()', () => {
        async function probed(t: TestContext) {
            const ctx = setup(t);
            ctx.scheduler.ensure(1, 'key01', 'srt', 0);
            t.mock.timers.tick(0);
            await ctx.settle();
            ctx.ffprobe.calls[0].finish(USABLE);
            await ctx.settle();
            assert.equal(ctx.scheduler.status(1)?.ok, true);
            return ctx;
        }

        test('re-probes a healthy input at once and a failing result turns it bad', async (t) => {
            t.mock.method(console, 'warn', () => {});
            const { scheduler, ffprobe, events, logs, settle } = await probed(t);

            assert.equal(scheduler.suspect(1, 'key01', 'srt'), true);
            t.mock.timers.tick(0);
            await settle();
            assert.equal(ffprobe.calls.length, 2, 'no stagger');
            assert.deepEqual(
                events.filter((e) => e.event === 'media-probe-requested'),
                [
                    {
                        event: 'media-probe-requested',
                        pipelineId: 1,
                        protocol: 'srt',
                        reason: 'output-watchdog',
                    },
                ],
            );

            ffprobe.calls[1].finish(UNUSABLE);
            await settle();
            assert.equal(scheduler.status(1)?.ok, false);
            assert.deepEqual(
                logs.map((l) => l.event),
                ['probe_failed'],
            );

            // From here the ordinary 30 s retry watches for the input to recover.
            t.mock.timers.tick(30_000);
            scheduler.ensure(1, 'key01', 'srt', 0);
            t.mock.timers.tick(0);
            await settle();
            assert.equal(ffprobe.calls.length, 3);
        });

        test('a probe that still passes leaves the input as it was', async (t) => {
            const { scheduler, ffprobe, logs, settle } = await probed(t);

            scheduler.suspect(1, 'key01', 'srt');
            t.mock.timers.tick(0);
            await settle();
            ffprobe.calls[1].finish(USABLE);
            await settle();

            assert.equal(scheduler.status(1)?.ok, true);
            assert.deepEqual(logs, []);
        });

        test('at most one re-probe per 5 minutes, however often outputs fault', async (t) => {
            const { scheduler, ffprobe, settle } = await probed(t);

            assert.equal(scheduler.suspect(1, 'key01', 'srt'), true);
            t.mock.timers.tick(0);
            await settle();
            ffprobe.calls[1].finish(USABLE);
            await settle();

            t.mock.timers.tick(299_000);
            assert.equal(scheduler.suspect(1, 'key01', 'srt'), false);
            t.mock.timers.tick(1_000);
            assert.equal(scheduler.suspect(1, 'key01', 'srt'), true);
            t.mock.timers.tick(0);
            await settle();
            assert.equal(ffprobe.calls.length, 3);
        });

        test('does nothing while a probe is running, failing or not yet done', async (t) => {
            const { scheduler, ffprobe, settle } = setup(t);

            assert.equal(scheduler.suspect(1, 'key01', 'srt'), false, 'never probed');
            scheduler.ensure(1, 'key01', 'srt', 0);
            t.mock.timers.tick(0);
            await settle();
            assert.equal(scheduler.suspect(1, 'key01', 'srt'), false, 'first probe running');

            t.mock.method(console, 'warn', () => {});
            ffprobe.calls[0].finish(UNUSABLE);
            await settle();
            assert.equal(
                scheduler.suspect(1, 'key01', 'srt'),
                false,
                'already failing: it retries',
            );
            assert.equal(ffprobe.calls.length, 1);
        });

        test("a new publisher starts without the old one's cooldown", async (t) => {
            const { scheduler, ffprobe, settle } = await probed(t);

            scheduler.suspect(1, 'key01', 'srt');
            t.mock.timers.tick(0);
            await settle();
            ffprobe.calls[1].finish(USABLE);
            await settle();

            scheduler.clear(1);
            scheduler.ensure(1, 'key01', 'srt', 0);
            t.mock.timers.tick(0);
            await settle();
            ffprobe.calls[2].finish(USABLE);
            await settle();
            assert.equal(scheduler.suspect(1, 'key01', 'srt'), true);
        });
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

    test("a cleared probe finishing late does not wipe the next publisher's probe", async (t) => {
        const { scheduler, ffprobe, settle } = setup(t);

        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        scheduler.clear(1);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        assert.equal(ffprobe.calls.length, 2);

        // The killed probe exits after the new one has started.
        ffprobe.calls[0].finish(null);
        await settle();

        assert.notEqual(scheduler.inFlightSince(1), null, 'the new probe is still in flight');
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(10_000);
        await settle();
        assert.equal(ffprobe.calls.length, 2, 'no second ffprobe on the same input');
        scheduler.clear(1);
        assert.deepEqual(ffprobe.calls[1].child.killed, ['SIGKILL'], 'clear() still reaches it');
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
        assert.equal(scheduler.status(2)?.ok, true);
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
        assert.equal(scheduler.keyframes(1)?.maxGapSec, 6);
        assert.deepEqual(
            events.map((e) => e.event).filter((e) => e.startsWith('keyframe')),
            ['keyframe-interval'],
        );
        assert.equal(logs.at(-1)?.event, 'keyframe_interval');

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

    test('ensure() after shutdown() launches nothing', async (t) => {
        const { scheduler, ffprobe, settle } = setup(t);
        scheduler.shutdown();
        scheduler.ensure(7, 'key07', 'rtmp', 0);
        t.mock.timers.tick(10_000);
        await settle();
        assert.equal(ffprobe.calls.length, 0);
    });

    test('ensure() says whether it scheduled an ffprobe', async (t) => {
        const { scheduler, ffprobe, settle } = setup(t);
        assert.equal(scheduler.ensure(1, 'key01', 'rtmp', 0), true);
        assert.equal(scheduler.ensure(1, 'key01', 'rtmp', 1), false, 'already scheduled');
        t.mock.timers.tick(0);
        await settle();
        assert.equal(scheduler.ensure(1, 'key01', 'rtmp', 1), false, 'already running');
        ffprobe.calls[0].finish(USABLE);
        await settle();
        assert.equal(scheduler.ensure(1, 'key01', 'rtmp', 1), false, 'already validated');
    });

    test('reprobe() probes at once and keeps the last result until the new one lands', async (t) => {
        const { scheduler, ffprobe, events, usable, settle } = setup(t);
        scheduler.ensure(1, 'key01', 'rtmp', 3);
        t.mock.timers.tick(600);
        await settle();
        ffprobe.calls[0].finish(USABLE);
        await settle();
        const first = scheduler.status(1);
        assert.equal(first?.ok, true);

        t.mock.timers.tick(5_000);
        assert.equal(scheduler.reprobe(1, 'key01', 'rtmp'), true);
        t.mock.timers.tick(0);
        await settle();
        assert.equal(ffprobe.calls.length, 2, 'no stagger and no wait for the 30 s retry');
        assert.equal(scheduler.status(1), first, 'the old result stays on show while it runs');
        assert.equal(scheduler.inFlightSince(1), 1_005_600);

        ffprobe.calls[1].finish({ ...USABLE, video: { codec: 'h264', width: 1280, height: 720 } });
        await settle();
        assert.equal(scheduler.status(1)?.result?.video?.width, 1280);
        assert.equal(scheduler.status(1)?.checkedAt, 1_005_600);
        assert.equal(usable.length, 2, 'the new result goes through the usable-probe callback');
        assert.deepEqual(
            events.filter((e) => e.event === 'media-probe-requested'),
            [{ event: 'media-probe-requested', pipelineId: 1, protocol: 'rtmp' }],
        );
    });

    test('reprobe() does nothing while a probe is queued or running, or after shutdown()', async (t) => {
        const { scheduler, ffprobe, settle } = setup(t);
        scheduler.ensure(1, 'key01', 'rtmp', 1);
        assert.equal(scheduler.reprobe(1, 'key01', 'rtmp'), false, 'its launch is queued');
        t.mock.timers.tick(200);
        await settle();
        assert.equal(scheduler.reprobe(1, 'key01', 'rtmp'), false, 'it is running');
        assert.equal(ffprobe.calls.length, 1);

        ffprobe.calls[0].finish(USABLE);
        await settle();
        scheduler.shutdown();
        assert.equal(scheduler.reprobe(1, 'key01', 'rtmp'), false);
        t.mock.timers.tick(1_000);
        await settle();
        assert.equal(ffprobe.calls.length, 1);
    });

    test('a reprobe that fails after a good probe is recorded and retried every 30 s', async (t) => {
        t.mock.method(console, 'warn', () => {});
        const { scheduler, ffprobe, logs, settle } = setup(t);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        ffprobe.calls[0].finish(USABLE);
        await settle();

        scheduler.reprobe(1, 'key01', 'rtmp');
        t.mock.timers.tick(0);
        await settle();
        ffprobe.calls[1].finish(UNUSABLE);
        await settle();
        assert.equal(scheduler.status(1)?.ok, false);
        assert.equal(scheduler.status(1)?.failedAttempts, 1);
        assert.deepEqual(
            logs.map((l) => l.event),
            ['probe_failed'],
        );

        t.mock.timers.tick(30_000);
        scheduler.ensure(1, 'key01', 'rtmp', 0);
        t.mock.timers.tick(0);
        await settle();
        assert.equal(ffprobe.calls.length, 3, 'the normal retry takes over');
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

        assert.equal(scheduler.status(1)?.ok, true);
        assert.equal(scheduler.inFlightSince(1), null, 'the in-flight marker is released');
    });
});
