'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db/index');

// Each helper creates a fresh isolated in-memory DB
const makeDb = () => createDb(':memory:');

// ── Stream keys ───────────────────────────────────────

describe('Stream keys', () => {
    test('seeds exactly 99 slots on init', () => {
        assert.equal(makeDb().listStreamKeys().length, 99);
    });

    test('all keys match expected format', () => {
        for (const k of makeDb().listStreamKeys()) {
            assert.match(k.key, /^key\d{2}_[a-f0-9]{32}$/);
        }
    });

    test('keys are ordered by slot 1–99', () => {
        const keys = makeDb().listStreamKeys();
        assert.equal(keys[0].slot, 1);
        assert.equal(keys[98].slot, 99);
    });
});

// ── Pipeline CRUD ─────────────────────────────────────

describe('Pipeline CRUD', () => {
    test('createPipeline returns a pipeline with a stream key', () => {
        const p = makeDb().createPipeline();
        assert.ok(p.id > 0);
        assert.ok(p.streamKey.startsWith('key'));
        assert.ok(p.streamKeyId > 0);
    });

    test('getPipeline returns the created pipeline', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const got = db.getPipeline(p.id);
        assert.equal(got?.name, p.name);
        assert.equal(got?.streamKey, p.streamKey);
    });

    test('getPipeline returns undefined for unknown id', () => {
        assert.equal(makeDb().getPipeline(9999), undefined);
    });

    test('listPipelines returns all created pipelines', () => {
        const db = makeDb();
        db.createPipeline();
        db.createPipeline();
        assert.equal(db.listPipelines().length, 2);
    });

    test('updatePipeline changes name', () => {
        const db = makeDb();
        const p = db.createPipeline();
        db.updatePipeline(p.id, 'Renamed');
        assert.equal(db.getPipeline(p.id)?.name, 'Renamed');
    });

    test('two pipelines receive different stream keys', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        assert.notEqual(p1.streamKey, p2.streamKey);
    });

    test('deletePipeline removes the pipeline', () => {
        const db = makeDb();
        const p = db.createPipeline();
        assert.ok(db.deletePipeline(p.id));
        assert.equal(db.getPipeline(p.id), undefined);
    });

    test('deleted pipeline key becomes available for a new pipeline', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        db.deletePipeline(p1.id);
        // Fill all 99 slots — should succeed since one key was freed
        for (let i = 0; i < 99; i++) db.createPipeline();
    });

    test('createPipeline throws when all 99 keys are assigned', () => {
        const db = makeDb();
        for (let i = 0; i < 99; i++) db.createPipeline();
        assert.throws(() => db.createPipeline(), /No unassigned stream keys/);
    });

    test('deletePipeline returns false for an unknown id (no throw, no rev bump)', () => {
        const db = makeDb();
        const rev = db.getConfigRev();
        assert.equal(db.deletePipeline(9999), false);
        assert.equal(db.getConfigRev(), rev);
    });

    test('updatePipeline returns null for an unknown id', () => {
        const db = makeDb();
        assert.equal(db.updatePipeline(9999, 'X'), null);
    });

    test('createPipeline fills the gap left by a deleted middle id', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        const p3 = db.createPipeline();
        db.deletePipeline(p2.id);
        const p4 = db.createPipeline();
        assert.equal(p4.id, p2.id);
        assert.deepEqual(
            db
                .listPipelines()
                .map((p) => p.id)
                .sort((a, b) => a - b),
            [p1.id, p3.id, p4.id].sort((a, b) => a - b),
        );
    });

    test('updatePipeline can reassign the stream key, and the join reflects it immediately', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        const updated = db.updatePipeline(p1.id, p1.name, p2.streamKeyId);
        assert.equal(updated.streamKeyId, p2.streamKeyId);
        assert.equal(updated.streamKey, p2.streamKey);
    });

    // The UI deliberately allows this and flags it with a "duplicate stream
    // key" warning instead of rejecting it outright (same treatment as
    // duplicate output destination URLs) — see public/ts/features/render.ts.
    test('updatePipeline allows reassigning to a key another pipeline already holds', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        db.updatePipeline(p1.id, p1.name, p2.streamKeyId);
        assert.equal(db.getPipeline(p1.id).streamKeyId, p2.streamKeyId);
        assert.equal(db.getPipeline(p2.id).streamKeyId, p2.streamKeyId);
    });

    test('updatePipeline rejects a stream key id that does not exist (FK constraint)', () => {
        const db = makeDb();
        const p = db.createPipeline();
        assert.throws(() => db.updatePipeline(p.id, p.name, 999999), /FOREIGN KEY/);
    });

    test('created pipelines start with no group', () => {
        assert.equal(makeDb().createPipeline().groupId, null);
    });

    test('updatePipeline with an omitted groupId leaves the existing group untouched', () => {
        const db = makeDb();
        const [group] = db.replacePipelineGroups([{ name: 'Main' }]);
        const p = db.createPipeline();
        db.updatePipeline(p.id, p.name, undefined, group.id);
        const updated = db.updatePipeline(p.id, 'Renamed');
        assert.equal(updated.groupId, group.id);
    });

    test('updatePipeline with an explicit null groupId clears the group', () => {
        const db = makeDb();
        const [group] = db.replacePipelineGroups([{ name: 'Main' }]);
        const p = db.createPipeline();
        db.updatePipeline(p.id, p.name, undefined, group.id);
        const updated = db.updatePipeline(p.id, p.name, undefined, null);
        assert.equal(updated.groupId, null);
    });

    test('updatePipeline rejects a group id that does not exist (FK constraint)', () => {
        const db = makeDb();
        const p = db.createPipeline();
        assert.throws(() => db.updatePipeline(p.id, p.name, undefined, 999999), /FOREIGN KEY/);
    });
});

