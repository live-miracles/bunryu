'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db/index');
const { createRenditionReconciler } = require('../src/services/renditions');
const {
    isRenditionOutput,
    encodeRecipe,
    recipeOfRendition,
    renditionUrl,
} = require('../src/utils/renditions');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeOutputService() {
    const calls = [];
    // Outputs currently reading a rendition, by rendition id (tests set it).
    const readers = new Map();
    return {
        calls,
        readers,
        readersOf: (id) => readers.get(id) ?? 0,
        async start(id) {
            calls.push(['start', id]);
        },
        stop(id) {
            calls.push(['stop', id]);
        },
        async stopAndWait(id) {
            calls.push(['stopAndWait', id]);
        },
        clearRetryState(id) {
            calls.push(['clearRetryState', id]);
        },
    };
}

function harness(t) {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
    const db = createDb(':memory:');
    const outputService = fakeOutputService();
    const events = [];
    const diagnostics = { event: (name, fields) => events.push([name, fields]), close() {} };
    const reconciler = createRenditionReconciler(db, outputService, diagnostics);
    reconciler.start();
    t.after(() => reconciler.shutdown());
    return {
        db,
        outputService,
        events,
        eventNames: () => events.map((e) => e[0]),
        // One reconciler tick: advance the interval and let its async work finish.
        async tick(ms = 1000) {
            t.mock.timers.tick(ms);
            await flush();
            await flush();
        },
        renditions: (pipelineId) => db.listOutputsForPipeline(pipelineId).filter(isRenditionOutput),
        // Adds an output. A recipe is only shared when two outputs are configured with
        // it, so an output that needs an encode gets a stopped twin unless `solo`.
        addUser(
            pipelineId,
            { video = 'copy', audio = 'copy', desired = 'stopped', url, solo = false } = {},
        ) {
            const make = (dest, state) => {
                const o = db.createOutput({
                    pipelineId,
                    name: `${video}/${audio}`,
                    url: dest ?? `rtmp://dest.example/live/${Math.random().toString(36).slice(2)}`,
                    videoEncoding: video,
                    audioEncoding: audio,
                });
                if (state === 'running') db.setOutputDesiredState(o.id, 'running');
                return o;
            };
            const o = make(url, desired);
            const needsEncode = encodeRecipe({
                url: 'rtmp://x/y',
                videoEncoding: video,
                audioEncoding: audio,
            });
            if (needsEncode && !solo) make(undefined, 'stopped');
            return o;
        },
    };
}

