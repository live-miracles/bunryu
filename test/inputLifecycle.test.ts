import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createInputLifecycle } from '../src/services/inputLifecycle';
import type { InputAlertSources } from '../src/services/inputLifecycle';
import { createInputState } from '../src/services/inputState';
import type { ProbeResult } from '../src/services/mediaProbe';
import type { ProbeScheduler } from '../src/services/probeScheduler';
import type { SrsStream, SrsStreamVideo } from '../src/utils/srs';

const START = 1_700_000_000_000;
const SEC = 1000;

const pipeline = { id: 1, streamKey: 'key01' };

interface FormatRestart {
    id: number;
    why: string;
    since: number;
}

function stream(over: Partial<SrsStream> = {}): SrsStream {
    return {
        id: 'stream-1',
        app: 'live',
        name: 'key01',
        vhost: '__defaultVhost__',
        tcUrl: 'rtmp://x/live',
        live_ms: 0,
        publish: { active: true, cid: 'cid-1' },
        kbps: { recv_30s: 0, send_30s: 0 },
        clients: 0,
        frames: 0,
        recv_bytes: 0,
        send_bytes: 0,
        ...over,
    };
}

function probeResult(width = 1920, tracks = 1): ProbeResult {
    return {
        video: { codec: 'h264', profile: 'High', level: '4.0', width, height: 1080 },
        audio: null,
        audioTracks: Array.from({ length: tracks }, (_, index) => ({
            index,
            codec: 'aac',
            sampleRate: 48000,
            channels: 2,
            profile: 'LC',
            language: null,
            title: null,
            pid: null,
        })),
    };
}

// A lifecycle over fakes, with the clock under the test's control.
function setup(t: TestContext) {
    t.mock.timers.enable({ apis: ['Date'], now: START });
    const logs: Array<{ pipelineId: number; event: string; message: string }> = [];
    const events: Array<{ event: string } & Record<string, unknown>> = [];
    const probeCalls: unknown[][] = [];
    const restarts: Array<{ id: number; base: number | undefined }> = [];
    const formatRestarts: FormatRestart[] = [];
    // What the fake probe scheduler answers: whether the call scheduled an ffprobe.
    const launches = { next: true };
    const inputState = createInputState();
    const lifecycle = createInputLifecycle({
        db: {
            appendPipelineLog: (pipelineId, event, message) =>
                logs.push({ pipelineId, event, message }),
        },
        outputService: {
            restartPipelineOutputs: (id, base) => {
                restarts.push({ id, base });
                return 2;
            },
            restartRunningOutputs: (id, why, since) => {
                formatRestarts.push({ id, why, since });
                return 3;
            },
        },
        inputState,
        probes: {
            ensure: (...args: Parameters<ProbeScheduler['ensure']>) => {
                probeCalls.push(['ensure', ...args]);
                return launches.next;
            },
            clear: (id: number) => {
                probeCalls.push(['clear', id]);
            },
        },
        diagnostics: {
            event: (event, fields) => {
                events.push({ event, ...fields });
            },
            close: async () => {},
        },
    });
    const staggers = { ffprobe: 0, restart: 0 };
    const observe = (s: SrsStream | undefined, reachable = true) =>
        lifecycle.observe(pipeline, s, reachable, staggers);
    const alerts = (over: Partial<InputAlertSources> = {}) =>
        lifecycle.alerts(
            1,
            {
                fpsStream: undefined,
                nominalFps: null,
                connected: true,
                keyframes: null,
                video: null,
                ...over,
            },
            Date.now(),
        );
    const tick = (ms: number) => t.mock.timers.tick(ms);
    return {
        lifecycle,
        inputState,
        logs,
        events,
        probeCalls,
        restarts,
        formatRestarts,
        staggers,
        launches,
        observe,
        alerts,
        tick,
    };
}

