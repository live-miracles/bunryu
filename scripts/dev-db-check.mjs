// Runs before `npm run dev` starts the watchers. A database of another schema version
// is refused by the app (exit 78), which in development only means a stack trace and a
// manual `mv`; this offers to move it aside so the app creates a fresh one. Production
// is untouched: the installer owns that decision there (scripts/server-install.sh).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { readAppConfig } from '../src/utils/appConfig.ts';
import { checkSchemaVersion, DatabaseSchemaError } from '../src/db/schema.ts';

const dbPath = readAppConfig().databasePath;
if (!fs.existsSync(dbPath)) process.exit(0);

let mismatch = null;
const db = new Database(dbPath, { readonly: true });
try {
    checkSchemaVersion(db);
} catch (err) {
    if (!(err instanceof DatabaseSchemaError)) throw err;
    mismatch = err.message;
} finally {
    db.close();
}
if (!mismatch) process.exit(0);

console.error(`[dev] ${dbPath}: ${mismatch}`);
if (!process.stdin.isTTY) process.exit(1);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('[dev] Wipe it and start with a fresh database? [y/N] ');
rl.close();
if (!/^y(es)?$/i.test(answer.trim())) {
    console.error('[dev] Left the database as it is; not starting.');
    process.exit(1);
}

fs.rmSync(dbPath);
console.log(`[dev] Deleted ${dbPath}; a fresh database is created on start.`);
