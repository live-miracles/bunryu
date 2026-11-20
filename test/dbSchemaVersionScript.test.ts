import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { createDb } from '../src/db/index';
import { SCHEMA_VERSION } from '../src/db/schema';

// scripts/db-schema-version.sh lets the installer compare a database with the
// build before it restarts anything (see "Database schema version" in
// docs/3-operations/3-configuration.md).
const SCRIPT = path.join(__dirname, '..', 'scripts', 'db-schema-version.sh');
const run = (...args: string[]) =>
    execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' }).trim();

describe('db-schema-version.sh', () => {
    function withDir(fn: (dir: string) => void) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-schema-script-'));
        try {
            fn(dir);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    test('--build prints SCHEMA_VERSION from src/db/schema.ts', () => {
        assert.equal(run('--build'), String(SCHEMA_VERSION));
    });

    test('reads the version the app stamped on a new database', () => {
        withDir((dir) => {
            const file = path.join(dir, 'db.sqlite');
            createDb(file);
            assert.equal(run(file), String(SCHEMA_VERSION));
        });
    });

    test('reads other versions, including an unstamped 0 and one needing four bytes', () => {
        withDir((dir) => {
            for (const version of [0, 7, 300, 70000]) {
                const file = path.join(dir, `v${version}.sqlite`);
                const raw = new Database(file);
                raw.exec('CREATE TABLE t (x)');
                raw.pragma(`user_version = ${version}`);
                raw.close();
                assert.equal(run(file), String(version));
            }
        });
    });

    test('prints nothing for a file that is not a SQLite database', () => {
        withDir((dir) => {
            const file = path.join(dir, 'junk');
            fs.writeFileSync(file, Buffer.alloc(200, 1));
            assert.equal(run(file), '');
        });
    });
});
