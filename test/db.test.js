'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');

const { createDb } = require('../src/db/index');

// Each helper creates a fresh isolated in-memory DB
const makeDb = () => createDb(':memory:');

function withDbFile(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-db-keys-'));
    try {
        fn(path.join(dir, 'test.db'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── Stream keys ───────────────────────────────────────

describe('Stream keys', () => {
    test('seeds 100 slots on init by default', () => {
        assert.equal(makeDb().listStreamKeys().length, 100);
    });

    test('all keys match expected format', () => {
        for (const k of makeDb().listStreamKeys()) {
            assert.match(k.key, /^key\d{2,}_[a-f0-9]{32}$/);
        }
    });

    test('keys are ordered by slot 1–100', () => {
        const keys = makeDb().listStreamKeys();
        assert.equal(keys[0].slot, 1);
        assert.equal(keys[99].slot, 100);
        assert.match(keys[99].key, /^key100_/);
    });

    test('the count is a parameter', () => {
        assert.equal(createDb(':memory:', 7).listStreamKeys().length, 7);
        assert.equal(createDb(':memory:', 250).listStreamKeys().length, 250);
    });

    test('a larger count on restart adds keys and keeps the existing ones', () => {
        withDbFile((file) => {
            const first = createDb(file, 3);
            const before = first.listStreamKeys();
            const after = createDb(file, 5).listStreamKeys();
            assert.equal(after.length, 5);
            assert.deepEqual(after.slice(0, 3), before);
        });
    });

    test('a smaller count on restart removes unassigned keys above it and keeps assigned ones', () => {
        withDbFile((file) => {
            const first = createDb(file, 5);
            for (let i = 0; i < 4; i++) first.createPipeline();
            const second = createDb(file, 2);
            assert.deepEqual(
                second.listStreamKeys().map((k) => k.slot),
                [1, 2, 3, 4],
            );
            // New pipelines only get keys within the count: 1 and 2 are taken.
            assert.throws(() => second.createPipeline(), /No unassigned stream keys/);
        });
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
        // Fill all 100 slots — should succeed since one key was freed
        for (let i = 0; i < 100; i++) db.createPipeline();
    });

    test('createPipeline throws when all 100 keys are assigned', () => {
        const db = makeDb();
        for (let i = 0; i < 100; i++) db.createPipeline();
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

describe('stored translation settings', () => {
    test('a config saved with the old percent volumes loads with dB defaults, never undefined', () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const Database = require('better-sqlite3');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-db-'));
        try {
            const file = path.join(dir, 'test.db');
            const db = createDb(file);
            const source = db.createPipeline();
            const translator = db.createPipeline();
            const output = db.createOutput({
                pipelineId: source.id,
                name: 'T',
                url: 'rtmp://t',
                audioEncoding: 'translation',
                translation: { translatorStreamKey: translator.streamKey },
            });
            const raw = new Database(file);
            raw.prepare('UPDATE outputs SET translation_config = ? WHERE id = ?').run(
                JSON.stringify({
                    translatorStreamKey: translator.streamKey,
                    translationDelayMs: 700,
                    duckVolumePercent: 20,
                    restoreVolumePercent: 80,
                }),
                output.id,
            );
            raw.close();

            const loaded = db.getOutput(output.id).translation;
            assert.equal(loaded.translationDelayMs, 700);
            assert.equal(loaded.duckVolumeDb, -24);
            assert.equal(loaded.restoreVolumeDb, -6);
            assert.equal(loaded.duckVolumePercent, undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
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
        assert.equal(after.length, 100);
        for (let i = 0; i < 100; i++) {
            assert.equal(after[i].slot, before[i].slot);
            assert.equal(after[i].id, before[i].id);
            assert.notEqual(after[i].key, before[i].key);
            assert.match(after[i].key, /^key\d{2,}_[a-f0-9]{32}$/);
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

        const names = 'abcdefghijkl'.split('');
        for (const n of names) db.setOutputLastError(o.id, `error ${n}`, 'crash');

        const history = db.getOutputErrorHistory(o.id);
        assert.deepEqual(
            history.map((e) => e.message),
            names.slice(2).map((n) => `error ${n}`),
        );

        const got = db.getOutput(o.id);
        assert.match(got?.lastError ?? '', /error l$/);
    });

    test('the same crash again is one record with a count and the latest time', (t) => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
        let now = 1_000_000;
        t.mock.method(Date, 'now', () => now);
        const crash = (pid, uptime) =>
            `watchdog: ffmpeg received no input data; restarting process\npid=${pid}\nuptime=${uptime}s\nRestarting output: No input data (port 1935)`;

        db.setOutputLastError(o.id, crash(100, 45), 'crash');
        now += 50_000;
        db.setOutputLastError(o.id, crash(101, 47), 'crash');
        now += 50_000;
        db.setOutputLastError(o.id, crash(102, 46), 'crash');
        db.setOutputLastError(o.id, 'a timestamp warning', 'warning');
        now += 50_000;
        db.setOutputLastError(o.id, crash(103, 45), 'crash');

        const history = db.getOutputErrorHistory(o.id);
        assert.equal(history.filter((e) => e.kind === 'crash').length, 1);
        const [first] = history;
        assert.equal(first.message, crash(100, 45), 'the first crash keeps its detail');
        assert.deepEqual([first.ts, first.lastTs, first.count], [1_000_000, 1_150_000, 4]);
        // The card's "since" is the latest crash.
        assert.match(db.getOutput(o.id)?.lastError ?? '', /^1150000\n/);
    });

    test('a different crash, or one after a stop or a start, is a new record', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

        db.setOutputLastError(o.id, 'Connection refused', 'crash');
        db.setOutputLastError(o.id, 'Connection timed out', 'crash');
        db.setOutputLastError(o.id, 'Connection timed out', 'crash');
        db.setOutputLastError(o.id, '', 'stopped');
        db.setOutputLastError(o.id, 'Connection timed out', 'crash');
        db.setOutputLastError(o.id, 'Started manually', 'started');
        db.setOutputLastError(o.id, 'Connection timed out', 'crash');

        assert.deepEqual(
            db.getOutputErrorHistory(o.id).map((e) => [e.kind, e.message, e.count]),
            [
                ['crash', 'Connection refused', undefined],
                ['crash', 'Connection timed out', 2],
                ['stopped', '', undefined],
                ['crash', 'Connection timed out', undefined],
                ['started', 'Started manually', undefined],
                ['crash', 'Connection timed out', undefined],
            ],
        );
    });

    test('a recovered crash stays in the history but is no longer the current error', (t) => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
        let now = 5_000;
        t.mock.method(Date, 'now', () => now);

        assert.equal(db.markOutputRecovered(o.id), null, 'nothing to recover from');
        db.setOutputLastError(o.id, 'Connection refused', 'crash');
        db.setOutputLastError(o.id, 'Connection refused', 'crash');
        db.setOutputLastError(o.id, 'a warning', 'warning');
        now = 9_000;
        assert.equal(db.markOutputRecovered(o.id), 2);
        assert.equal(db.markOutputRecovered(o.id), null, 'only once');

        const got = db.getOutput(o.id);
        assert.equal(got?.lastError, null);
        assert.equal(got?.hasErrorHistory, true);
        const crash = db.getOutputErrorHistory(o.id)[0];
        assert.deepEqual([crash.count, crash.recoveredTs], [2, 9_000]);

        // The same failure later is a new episode, not a count on the old one.
        db.setOutputLastError(o.id, 'Connection refused', 'crash');
        assert.equal(db.getOutputErrorHistory(o.id).filter((e) => e.kind === 'crash').length, 2);
        assert.match(db.getOutput(o.id)?.lastError ?? '', /Connection refused$/);

        // Only a crash can be recovered from.
        db.setOutputLastError(o.id, 'Started manually', 'started');
        assert.equal(db.markOutputRecovered(o.id), null);
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

    test('a manual start supersedes an earlier crash as the current error', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

        db.setOutputLastError(o.id, 'ffmpeg crashed', 'crash');
        db.setOutputLastError(o.id, 'Started manually', 'started');

        assert.deepEqual(
            db.getOutputErrorHistory(o.id).map((e) => [e.kind, e.message]),
            [
                ['crash', 'ffmpeg crashed'],
                ['started', 'Started manually'],
            ],
        );
        assert.equal(db.getOutput(o.id)?.lastError, null);

        // A crash after the start is current again.
        db.setOutputLastError(o.id, 'ffmpeg crashed again', 'crash');
        assert.match(db.getOutput(o.id)?.lastError ?? '', /ffmpeg crashed again$/);
    });

    test('a stop after repeated failed attempts stays the current error until the output starts again', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const o = db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

        db.setOutputLastError(o.id, 'Connection refused', 'crash');
        db.setOutputDesiredState(o.id, 'stopped');
        db.setOutputLastError(o.id, 'Stopped after 5 failed attempts', 'stopped', 5);

        const stopped = db.getOutput(o.id);
        assert.match(stopped?.lastError ?? '', /Stopped after 5 failed attempts$/);
        assert.match(
            db.listOutputIds().find((out) => out.id === o.id)?.lastError ?? '',
            /Stopped after 5 failed attempts$/,
        );
        assert.equal(db.getOutputErrorHistory(o.id).at(-1)?.failedAttempts, 5);

        // Starting it again hides the stop without writing anything.
        db.setOutputDesiredState(o.id, 'running');
        assert.equal(db.getOutput(o.id)?.lastError, null);
        assert.equal(db.getOutput(o.id)?.hasErrorHistory, true);

        // A later plain stop supersedes it.
        db.setOutputDesiredState(o.id, 'stopped');
        db.setOutputLastError(o.id, '', 'stopped');
        assert.equal(db.getOutput(o.id)?.lastError, null);
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

    test('a line can be updated in place by the id its append returned', () => {
        const db = makeDb();
        const p = db.createPipeline();
        const other = db.createPipeline();
        const id = db.appendPipelineLog(p.id, 'relay_error', 'boom');
        db.appendPipelineLog(p.id, 'online', 'later line');
        assert.equal(db.updatePipelineLog(p.id, id, 'boom (seen 3 times over 1 min)'), true);
        assert.deepEqual(
            db.getPipelineLogs(p.id).map((l) => l.message),
            ['later line', 'boom (seen 3 times over 1 min)'],
        );
        // Another pipeline's row, or one the cap has pruned, is not touched and says so.
        assert.equal(db.updatePipelineLog(other.id, id, 'x'), false);
        for (let i = 0; i < 100; i++) db.appendPipelineLog(p.id, 'test', `msg ${i}`);
        assert.equal(db.updatePipelineLog(p.id, id, 'x'), false);
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
        db.appendPipelineLog(p.id, 'online', 'connected');

        assert.equal(db.getConfigRev(), rev);
    });
});

describe('schema version stamp', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const Database = require('better-sqlite3');
    const { SCHEMA_VERSION, DatabaseSchemaError } = require('../src/db/schema');

    function withDbFile(fn) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-db-version-'));
        try {
            fn(path.join(dir, 'test.db'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    function userVersion(file) {
        const raw = new Database(file);
        try {
            return raw.pragma('user_version', { simple: true });
        } finally {
            raw.close();
        }
    }

    test('a new database is stamped with the current version', () => {
        withDbFile((file) => {
            createDb(file);
            assert.equal(userVersion(file), SCHEMA_VERSION);
        });
    });

    test('a database from before the stamp existed (same schema) is accepted and stamped', () => {
        withDbFile((file) => {
            const db = createDb(file);
            const pipeline = db.createPipeline();
            const raw = new Database(file);
            raw.pragma('user_version = 0');
            raw.close();

            const reopened = createDb(file);
            assert.equal(reopened.listPipelines().length, 1);
            assert.equal(reopened.listPipelines()[0].id, pipeline.id);
            assert.equal(userVersion(file), SCHEMA_VERSION);
        });
    });

    test('a database of another schema version is refused and left untouched', () => {
        withDbFile((file) => {
            createDb(file);
            const raw = new Database(file);
            raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
            raw.close();

            assert.throws(
                () => createDb(file),
                (err) =>
                    err instanceof DatabaseSchemaError &&
                    new RegExp(`version ${SCHEMA_VERSION + 1}`).test(err.message) &&
                    /no migrations/i.test(err.message),
            );
            assert.equal(userVersion(file), SCHEMA_VERSION + 1);
        });
    });
});

// ── Corrupt History ─────────────────────────────

describe('Corrupt History', () => {
    for (const [label, value] of [
        ['not JSON', 'ffmpeg exited'],
        ['not an array', '{"ts":1,"message":"x"}'],
        ['null', 'null'],
    ]) {
        test(`one output with a last_error that is ${label} does not break listing`, () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-db-'));
            const file = path.join(dir, 'test.db');
            try {
                const db = createDb(file);
                const pipeline = db.createPipeline();
                const bad = db.createOutput({
                    pipelineId: pipeline.id,
                    name: 'Bad',
                    url: 'rtmp://a',
                });
                const good = db.createOutput({
                    pipelineId: pipeline.id,
                    name: 'Good',
                    url: 'rtmp://b',
                });
                const raw = new BetterSqlite3(file);
                raw.prepare('UPDATE outputs SET last_error = ? WHERE id = ?').run(value, bad.id);
                raw.close();

                const outputs = db.listOutputs();
                assert.equal(outputs.length, 2);
                assert.equal(outputs.find((o) => o.id === bad.id).hasErrorHistory, false);
                assert.ok(db.getOutput(good.id));
                assert.equal(
                    db.listOutputIds().find((o) => o.id === bad.id).hasErrorHistory,
                    false,
                );
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    }
});