describe('Translation output settings', () => {
    test('stores translation settings directly on individual outputs', () => {
        const db = makeDb();
        const source = db.createPipeline();
        const french = db.createPipeline();
        const spanish = db.createPipeline();
        const frenchOutput = db.createOutput({
            pipelineId: source.id,
            name: 'French',
            url: 'rtmp://french',
            translation: { translatorStreamKey: french.streamKey, translationDelayMs: 700 },
        });
        const spanishOutput = db.createOutput({
            pipelineId: source.id,
            name: 'Spanish',
            url: 'rtmp://spanish',
            translation: { translatorStreamKey: spanish.streamKey, translationDelayMs: 1200 },
        });

        assert.equal(frenchOutput.translation.translatorStreamKey, french.streamKey);
        assert.equal(frenchOutput.translation.translationDelayMs, 700);
        assert.equal(frenchOutput.translation.sourceTrackIndex, 0);
        assert.equal(frenchOutput.translation.translatorTrackIndex, 0);
        assert.equal(spanishOutput.translation.translatorStreamKey, spanish.streamKey);
        assert.equal(spanishOutput.translation.translationDelayMs, 1200);
        assert.equal(db.listPipelines().length, 3);
    });

    test('stores an explicit source/translator track selection', () => {
        const db = makeDb();
        const source = db.createPipeline();
        const french = db.createPipeline();
        const output = db.createOutput({
            pipelineId: source.id,
            name: 'French',
            url: 'rtmp://french',
            translation: {
                translatorStreamKey: french.streamKey,
                sourceTrackIndex: 2,
                translatorTrackIndex: 1,
            },
        });
        assert.equal(output.translation.sourceTrackIndex, 2);
        assert.equal(output.translation.translatorTrackIndex, 1);
    });
});

describe('getPipelineByStreamKey', () => {
    test('resolves the pipeline currently holding a stream key', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        assert.equal(db.getPipelineByStreamKey(p1.streamKey).id, p1.id);
        assert.equal(db.getPipelineByStreamKey(p2.streamKey).id, p2.id);
    });

    test('returns undefined for a key no pipeline holds', () => {
        const db = makeDb();
        db.createPipeline();
        assert.equal(db.getPipelineByStreamKey('not-a-real-key'), undefined);
    });

    // Slot collisions are intentional (see updatePipeline) — resolution must
    // still return a single, deterministic pipeline rather than throwing.
    test('deterministically picks one pipeline when a key is shared', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        db.updatePipeline(p2.id, p2.name, p1.streamKeyId);
        const resolved = db.getPipelineByStreamKey(p1.streamKey);
        assert.equal(resolved.id, p1.id);
    });
});