describe('rendition reconciler: rows', () => {
    test('two outputs with the same recipe share one rendition row', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p', audio: '0', solo: true });
        h.addUser(p.id, { video: '720p', audio: '0', solo: true });

        await h.tick();

        const rows = h.renditions(p.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].name, 'Shared encode 720p · T1');
        assert.equal(rows[0].videoEncoding, '720p');
        assert.equal(rows[0].audioEncoding, '0');
        assert.equal(
            rows[0].url,
            renditionUrl(p.id, { videoEncoding: '720p', audioEncoding: '0', key: '720p_a0' }),
        );
        assert.equal(rows[0].desiredState, 'stopped');
        assert.deepEqual(h.eventNames(), ['rendition-created']);

        await h.tick();
        assert.equal(h.renditions(p.id).length, 1, 'ticks are idempotent');
        assert.deepEqual(h.eventNames(), ['rendition-created']);
    });

    test('two recipes make two rows', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p', audio: '0' });
        h.addUser(p.id, { video: 'copy', audio: '0' });

        await h.tick();

        assert.deepEqual(
            h
                .renditions(p.id)
                .map((r) => recipeOfRendition(r).key)
                .sort(),
            ['720p_a0', 'copy_a0'],
        );
    });

    test('recipes are per pipeline', async (t) => {
        const h = harness(t);
        const p1 = h.db.createPipeline();
        const p2 = h.db.createPipeline();
        h.addUser(p1.id, { video: '720p' });
        h.addUser(p2.id, { video: '720p' });

        await h.tick();

        assert.equal(h.renditions(p1.id).length, 1);
        assert.equal(h.renditions(p2.id).length, 1);
        assert.notEqual(h.renditions(p1.id)[0].url, h.renditions(p2.id)[0].url);
    });

    test('the same recipe once in each of two pipelines shares nothing: the count is per pipeline', async (t) => {
        const h = harness(t);
        const p1 = h.db.createPipeline();
        const p2 = h.db.createPipeline();
        h.addUser(p1.id, { video: '720p', solo: true });
        h.addUser(p2.id, { video: '720p', solo: true });

        await h.tick();

        assert.equal(h.renditions(p1.id).length, 0);
        assert.equal(h.renditions(p2.id).length, 0);
        assert.deepEqual(h.eventNames(), []);
    });

    test('plain copy, multi-track and translation outputs get no rendition', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: 'copy', audio: 'copy' });
        h.addUser(p.id, { video: 'copy', audio: '0,1', url: 'srt://h:1?mode=caller' });
        h.addUser(p.id, { video: '720p', audio: '0,1', url: 'srt://h:2?mode=caller' });

        await h.tick();

        assert.equal(h.renditions(p.id).length, 0);
    });

    test('a stopped user output still keeps its rendition row', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '1080p' });

        await h.tick();
        await h.tick(60_000);

        assert.equal(h.renditions(p.id).length, 1);
    });

    test('editing one of two 720p outputs to copy leaves a single output, so the row is deleted after stopAndWait', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        const o = h.addUser(p.id, { video: '720p' });
        await h.tick();
        const row = h.renditions(p.id)[0];

        h.db.updateOutput(o.id, {
            name: 'now copy',
            videoEncoding: 'copy',
            url: o.url,
            audioEncoding: 'copy',
        });
        await h.tick();

        assert.equal(h.renditions(p.id).length, 0);
        assert.deepEqual(
            h.outputService.calls.filter((c) => c[1] === row.id),
            [
                ['stopAndWait', row.id],
                ['clearRetryState', row.id],
            ],
        );
        assert.deepEqual(h.eventNames(), ['rendition-created', 'rendition-deleted']);
    });

    test('deleting one of two outputs with a recipe deletes its row; another recipe keeps its own', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        const a = h.addUser(p.id, { video: '720p' });
        h.addUser(p.id, { video: '1080p' });
        await h.tick();
        assert.equal(h.renditions(p.id).length, 2);

        h.db.deleteOutput(a.id);
        await h.tick();

        assert.deepEqual(
            h.renditions(p.id).map((r) => r.videoEncoding),
            ['1080p'],
        );
    });

    test('a rendition whose URL no longer matches the SRS RTMP port is replaced', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p' });
        const stale = h.db.createOutput({
            pipelineId: p.id,
            name: 'Shared encode 720p · source audio',
            url: `rtmp://127.0.0.1:9/internal/r${p.id}_720p_acopy`,
            videoEncoding: '720p',
            audioEncoding: 'copy',
        });

        await h.tick();

        const rows = h.renditions(p.id);
        assert.equal(
            rows.some((r) => r.id === stale.id),
            false,
        );
        assert.equal(rows.length, 1);
        assert.notEqual(rows[0].url, stale.url);
    });

    test('a deleted pipeline is never recreated rows for', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p' });
        await h.tick();
        assert.equal(h.renditions(p.id).length, 1);

        h.db.deletePipeline(p.id);
        await h.tick();
        await h.tick();

        assert.equal(h.db.listOutputs().length, 0);
        assert.deepEqual(h.eventNames(), ['rendition-created']);
    });

    test('a running rendition is set desired-stopped before it is killed, so it is not respawned', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        const o = h.addUser(p.id, { video: '720p', desired: 'running' });
        await h.tick();
        const row = h.renditions(p.id)[0];
        assert.equal(row.desiredState, 'running');
        const desiredAtKill = [];
        h.outputService.stopAndWait = async (id) => {
            desiredAtKill.push(h.db.getOutput(id).desiredState);
        };

        h.db.deleteOutput(o.id);
        await h.tick();

        assert.deepEqual(desiredAtKill, ['stopped']);
        assert.equal(h.renditions(p.id).length, 0);
    });

    test('a dependent added while the rendition is being stopped keeps the row', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        const o = h.addUser(p.id, { video: '720p' });
        await h.tick();
        const row = h.renditions(p.id)[0];
        h.db.updateOutput(o.id, {
            name: 'copy',
            videoEncoding: 'copy',
            url: o.url,
            audioEncoding: 'copy',
        });
        h.outputService.stopAndWait = async (id) => {
            h.outputService.calls.push(['stopAndWait', id]);
            // The user flips an output back to 720p while we are stopping.
            h.db.updateOutput(o.id, {
                name: 'back',
                videoEncoding: '720p',
                url: o.url,
                audioEncoding: 'copy',
            });
        };

        await h.tick();

        assert.equal(h.renditions(p.id).length, 1);
        assert.equal(h.renditions(p.id)[0].id, row.id);
        assert.equal(h.eventNames().includes('rendition-deleted'), false);
    });
});

