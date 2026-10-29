'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createDb } = require('../src/db/index');
const { SCHEMA_VERSION } = require('../src/db/schema');

// The one-off script that moves a production database from schema version 2
// (outputs.translation_config) to 3. Delete this test with the script.
const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrate-db-2-to-3.mjs');
const run = (file) => spawnSync('node', [SCRIPT, file], { encoding: 'utf8' });

function withDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-migrate-'));
    try {
        fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// A version 2 database: today's schema plus the column the migration drops.
function makeVersion2Db(file) {
    const db = createDb(file);
    const p = db.createPipeline();
    db.createOutput({ pipelineId: p.id, name: 'YouTube', url: 'rtmp://a/live/k' });
    db.createOutput({
        pipelineId: p.id,
        name: 'SRT',
        url: 'srt://h:1?mode=caller',
        audioEncoding: '0,1',
    });
    db.createOutput({
        pipelineId: p.id,
        name: 'French',
        url: 'rtmp://b/live/k',
        audioEncoding: 'translation',
    });
    const raw = new Database(file);
    raw.prepare('ALTER TABLE outputs ADD COLUMN translation_config TEXT').run();
    raw.prepare("UPDATE outputs SET translation_config = '{}' WHERE name = 'French'").run();
    raw.pragma('user_version = 2');
    raw.close();
}

describe('migrate-db-2-to-3.mjs', () => {
    test('current schema version is the one the script migrates to', () => {
        assert.equal(SCHEMA_VERSION, 3);
    });

    test('deletes translation outputs, drops the column, stamps version 3 and keeps a backup', () => {
        withDir((dir) => {
            const file = path.join(dir, 'db.sqlite');
            makeVersion2Db(file);

            const result = run(file);
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /Deleted translation output \d+-\d+ \(French\)/);

            const raw = new Database(file, { readonly: true });
            assert.equal(raw.pragma('user_version', { simple: true }), 3);
            const columns = raw
                .prepare('PRAGMA table_info(outputs)')
                .all()
                .map((c) => c.name);
            assert.ok(!columns.includes('translation_config'));
            const names = raw
                .prepare('SELECT name FROM outputs ORDER BY seq')
                .all()
                .map((r) => r.name);
            assert.deepEqual(names, ['YouTube', 'SRT']);
            raw.close();

            const backup = new Database(`${file}.pre-v3`, { readonly: true });
            assert.equal(backup.pragma('user_version', { simple: true }), 2);
            assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM outputs').get().n, 3);
            backup.close();

            // The app opens the migrated database without a schema error.
            assert.equal(createDb(file).listOutputs().length, 2);
        });
    });

    test('is a no-op on a database that is already on version 3', () => {
        withDir((dir) => {
            const file = path.join(dir, 'db.sqlite');
            createDb(file);

            const result = run(file);
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /already on schema version 3/);
            assert.equal(fs.existsSync(`${file}.pre-v3`), false);
        });
    });

    test('refuses any other version without touching the file', () => {
        withDir((dir) => {
            const file = path.join(dir, 'db.sqlite');
            const raw = new Database(file);
            raw.pragma('user_version = 1');
            raw.close();
            const before = fs.readFileSync(file);

            const result = run(file);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /schema version 1/);
            assert.deepEqual(fs.readFileSync(file), before);
            assert.equal(fs.existsSync(`${file}.pre-v3`), false);
        });
    });

    test('refuses to overwrite an existing backup and leaves the database on version 2', () => {
        withDir((dir) => {
            const file = path.join(dir, 'db.sqlite');
            makeVersion2Db(file);
            fs.writeFileSync(`${file}.pre-v3`, 'earlier backup');

            const result = run(file);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /already exists/);
            assert.equal(fs.readFileSync(`${file}.pre-v3`, 'utf8'), 'earlier backup');
            const raw = new Database(file, { readonly: true });
            assert.equal(raw.pragma('user_version', { simple: true }), 2);
            raw.close();
        });
    });

    test('needs a database path', () => {
        const result = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /Usage/);
    });
});