describe('regenerateStreamKeys', () => {
    test('replaces every key value but keeps slot count and ordering', () => {
        const db = makeDb();
        const before = db.listStreamKeys();
        const after = db.regenerateStreamKeys();
        assert.equal(after.length, 99);
        for (let i = 0; i < 99; i++) {
            assert.equal(after[i].slot, before[i].slot);
            assert.equal(after[i].id, before[i].id);
            assert.notEqual(after[i].key, before[i].key);
            assert.match(after[i].key, /^key\d{2}_[a-f0-9]{32}$/);
        }
    });

    test('bumps the config revision', () => {
        const db = makeDb();
        const rev = db.getConfigRev();
        db.regenerateStreamKeys();
        assert.ok(db.getConfigRev() > rev);
    });

    test('an assigned pipeline sees its new key via the join, keeping the same streamKeyId', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const oldKey = p.streamKey;
        db.regenerateStreamKeys();
        const got = db.getPipeline(p.id);
        assert.equal(got.streamKeyId, p.streamKeyId);
        assert.notEqual(got.streamKey, oldKey);
    });
});

// ── Output CRUD ───────────────────────────────────────

describe('Output CRUD', () => {
    test('createOutput and getOutput round-trip', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({
            pipelineId: p.id,
            name: 'YouTube',
            url: 'rtmp://a.rtmp.youtube.com/live2/key',
        });
        const got = db.listOutputs().find((out) => out.id === o.id);
        assert.equal(got?.name, 'YouTube');
        assert.equal(got?.url, 'rtmp://a.rtmp.youtube.com/live2/key');
        assert.equal(got?.audioEncoding, 'copy');
        assert.equal(got?.desiredState, 'stopped');
        assert.equal(got?.videoEncoding, 'copy');
    });

    test('createOutput persists a custom audio encoding', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({
            pipelineId: p.id,
            name: 'French track',
            url: 'rtmp://fr',
            audioEncoding: '1',
        });
        const got = db.listOutputs().find((out) => out.id === o.id);
        assert.equal(got?.url, 'rtmp://fr');
        assert.equal(got?.audioEncoding, '1');
    });

    test('listOutputsForPipeline scopes to the right pipeline', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        db.createOutput({ pipelineId: p1.id, name: 'A', url: 'rtmp://a' });
        db.createOutput({ pipelineId: p2.id, name: 'B', url: 'rtmp://b' });
        const outs = db.listOutputsForPipeline(p1.id);
        assert.equal(outs.length, 1);
        assert.equal(outs[0].name, 'A');
    });

    test('multiple outputs on same pipeline get sequential seq numbers', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o1 = db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
        const o2 = db.createOutput({ pipelineId: p.id, name: 'B', url: 'rtmp://b' });
        assert.equal(o1.seq, 1);
        assert.equal(o2.seq, 2);
    });

    test('createOutputs creates a batch with sequential seq numbers', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const revBefore = db.getConfigRev();
        const created = db.createOutputs([
            { pipelineId: p.id, name: 'A', url: 'rtmp://a' },
            { pipelineId: p.id, name: 'B', videoEncoding: '720p', url: 'rtmp://b' },
            { pipelineId: p.id, name: 'C', url: 'srt://c' },
        ]);
        assert.deepEqual(
            created.map((o) => [o.name, o.seq]),
            [
                ['A', 1],
                ['B', 2],
                ['C', 3],
            ],
        );
        assert.equal(created[1].videoEncoding, '720p');
        assert.equal(db.listOutputsForPipeline(p.id).length, 3);
        assert.ok(db.getConfigRev() > revBefore);
    });

    test('createOutputs rolls the whole batch back when one row fails', () => {
        const db = makeDb();
        const p = db.createPipeline();
        assert.throws(() =>
            db.createOutputs([
                { pipelineId: p.id, name: 'A', url: 'rtmp://a' },
                // Violates the outputs.pipeline_id NOT NULL constraint mid-batch.
                { pipelineId: null, name: 'B', url: 'rtmp://b' },
            ]),
        );
        assert.equal(db.listOutputsForPipeline(p.id).length, 0);
    });

    test('setOutputDesiredState persists the change', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
        db.setOutputDesiredState(o.id, 'running');
        assert.equal(db.listOutputs().find((out) => out.id === o.id)?.desiredState, 'running');
    });

    test('updateOutput persists name, encoding, and destination changes', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({
            pipelineId: p.id,
            name: 'Old',
            url: 'rtmp://old',
        });
        db.updateOutput(o.id, {
            name: 'New',
            videoEncoding: '720p',
            url: 'rtmp://new',
            audioEncoding: '2',
        });
        const got = db.listOutputs().find((out) => out.id === o.id);
        assert.equal(got?.name, 'New');
        assert.equal(got?.videoEncoding, '720p');
        assert.equal(got?.url, 'rtmp://new');
        assert.equal(got?.audioEncoding, '2');
    });

    test('updateOutput overwrites the destination rather than merging', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({
            pipelineId: p.id,
            name: 'X',
            url: 'rtmp://a',
            audioEncoding: '0',
        });
        db.updateOutput(o.id, {
            name: 'X',
            videoEncoding: 'copy',
            url: 'rtmp://only',
            audioEncoding: 'copy',
        });
        const got = db.listOutputs().find((out) => out.id === o.id);
        assert.equal(got?.url, 'rtmp://only');
        assert.equal(got?.audioEncoding, 'copy');
    });

    test('deleteOutput removes the output', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
        assert.ok(db.deleteOutput(o.id));
        assert.equal(
            db.listOutputs().find((out) => out.id === o.id),
            undefined,
        );
    });

    test('setOutputLastError keeps the ten most recent errors', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

        for (let i = 1; i <= 12; i++) db.setOutputLastError(o.id, `error ${i}`, 'crash');

        const history = db.getOutputErrorHistory(o.id);
        assert.deepEqual(
            history.map((e) => e.message),
            Array.from({ length: 10 }, (_, i) => `error ${i + 3}`),
        );

        const got = db.getOutput(o.id);
        assert.match(got?.lastError ?? '', /error 12$/);
    });

    test('warning entries never supersede a crash and never push crashes out', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

        db.setOutputLastError(o.id, 'ffmpeg crashed', 'crash');
        db.setOutputLastError(o.id, 'timestamp warnings stopped', 'warning');
        // A warning after the crash does not clear it as the current error.
        assert.match(db.getOutput(o.id)?.lastError ?? '', /ffmpeg crashed$/);

        for (let i = 1; i <= 20; i++) db.setOutputLastError(o.id, `warning ${i}`, 'warning');
        const history = db.getOutputErrorHistory(o.id);
        assert.equal(history.filter((e) => e.kind === 'warning').length, 5);
        assert.deepEqual(
            history.filter((e) => e.kind === 'warning').map((e) => e.message),
            ['warning 16', 'warning 17', 'warning 18', 'warning 19', 'warning 20'],
        );
        assert.ok(
            history.some((e) => e.message === 'ffmpeg crashed'),
            'crash is retained',
        );

        // A stop still supersedes the crash even with warnings after it.
        db.setOutputLastError(o.id, '', 'stopped');
        assert.equal(db.getOutput(o.id)?.lastError, null);
    });

    test('a stopped entry after a crash supersedes it as the current error', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

        db.setOutputLastError(o.id, 'ffmpeg crashed', 'crash');
        db.setOutputLastError(o.id, 'leftover stderr from a manual stop', 'stopped');

        const history = db.getOutputErrorHistory(o.id);
        assert.deepEqual(
            history.map((e) => ({ message: e.message, kind: e.kind })),
            [
                { message: 'ffmpeg crashed', kind: 'crash' },
                { message: 'leftover stderr from a manual stop', kind: 'stopped' },
            ],
        );

        // A deliberate stop always writes a 'stopped' marker (even with an
        // empty message), so it becomes the newest history entry and clears
        // the "current error" — the crash is still visible in history, just
        // no longer surfaced as current.
        const got = db.getOutput(o.id);
        assert.equal(got?.lastError, null);
        assert.equal(got?.hasErrorHistory, true);
    });

    test('stopped-only diagnostics surface as history without a current error', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

        db.setOutputLastError(o.id, 'leftover stderr from a manual stop', 'stopped');

        const got = db.getOutput(o.id);
        assert.equal(got?.lastError, null);
        assert.equal(got?.hasErrorHistory, true);

        const listed = db.listOutputIds().find((out) => out.id === o.id);
        assert.equal(listed?.lastError, null);
        assert.equal(listed?.hasErrorHistory, true);
    });

    test('deleting a pipeline cascades to its outputs', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
        db.deletePipeline(p.id);
        assert.equal(
            db.listOutputs().find((out) => out.id === o.id),
            undefined,
        );
    });

    test('createOutput rejects a pipelineId that does not exist (FK constraint)', () => {
        const db = makeDb();
        assert.throws(
            () => db.createOutput({ pipelineId: 9999, name: 'X', url: 'rtmp://x' }),
            /FOREIGN KEY/,
        );
    });

    test('getOutput returns null for an unknown id', () => {
        assert.equal(makeDb().getOutput('nope-1'), null);
    });

    test('deleteOutput returns false for an unknown id (no rev bump)', () => {
        const db = makeDb();
        const rev = db.getConfigRev();
        assert.equal(db.deleteOutput('nope-1'), false);
        assert.equal(db.getConfigRev(), rev);
    });

    test('updateOutput returns null for an unknown id', () => {
        const db = makeDb();
        assert.equal(
            db.updateOutput('nope-1', {
                name: 'X',
                videoEncoding: 'copy',
                url: 'rtmp://x',
                audioEncoding: 'copy',
            }),
            null,
        );
    });

    test('setOutputDesiredState returns null for an unknown id', () => {
        assert.equal(makeDb().setOutputDesiredState('nope-1', 'running'), null);
    });

    test('deleteOutputsForPipeline removes every output for that pipeline only', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        db.createOutput({ pipelineId: p1.id, name: 'A', url: 'rtmp://a' });
        db.createOutput({ pipelineId: p1.id, name: 'B', url: 'rtmp://b' });
        db.createOutput({ pipelineId: p2.id, name: 'C', url: 'rtmp://c' });
        db.deleteOutputsForPipeline(p1.id);
        assert.equal(db.listOutputsForPipeline(p1.id).length, 0);
        assert.equal(db.listOutputsForPipeline(p2.id).length, 1);
    });

    test('deleteOutputsForPipeline on a pipeline with no outputs does not bump the config rev', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const rev = db.getConfigRev();
        db.deleteOutputsForPipeline(p.id);
        assert.equal(db.getConfigRev(), rev);
    });

    test('setDesiredStateForPipeline flips every output in that pipeline at once', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        const a = db.createOutput({ pipelineId: p1.id, name: 'A', url: 'rtmp://a' });
        const b = db.createOutput({ pipelineId: p1.id, name: 'B', url: 'rtmp://b' });
        const c = db.createOutput({ pipelineId: p2.id, name: 'C', url: 'rtmp://c' });
        db.setDesiredStateForPipeline(p1.id, 'running');
        assert.equal(db.getOutput(a.id).desiredState, 'running');
        assert.equal(db.getOutput(b.id).desiredState, 'running');
        assert.equal(db.getOutput(c.id).desiredState, 'stopped');
    });

    test('clearLastErrorsForPipeline clears every output error in that pipeline only', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        const a = db.createOutput({ pipelineId: p1.id, name: 'A', url: 'rtmp://a' });
        const b = db.createOutput({ pipelineId: p2.id, name: 'B', url: 'rtmp://b' });
        db.setOutputLastError(a.id, 'boom', 'crash');
        db.setOutputLastError(b.id, 'boom', 'crash');
        db.clearLastErrorsForPipeline(p1.id);
        assert.equal(db.getOutput(a.id).lastError, null);
        assert.match(db.getOutput(b.id).lastError, /boom$/);
    });

    test('clearLastErrorsForPipeline does not bump the config revision', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
        db.setOutputLastError(o.id, 'boom', 'crash');
        const rev = db.getConfigRev();
        db.clearLastErrorsForPipeline(p.id);
        assert.equal(db.getConfigRev(), rev);
    });

    test('recreating an output after deleting the last one reuses its seq, not a running counter', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o1 = db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
        db.deleteOutput(o1.id);
        const o2 = db.createOutput({ pipelineId: p.id, name: 'B', url: 'rtmp://b' });
        assert.equal(o2.seq, 1);
        assert.equal(o2.id, o1.id);
    });
});