describe('rendition reconciler: desired state', () => {
    test('a running dependent turns the rendition on, once', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p', desired: 'running' });

        await h.tick();
        const row = h.renditions(p.id)[0];
        assert.equal(row.desiredState, 'running');
        assert.deepEqual(
            h.outputService.calls.filter((c) => c[0] === 'start'),
            [['start', row.id]],
        );

        await h.tick();
        await h.tick();
        assert.equal(
            h.outputService.calls.filter((c) => c[0] === 'start').length,
            1,
            'start() resets backoff, so it must not be called every tick',
        );
    });

    test('a stopped rendition is not started while no dependent runs', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p' });

        await h.tick();
        await h.tick(20_000);

        assert.equal(h.renditions(p.id)[0].desiredState, 'stopped');
        assert.equal(h.outputService.calls.filter((c) => c[0] === 'start').length, 0);
        assert.equal(h.outputService.calls.filter((c) => c[0] === 'stop').length, 0);
    });

    test('it idle-stops 15 s after the last dependent stopped, not before', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        const o = h.addUser(p.id, { video: '720p', desired: 'running' });
        await h.tick();
        const row = h.renditions(p.id)[0];

        h.db.setOutputDesiredState(o.id, 'stopped');
        await h.tick(); // grace starts
        await h.tick(10_000);
        assert.equal(h.db.getOutput(row.id).desiredState, 'running');
        await h.tick(4_000);
        assert.equal(h.db.getOutput(row.id).desiredState, 'running', '14 s: still in grace');
        await h.tick(2_000);

        assert.equal(h.db.getOutput(row.id).desiredState, 'stopped');
        assert.deepEqual(
            h.outputService.calls.filter((c) => c[0] === 'stop'),
            [['stop', row.id]],
        );
        const idle = h.events.find((e) => e[0] === 'rendition-idle-stop');
        assert.ok(idle);
        assert.equal(idle[1].outputId, row.id);
        assert.ok(idle[1].idleMs >= 15_000);
    });

    test('a quick stop/start keeps the same encode running (no restart)', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        const o = h.addUser(p.id, { video: '720p', desired: 'running' });
        await h.tick();
        const row = h.renditions(p.id)[0];

        h.db.setOutputDesiredState(o.id, 'stopped');
        await h.tick(5_000);
        h.db.setOutputDesiredState(o.id, 'running');
        await h.tick(5_000);
        await h.tick(30_000);

        assert.equal(h.db.getOutput(row.id).desiredState, 'running');
        assert.equal(h.outputService.calls.filter((c) => c[0] === 'start').length, 1);
        assert.equal(h.outputService.calls.filter((c) => c[0] === 'stop').length, 0);
    });

    test('the grace restarts from zero each time the last dependent stops', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        const o = h.addUser(p.id, { video: '720p', desired: 'running' });
        await h.tick();
        const row = h.renditions(p.id)[0];

        h.db.setOutputDesiredState(o.id, 'stopped');
        await h.tick(10_000);
        h.db.setOutputDesiredState(o.id, 'running');
        await h.tick(1_000);
        h.db.setOutputDesiredState(o.id, 'stopped');
        await h.tick(10_000);

        assert.equal(h.db.getOutput(row.id).desiredState, 'running', 'only 10 s since last stop');
    });

    test('with two dependents the rendition stays up until both are stopped', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        const a = h.addUser(p.id, { video: '720p', desired: 'running', solo: true });
        const b = h.addUser(p.id, { video: '720p', desired: 'running', solo: true });
        await h.tick();
        const row = h.renditions(p.id)[0];

        h.db.setOutputDesiredState(a.id, 'stopped');
        await h.tick(30_000);
        assert.equal(h.db.getOutput(row.id).desiredState, 'running');
        h.db.setOutputDesiredState(b.id, 'stopped');
        await h.tick();
        await h.tick(16_000);

        assert.equal(h.db.getOutput(row.id).desiredState, 'stopped');
    });

    test('after an app restart a rendition with no running dependent stops after 15 s', async (t) => {
        t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
        const db = createDb(':memory:');
        const p = db.createPipeline();
        const recipe = encodeRecipe({
            url: 'rtmp://x/y',
            videoEncoding: '720p',
            audioEncoding: 'copy',
        });
        for (const dest of ['a', 'b']) {
            db.createOutput({
                pipelineId: p.id,
                name: 'u',
                url: `rtmp://dest.example/live/${dest}`,
                videoEncoding: '720p',
            });
        }
        const row = db.createOutput({
            pipelineId: p.id,
            name: 'r',
            url: renditionUrl(p.id, recipe),
            videoEncoding: '720p',
            audioEncoding: 'copy',
        });
        db.setOutputDesiredState(row.id, 'running');
        const svc = fakeOutputService();
        const rec = createRenditionReconciler(db, svc);
        rec.start();
        t.after(() => rec.shutdown());

        t.mock.timers.tick(1000);
        await flush();
        assert.equal(db.getOutput(row.id).desiredState, 'running');
        t.mock.timers.tick(15_000);
        await flush();
        await flush();

        assert.equal(db.getOutput(row.id).desiredState, 'stopped');
        assert.deepEqual(
            svc.calls.filter((c) => c[0] === 'stop'),
            [['stop', row.id]],
        );
    });

    test('a failing start is logged, reverted to stopped, and retried no faster than every 30 s', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p', desired: 'running' });
        h.outputService.start = async (id) => {
            h.outputService.calls.push(['start', id]);
            throw new Error('Pipeline not found');
        };

        await h.tick();
        const row = h.renditions(p.id)[0];
        assert.equal(h.db.getOutput(row.id).desiredState, 'stopped');
        assert.ok(h.eventNames().includes('rendition-start-error'));

        for (let i = 0; i < 20; i++) await h.tick();
        assert.equal(h.outputService.calls.filter((c) => c[0] === 'start').length, 1);
        await h.tick(15_000);
        assert.equal(h.outputService.calls.filter((c) => c[0] === 'start').length, 2);
    });
});