describe('input lifecycle: transitions', () => {
    test('a stream appearing is one online transition that probes and restarts outputs', (t) => {
        const { observe, logs, events, probeCalls, restarts, staggers, inputState } = setup(t);
        const seen = observe(stream());
        assert.deepEqual(seen, { live: true, connected: true, isSrt: false });
        assert.deepEqual(logs, [
            { pipelineId: 1, event: 'online', message: 'Input media detected (rtmp)' },
        ]);
        assert.equal(events[0].event, 'input-transition');
        assert.deepEqual(probeCalls, [['ensure', 1, 'key01', 'rtmp', 0]]);
        assert.deepEqual(restarts, [{ id: 1, base: 0 }]);
        assert.deepEqual(staggers, { ffprobe: 1, restart: 2 });
        assert.equal(inputState.isLive(1), true);

        // Still live: probed again (the scheduler decides if it needs to) but no second transition.
        observe(stream());
        assert.equal(logs.length, 1);
        assert.equal(restarts.length, 1);
    });

    test('the ffprobe stagger moves only when a probe was scheduled', (t) => {
        const { observe, staggers, launches } = setup(t);
        launches.next = false;
        observe(stream());
        observe(stream());
        assert.equal(staggers.ffprobe, 0);
        launches.next = true;
        observe(stream());
        assert.equal(staggers.ffprobe, 1);
    });

    test('an SRT stream is recognised from its tcUrl', (t) => {
        const { observe, logs } = setup(t);
        const seen = observe(stream({ tcUrl: 'srt://x:10080' }));
        assert.equal(seen.isSrt, true);
        assert.equal(logs[0].message, 'Input media detected (srt)');
    });

    test('a stream going away logs the offline transition with its uptime and clears the input', (t) => {
        const { observe, logs, probeCalls, inputState, tick } = setup(t);
        observe(stream());
        tick(90 * SEC);
        const seen = observe(undefined);
        assert.deepEqual(seen, { live: false, connected: false, isSrt: false });
        assert.equal(logs.at(-1)?.event, 'offline');
        assert.match(logs.at(-1)?.message ?? '', /^Input disconnected \(was live for 1m 30s\)$/);
        assert.deepEqual(probeCalls.at(-1), ['clear', 1]);
        assert.equal(inputState.isLive(1), false);
    });

    test('while SRS is unreachable the last state stands and nothing is logged', (t) => {
        const { observe, logs, restarts, inputState } = setup(t);
        observe(stream());
        const before = logs.length;
        const seen = observe(undefined, false);
        // Shown as not live, but not treated as a disconnect.
        assert.deepEqual(seen, { live: false, connected: false, isSrt: false });
        assert.equal(logs.length, before);
        assert.equal(restarts.length, 1);
        assert.equal(inputState.isLive(1), true);

        // SRS back with the stream still there: no second online transition.
        observe(stream());
        assert.equal(logs.length, before);
    });

    test('a new publisher cid is a publisher change: probe cleared, alert for 30 s', (t) => {
        const { observe, events, probeCalls, alerts, tick } = setup(t);
        observe(stream());
        tick(5 * SEC);
        observe(stream({ publish: { active: true, cid: 'cid-2' } }));
        // The old publisher's probe is dropped, then the new one is scheduled.
        assert.deepEqual(
            probeCalls.slice(-2).map((c) => c[0]),
            ['clear', 'ensure'],
        );
        const change = events.find((e) => e.event === 'input-publisher-transition');
        assert.ok(change);
        assert.deepEqual(
            { from: change.fromCid, to: change.toCid, protocol: change.protocol },
            { from: 'cid-1', to: 'cid-2', protocol: 'rtmp' },
        );
        assert.deepEqual(
            alerts().map((a) => a.code),
            ['publisher-reconnected'],
        );
        tick(31 * SEC);
        assert.deepEqual(alerts(), []);
    });

    test('keepOnly forgets a deleted pipeline, so a reused id is not a publisher change', (t) => {
        const { observe, lifecycle, events } = setup(t);
        observe(stream());
        lifecycle.keepOnly(new Set());
        observe(stream({ publish: { active: true, cid: 'cid-2' } }));
        assert.equal(events.filter((e) => e.event === 'input-publisher-transition').length, 0);
    });
});