// ── Pipeline logs ─────────────────────────────────────

describe('Pipeline logs', () => {
    test('prunes older entries once the per-pipeline cap (100) is exceeded', () => {
        const db = makeDb();
        const p = db.createPipeline();
        for (let i = 0; i < 150; i++) db.appendPipelineLog(p.id, 'test', `msg ${i}`);
        const logs = db.getPipelineLogs(p.id, 1000);
        assert.equal(logs.length, 100);
        // Newest first; oldest surviving is msg 50 (0..49 pruned), newest is msg 149.
        assert.equal(logs[0].message, 'msg 149');
        assert.equal(logs[logs.length - 1].message, 'msg 50');
    });

    test('pruning is scoped per pipeline, not global', () => {
        const db = makeDb();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        for (let i = 0; i < 60; i++) db.appendPipelineLog(p1.id, 'test', `p1-${i}`);
        for (let i = 0; i < 60; i++) db.appendPipelineLog(p2.id, 'test', `p2-${i}`);
        assert.equal(db.getPipelineLogs(p1.id, 1000).length, 60);
        assert.equal(db.getPipelineLogs(p2.id, 1000).length, 60);
    });

    test('getPipelineLogs respects a caller-supplied limit smaller than the cap', () => {
        const db = makeDb();
        const p = db.createPipeline();
        for (let i = 0; i < 10; i++) db.appendPipelineLog(p.id, 'test', `msg ${i}`);
        const logs = db.getPipelineLogs(p.id, 3);
        assert.equal(logs.length, 3);
        assert.deepEqual(
            logs.map((l) => l.message),
            ['msg 9', 'msg 8', 'msg 7'],
        );
    });

    test('getPipelineLogs defaults to the 100-entry retention limit', () => {
        const db = makeDb();
        const p = db.createPipeline();
        for (let i = 0; i < 120; i++) db.appendPipelineLog(p.id, 'test', `msg ${i}`);
        assert.equal(db.getPipelineLogs(p.id).length, 100);
    });

    test('getPipelineLogs for a pipeline with no logs returns an empty array', () => {
        const db = makeDb();
        const p = db.createPipeline();
        assert.deepEqual(db.getPipelineLogs(p.id), []);
    });
});