describe('rendition reconciler: robustness', () => {
    test('a tick that throws is logged and the next tick still runs', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p' });
        const real = h.db.listOutputs;
        let fail = true;
        h.db.listOutputs = () => {
            if (fail) throw new Error('db is busy');
            return real.call(h.db);
        };

        await h.tick();
        assert.equal(h.eventNames()[0], 'rendition-reconcile-error');
        assert.match(h.events[0][1].error, /db is busy/);
        assert.equal(h.renditions(p.id).length, 0);

        fail = false;
        await h.tick();
        assert.equal(h.renditions(p.id).length, 1);
    });

    test('a rejected stopAndWait does not stop the other pipelines from reconciling', async (t) => {
        const h = harness(t);
        const p1 = h.db.createPipeline();
        const p2 = h.db.createPipeline();
        const o = h.addUser(p1.id, { video: '720p' });
        await h.tick();
        h.db.updateOutput(o.id, {
            name: 'c',
            videoEncoding: 'copy',
            url: o.url,
            audioEncoding: 'copy',
        });
        h.outputService.stopAndWait = async () => {
            throw new Error('kill failed');
        };
        h.addUser(p2.id, { video: '1080p' });

        await h.tick();

        assert.equal(h.renditions(p2.id).length, 1);
        assert.ok(h.eventNames().includes('rendition-reconcile-error'));
    });

    test('ticks do not overlap while a stop is in flight', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        const o = h.addUser(p.id, { video: '720p' });
        await h.tick();
        h.db.updateOutput(o.id, {
            name: 'c',
            videoEncoding: 'copy',
            url: o.url,
            audioEncoding: 'copy',
        });
        let release;
        let stops = 0;
        h.outputService.stopAndWait = () => {
            stops++;
            return new Promise((resolve) => (release = resolve));
        };

        await h.tick();
        await h.tick();
        await h.tick();
        assert.equal(stops, 1);
        release();
        await flush();
        await flush();
        assert.equal(h.renditions(p.id).length, 0);
    });

    test('shutdown stops ticking', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p' });
        await h.tick();
        const rec2events = h.events.length;

        // A second reconciler on the same harness, shut down immediately.
        const rec = createRenditionReconciler(h.db, h.outputService);
        rec.start();
        rec.shutdown();
        h.addUser(p.id, { video: '1080p' });
        await h.tick();

        // The harness reconciler is still alive and created the new row exactly once.
        assert.equal(h.renditions(p.id).length, 2);
        assert.equal(h.events.length, rec2events + 1);
    });
});