describe('input lifecycle: alerts', () => {
    test('three disconnects within five minutes is flapping, and it ends as they age out', (t) => {
        const { observe, alerts, tick } = setup(t);
        for (let i = 0; i < 3; i++) {
            observe(stream());
            tick(10 * SEC);
            observe(undefined);
            tick(10 * SEC);
        }
        const flap = alerts().find((a) => a.code === 'input-flapping');
        assert.ok(flap);
        assert.match(flap.message, /^Input disconnected 3 times in the last 5 minutes\.$/);
        tick(5 * 60 * SEC);
        assert.deepEqual(alerts(), []);
    });

    test('two disconnects are not flapping', (t) => {
        const { observe, alerts, tick } = setup(t);
        for (let i = 0; i < 2; i++) {
            observe(stream());
            tick(10 * SEC);
            observe(undefined);
        }
        assert.deepEqual(alerts(), []);
    });

    test('a frame rate more than 10 % off the probed one alerts once the 2 minute window is full', (t) => {
        const { alerts, tick } = setup(t);
        const nominalFps = 50;
        const at = (frames: number) => alerts({ fpsStream: stream({ frames }), nominalFps });
        assert.deepEqual(at(1000), []); // window not full yet
        tick(60 * SEC);
        assert.deepEqual(at(1000 + 60 * 25), []);
        tick(60 * SEC);
        const low = at(1000 + 120 * 25); // 25 fps against 50
        assert.deepEqual(
            low.map((a) => a.code),
            ['input-low-framerate'],
        );
        assert.match(low[0].message, /^Input is delivering 25\.0 fps; ffprobe reports 50 fps\.$/);
        tick(120 * SEC);
        assert.deepEqual(
            at(1000 + 120 * 25 + 120 * 50).map((a) => a.code),
            [],
        ); // back to 50 fps
    });

    test('a frame rate within tolerance, or no stream to measure, does not alert', (t) => {
        const { alerts, tick } = setup(t);
        alerts({ fpsStream: stream({ frames: 1000 }), nominalFps: 50 });
        tick(120 * SEC);
        assert.deepEqual(
            alerts({ fpsStream: stream({ frames: 1000 + 120 * 52 }), nominalFps: 50 }),
            [],
        );
        tick(120 * SEC);
        assert.deepEqual(alerts({ fpsStream: undefined, nominalFps: 50 }), []);
    });

    test('keyframes too far apart alert only while connected', (t) => {
        const { alerts } = setup(t);
        const keyframes = {
            windowSec: 10,
            spanSec: 10,
            keyframes: 1,
            meanGapSec: null,
            maxGapSec: 10,
            checkedAt: START,
        };
        assert.deepEqual(
            alerts({ keyframes }).map((a) => a.code),
            ['input-keyframe-interval'],
        );
        assert.deepEqual(alerts({ keyframes, connected: false }), []);
    });

    test('an interlaced input alerts, naming its scan, only while connected', (t) => {
        const { alerts } = setup(t);
        const video: SrsStreamVideo = {
            codec: 'h264',
            profile: 'High',
            level: '4.0',
            width: 1920,
            height: 1080,
            fps: 25,
            fieldOrder: 'tt',
        };
        const found = alerts({ video });
        assert.deepEqual(
            found.map((a) => a.code),
            ['input-interlaced'],
        );
        assert.equal(found[0].severity, 'warning');
        assert.match(found[0].message, /^Input is interlaced \(1080i25tff\)/);
        assert.equal(alerts({ video: { ...video, fieldOrder: 'bb' } })[0].code, 'input-interlaced');
        assert.deepEqual(alerts({ video, connected: false }), []);
    });

    test('progressive, unknown or unprobed scan does not alert', (t) => {
        const { alerts } = setup(t);
        const video: SrsStreamVideo = {
            codec: 'h264',
            profile: 'High',
            level: '4.0',
            width: 1920,
            height: 1080,
            fps: 50,
        };
        for (const fieldOrder of ['progressive', 'unknown', null, undefined]) {
            assert.deepEqual(alerts({ video: { ...video, fieldOrder } }), [], String(fieldOrder));
        }
        assert.deepEqual(alerts({ video: null }), []);
    });
});

describe('input lifecycle: format changes', () => {
    test('the first probe records a format; a different one later restarts the running outputs', (t) => {
        const { lifecycle, observe, formatRestarts, logs, events, tick } = setup(t);
        observe(stream());
        lifecycle.noteProbe(1, probeResult(1920));
        assert.deepEqual(formatRestarts, []);
        tick(10 * SEC);
        lifecycle.noteProbe(1, probeResult(1920)); // same format: nothing
        assert.deepEqual(formatRestarts, []);

        tick(10 * SEC);
        lifecycle.noteProbe(1, probeResult(1280));
        assert.equal(formatRestarts.length, 1);
        // assert.deepEqual above narrowed the array to never[]; read it as declared.
        const [restart] = formatRestarts as FormatRestart[];
        assert.equal(restart.since, START);
        assert.match(
            restart.why,
            /^input format changed from h264 1920x1080, 1 audio track to h264 1280x1080, 1 audio track$/,
        );
        assert.equal(logs.at(-1)?.event, 'format_changed');
        assert.match(logs.at(-1)?.message ?? '', /restarting 3 running outputs$/);
        const changed = events.find((e) => e.event === 'input-format-changed');
        assert.ok(changed);
        assert.equal(changed.outputsRestarted, 3);
        assert.equal(changed.suppressed, false);
    });

    test('a second change within a minute is logged but restarts nothing', (t) => {
        const { lifecycle, observe, formatRestarts, logs, tick } = setup(t);
        observe(stream());
        lifecycle.noteProbe(1, probeResult(1920));
        lifecycle.noteProbe(1, probeResult(1280));
        tick(30 * SEC);
        lifecycle.noteProbe(1, probeResult(1920));
        assert.equal(formatRestarts.length, 1);
        assert.match(
            logs.at(-1)?.message ?? '',
            /outputs not restarted \(another format restart less than 60 s ago\)$/,
        );

        tick(31 * SEC);
        lifecycle.noteProbe(1, probeResult(1280));
        assert.equal(formatRestarts.length, 2);
    });

    test('a change with no known publisher start restarts nothing', (t) => {
        const { lifecycle, formatRestarts, events } = setup(t);
        lifecycle.noteProbe(1, probeResult(1920));
        lifecycle.noteProbe(1, probeResult(1280));
        assert.deepEqual(formatRestarts, []);
        assert.equal(events.find((e) => e.event === 'input-format-changed')?.outputsRestarted, 0);
    });
});