// ── Sessions ──────────────────────────────────────────

describe('Sessions', () => {
    test('createSession then listSessions round-trips the token', () => {
        const db = makeDb();
        db.createSession('tok-a');
        db.createSession('tok-b');
        assert.deepEqual(db.listSessions().sort(), ['tok-a', 'tok-b']);
    });

    test('creating a session with the same token twice does not duplicate it', () => {
        const db = makeDb();
        db.createSession('tok-a');
        db.createSession('tok-a');
        assert.deepEqual(db.listSessions(), ['tok-a']);
    });

    test('deleteSession removes only the matching token', () => {
        const db = makeDb();
        db.createSession('tok-a');
        db.createSession('tok-b');
        db.deleteSession('tok-a');
        assert.deepEqual(db.listSessions(), ['tok-b']);
    });

    test('deleteSession on an unknown token is a no-op', () => {
        const db = makeDb();
        db.createSession('tok-a');
        db.deleteSession('does-not-exist');
        assert.deepEqual(db.listSessions(), ['tok-a']);
    });

    test('pruneExpiredSessions removes only sessions older than maxAgeMs', async () => {
        const db = makeDb();
        db.createSession('old');
        await new Promise((r) => setTimeout(r, 20));
        db.createSession('new');
        db.pruneExpiredSessions(10);
        assert.deepEqual(db.listSessions(), ['new']);
    });

    test('pruneExpiredSessions with a huge maxAgeMs keeps everything', () => {
        const db = makeDb();
        db.createSession('tok-a');
        db.pruneExpiredSessions(1000 * 60 * 60 * 24 * 365);
        assert.deepEqual(db.listSessions(), ['tok-a']);
    });

    test('pruneExpiredSessions with maxAgeMs <= 0 prunes anything created before the call', async () => {
        const db = makeDb();
        db.createSession('tok-a');
        db.createSession('tok-b');
        // created_at is millisecond-resolution and the cutoff comparison is
        // strict '<', so a 0ms maxAge only prunes sessions whose creation
        // timestamp is strictly in the past relative to the prune call.
        await new Promise((r) => setTimeout(r, 5));
        db.pruneExpiredSessions(0);
        assert.deepEqual(db.listSessions(), []);
    });
});

