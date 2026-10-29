#!/usr/bin/env node
// One-off migration of a production database from schema version 2 to 3, which
// removed the translation output (see "Translation outputs were removed" in
// docs/4-reference/3-design-decisions.md). Delete this script once every
// deployment is on version 3; the app itself has no migrations.
//
//   node scripts/migrate-db-2-to-3.mjs <db-file>
//
// Stop the dashboard service first, run it from the app directory (it resolves
// better-sqlite3 from node_modules), then run the installer: the installer finds
// a database already on this build's version and keeps it instead of wiping it.
//
// It copies the database to <db-file>.pre-v3 first, deletes the outputs whose
// audio is 'translation' (nothing can run them any more), drops the
// outputs.translation_config column and stamps version 3. Running it again on a
// version 3 database changes nothing.
import { copyFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const FROM_VERSION = 2;
const TO_VERSION = 3;

const file = process.argv[2];
if (!file) {
    console.error('Usage: node scripts/migrate-db-2-to-3.mjs <db-file>');
    process.exit(2);
}
if (!existsSync(file)) {
    console.error(`ERROR: ${file} does not exist.`);
    process.exit(1);
}

const db = new Database(file);
const version = db.pragma('user_version', { simple: true });
if (version === TO_VERSION) {
    console.log(`${file} is already on schema version ${TO_VERSION}; nothing to do.`);
    process.exit(0);
}
if (version !== FROM_VERSION) {
    console.error(
        `ERROR: ${file} is on schema version ${version}; this script only migrates version ${FROM_VERSION}.`,
    );
    process.exit(1);
}

const backup = `${file}.pre-v${TO_VERSION}`;
if (existsSync(backup)) {
    console.error(`ERROR: ${backup} already exists; move it aside so it is not overwritten.`);
    process.exit(1);
}
db.close();
copyFileSync(file, backup);
console.log(`Backup: ${backup}`);

const migrate = new Database(file);
const translation = migrate
    .prepare("SELECT id, name FROM outputs WHERE audio_encoding = 'translation' ORDER BY id")
    .all();
migrate.transaction(() => {
    migrate.prepare("DELETE FROM outputs WHERE audio_encoding = 'translation'").run();
    migrate.prepare('ALTER TABLE outputs DROP COLUMN translation_config').run();
})();
migrate.pragma(`user_version = ${TO_VERSION}`);
migrate.close();

for (const output of translation)
    console.log(`Deleted translation output ${output.id} (${output.name})`);
console.log(
    `Migrated ${file} to schema version ${TO_VERSION}: ${translation.length} translation output(s) deleted.`,
);