describe('rendition reconciler: when to share', () => {
    test('a single output with a recipe gets no rendition and nothing is started', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p', audio: '1', desired: 'running', solo: true });

        await h.tick();
        await h.tick(30_000);

        assert.equal(h.renditions(p.id).length, 0);
        assert.deepEqual(h.outputService.calls, []);
        assert.deepEqual(h.eventNames(), []);
    });

    test('adding the second output starts the encode at once, even though the first runs direct', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p', desired: 'running', solo: true });
        await h.tick();
        assert.equal(h.renditions(p.id).length, 0);

        h.addUser(p.id, { video: '720p', desired: 'stopped', solo: true });
        await h.tick();

        const [row] = h.renditions(p.id);
        assert.ok(row, 'the row appears');
        assert.equal(row.desiredState, 'running', 'the running first output counts as "on"');
        assert.deepEqual(
            h.outputService.calls.filter((c) => c[0] === 'start'),
            [['start', row.id]],
        );
    });

    test('with both outputs stopped the row exists but nothing runs', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p', solo: true });
        h.addUser(p.id, { video: '720p', solo: true });

        await h.tick();
        await h.tick(30_000);

        assert.equal(h.renditions(p.id).length, 1);
        assert.equal(h.renditions(p.id)[0].desiredState, 'stopped');
        assert.equal(h.outputService.calls.filter((c) => c[0] === 'start').length, 0);
    });

    test('a rendition that outputs are still reading is not removed when the count drops to one', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        const a = h.addUser(p.id, { video: '720p', desired: 'running', solo: true });
        const b = h.addUser(p.id, { video: '720p', desired: 'running', solo: true });
        await h.tick();
        const row = h.renditions(p.id)[0];
        h.outputService.readers.set(row.id, 2);

        h.db.deleteOutput(b.id); // a is left alone on the shared encode
        await h.tick();
        await h.tick();
        await h.tick();

        assert.equal(h.renditions(p.id).length, 1, 'kept while a reader runs');
        assert.equal(h.outputService.calls.filter((c) => c[0] === 'stopAndWait').length, 0);
        assert.equal(h.db.getOutput(row.id).desiredState, 'running');
        assert.deepEqual(
            h.eventNames().filter((n) => n === 'rendition-removal-deferred'),
            ['rendition-removal-deferred'],
            'logged once, not every tick',
        );
        const deferred = h.events.find((e) => e[0] === 'rendition-removal-deferred');
        assert.equal(deferred[1].outputId, row.id);
        assert.equal(deferred[1].readers, 2);

        h.outputService.readers.set(row.id, 0); // a stops or restarts (and goes direct)
        h.db.setOutputDesiredState(a.id, 'stopped');
        await h.tick();

        assert.equal(h.renditions(p.id).length, 0, 'removed once nothing reads it');
        assert.deepEqual(
            h.outputService.calls.filter((c) => c[1] === row.id && c[0] !== 'start'),
            [
                ['stopAndWait', row.id],
                ['clearRetryState', row.id],
            ],
        );
    });

    test('a deferred removal is forgotten if the count recovers, so a later drop is logged again', async (t) => {
        const h = harness(t);
        const p = h.db.createPipeline();
        h.addUser(p.id, { video: '720p', desired: 'running', solo: true });
        const b = h.addUser(p.id, { video: '720p', desired: 'running', solo: true });
        await h.tick();
        const row = h.renditions(p.id)[0];
        h.outputService.readers.set(row.id, 1);

        h.db.updateOutput(b.id, {
            name: 'x',
            videoEncoding: 'copy',
            url: b.url,
            audioEncoding: 'copy',
        });
        await h.tick();
        h.db.updateOutput(b.id, {
            name: 'x',
            videoEncoding: '720p',
            url: b.url,
            audioEncoding: 'copy',
        });
        await h.tick();
        h.db.updateOutput(b.id, {
            name: 'x',
            videoEncoding: 'copy',
            url: b.url,
            audioEncoding: 'copy',
        });
        await h.tick();

        assert.equal(h.eventNames().filter((n) => n === 'rendition-removal-deferred').length, 2);
        assert.equal(h.renditions(p.id).length, 1);
    });
});