// ── Host probe targets ────────────────────────────────

describe('Host probe targets', () => {
    test('listHostProbeTargets is empty by default', () => {
        assert.deepEqual(makeDb().listHostProbeTargets(), []);
    });

    test('replaceHostProbeTargets inserts new targets', () => {
        const db = makeDb();
        db.replaceHostProbeTargets([
            { slot: 1, label: 'YouTube', host: 'a.rtmp.youtube.com', port: 1935 },
            { slot: 2, label: 'Facebook', host: 'live-api-s.facebook.com', port: 443 },
        ]);
        assert.equal(db.listHostProbeTargets().length, 2);
    });

    test('replaceHostProbeTargets updates an existing slot in place', () => {
        const db = makeDb();
        db.replaceHostProbeTargets([{ slot: 1, label: 'Old', host: 'old.example.com', port: 1 }]);
        db.replaceHostProbeTargets([{ slot: 1, label: 'New', host: 'new.example.com', port: 2 }]);
        const targets = db.listHostProbeTargets();
        assert.equal(targets.length, 1);
        assert.equal(targets[0].label, 'New');
        assert.equal(targets[0].host, 'new.example.com');
    });

    test('replaceHostProbeTargets drops slots missing from the new list', () => {
        const db = makeDb();
        db.replaceHostProbeTargets([
            { slot: 1, label: 'A', host: 'a.example.com', port: 1 },
            { slot: 2, label: 'B', host: 'b.example.com', port: 2 },
        ]);
        db.replaceHostProbeTargets([{ slot: 1, label: 'A', host: 'a.example.com', port: 1 }]);
        const targets = db.listHostProbeTargets();
        assert.equal(targets.length, 1);
        assert.equal(targets[0].slot, 1);
    });

    test('replaceHostProbeTargets with an empty array clears all targets', () => {
        const db = makeDb();
        db.replaceHostProbeTargets([{ slot: 1, label: 'A', host: 'a.example.com', port: 1 }]);
        db.replaceHostProbeTargets([]);
        assert.deepEqual(db.listHostProbeTargets(), []);
    });

    test('replaceHostProbeTargets bumps the config revision', () => {
        const db = makeDb();
        const rev = db.getConfigRev();
        db.replaceHostProbeTargets([{ slot: 1, label: 'A', host: 'a.example.com', port: 1 }]);
        assert.ok(db.getConfigRev() > rev);
    });
});

// ── Pipeline groups ────────────────────────────────────

describe('Pipeline groups', () => {
    test('listPipelineGroups is empty by default', () => {
        assert.deepEqual(makeDb().listPipelineGroups(), []);
    });

    test('replacePipelineGroups creates new groups in array order', () => {
        const db = makeDb();
        const saved = db.replacePipelineGroups([{ name: 'Main' }, { name: 'Backup' }]);
        assert.deepEqual(
            saved.map((g) => g.name),
            ['Main', 'Backup'],
        );
        assert.deepEqual(
            saved.map((g) => g.position),
            [0, 1],
        );
        assert.ok(saved[0].id > 0);
        assert.notEqual(saved[0].id, saved[1].id);
    });

    test('replacePipelineGroups keeps the same id for a group that survives the save', () => {
        const db = makeDb();
        const [first] = db.replacePipelineGroups([{ name: 'Main' }]);
        const [renamed] = db.replacePipelineGroups([{ id: first.id, name: 'Renamed' }]);
        assert.equal(renamed.id, first.id);
        assert.equal(renamed.name, 'Renamed');
    });

    test('replacePipelineGroups reorders by array position', () => {
        const db = makeDb();
        const [a, b] = db.replacePipelineGroups([{ name: 'A' }, { name: 'B' }]);
        const reordered = db.replacePipelineGroups([
            { id: b.id, name: 'B' },
            { id: a.id, name: 'A' },
        ]);
        assert.deepEqual(
            reordered.map((g) => g.id),
            [b.id, a.id],
        );
        assert.deepEqual(
            reordered.map((g) => g.position),
            [0, 1],
        );
    });

    test('replacePipelineGroups deletes a group left out of the array', () => {
        const db = makeDb();
        const [a, b] = db.replacePipelineGroups([{ name: 'A' }, { name: 'B' }]);
        const remaining = db.replacePipelineGroups([{ id: a.id, name: 'A' }]);
        assert.deepEqual(
            remaining.map((g) => g.id),
            [a.id],
        );
        assert.equal(
            db.listPipelineGroups().some((g) => g.id === b.id),
            false,
        );
    });

    test('deleting a group unassigns its member pipelines (ON DELETE SET NULL)', () => {
        const db = makeDb();
        const [group] = db.replacePipelineGroups([{ name: 'Main' }]);
        const p = db.createPipeline();
        db.updatePipeline(p.id, p.name, undefined, group.id);
        assert.equal(db.getPipeline(p.id).groupId, group.id);

        db.replacePipelineGroups([]);
        assert.equal(db.getPipeline(p.id).groupId, null);
    });

    test('replacePipelineGroups bumps the config revision', () => {
        const db = makeDb();
        const rev = db.getConfigRev();
        db.replacePipelineGroups([{ name: 'Main' }]);
        assert.ok(db.getConfigRev() > rev);
    });
});

// ── Settings ──────────────────────────────────────────

describe('Settings', () => {
    test('getSetting returns null for unknown key', () => {
        assert.equal(makeDb().getSetting('nonexistent'), null);
    });

    test('setSetting and getSetting round-trip', () => {
        const db = makeDb();
        db.setSetting('serverName', 'My Server');
        assert.equal(db.getSetting('serverName'), 'My Server');
    });

    test('setSetting overwrites existing value', () => {
        const db = makeDb();
        db.setSetting('key', 'first');
        db.setSetting('key', 'second');
        assert.equal(db.getSetting('key'), 'second');
    });
});

// ── Config revision ───────────────────────────────────

describe('Config revision', () => {
    test('starts positive and is monotonic across config writes', () => {
        const db = makeDb();
        const rev0 = db.getConfigRev();
        assert.ok(rev0 > 0);

        const p = db.createPipeline();
        const rev1 = db.getConfigRev();
        assert.ok(rev1 > rev0);

        const o = db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
        const rev2 = db.getConfigRev();
        assert.ok(rev2 > rev1);

        db.setOutputDesiredState(o.id, 'running');
        assert.ok(db.getConfigRev() > rev2);
    });

    test('does not bump on lastError or pipeline-log writes', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
        const rev = db.getConfigRev();

        db.setOutputLastError(o.id, 'boom', 'crash');
        db.clearOutputLastError(o.id);
        db.appendPipelineLog(p.id, 'online', 'connected');

        assert.equal(db.getConfigRev(), rev);
    });
});

describe('Output capacity and renditions', () => {
    const RENDITION = (n) => `rtmp://127.0.0.1:1935/internal/r1_720p_a${n}`;

    test('rendition rows do not count toward the 500-output cap', () => {
        const db = makeDb();
        const p = db.createPipeline();
        db.createOutputs(
            Array.from({ length: 500 }, (_, i) => ({
                pipelineId: p.id,
                name: `o${i}`,
                url: `rtmp://h/live/k${i}`,
            })),
        );

        db.createOutput({ pipelineId: p.id, name: 'r', url: RENDITION(0) });

        assert.equal(db.listOutputs().length, 501);
        assert.throws(
            () => db.createOutput({ pipelineId: p.id, name: 'x', url: 'rtmp://h/x' }),
            /Output limit reached/,
        );
    });

    test('existing rendition rows free their share of the cap', () => {
        const db = makeDb();
        const p = db.createPipeline();
        for (let i = 0; i < 5; i++) {
            db.createOutput({ pipelineId: p.id, name: 'r', url: RENDITION(i) });
        }
        db.createOutputs(
            Array.from({ length: 500 }, (_, i) => ({
                pipelineId: p.id,
                name: `o${i}`,
                url: `rtmp://h/live/k${i}`,
            })),
        );
        assert.equal(db.listOutputs().length, 505);
    });
});
