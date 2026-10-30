import type Database from 'better-sqlite3';

// Bump when a table, a column or a persisted format changes. There are no
// migrations: a database stamped with another version, or one that has tables but
// no stamp, is refused at startup (see DatabaseSchemaError) and has to be
// recreated. Only an empty database is stamped.
export const SCHEMA_VERSION = 4;

export class DatabaseSchemaError extends Error {}

export function setupDatabaseSchema(db: Database.Database): void {
    const found = db.pragma('user_version', { simple: true }) as number;
    const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get();
    if (found !== SCHEMA_VERSION && (found !== 0 || hasTables)) {
        throw new DatabaseSchemaError(
            `Database ${found === 0 ? 'has tables but no schema version stamp, which does not' : `schema version ${found} does not`} match this build (version ${SCHEMA_VERSION}). ` +
                'There are no migrations: stop the service, move db.sqlite aside (the installer keeps a backup when it wipes) and start again to create a fresh database.',
        );
    }
    db.pragma('foreign_keys = ON');

    // One transaction with the stamp, so a start interrupted halfway cannot leave tables
    // without it, which the check above would refuse on the next start.
    db.transaction(() => {
        db.prepare(
            `CREATE TABLE IF NOT EXISTS stream_keys (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            slot INTEGER UNIQUE,
            key  TEXT UNIQUE NOT NULL
        )`,
        ).run();

        db.prepare(
            `CREATE TABLE IF NOT EXISTS pipeline_groups (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            name     TEXT NOT NULL,
            position INTEGER NOT NULL
        )`,
        ).run();

        db.prepare(
            `CREATE TABLE IF NOT EXISTS pipelines (
            id            INTEGER PRIMARY KEY,
            name          TEXT NOT NULL,
            stream_key_id INTEGER REFERENCES stream_keys(id),
            group_id      INTEGER REFERENCES pipeline_groups(id) ON DELETE SET NULL
        )`,
        ).run();

        // One output = one ffmpeg process that pulls the input once and pushes to a
        // single destination (url + audioEncoding). The pull protocol isn't stored
        // — it's derived at runtime from how the input is currently published (SRT
        // input -> SRT pull, RTMP input -> RTMP pull).
        // last_error stores up to ten recent ffmpeg failures, stops and warnings as
        // JSON: [{ts:<ms>,message:<text>,kind}].
        db.prepare(
            `CREATE TABLE IF NOT EXISTS outputs (
            id              TEXT PRIMARY KEY,
            pipeline_id     INTEGER NOT NULL,
            seq             INTEGER NOT NULL,
            name            TEXT NOT NULL,
            desired_state   TEXT NOT NULL DEFAULT 'stopped',
            encoding        TEXT NOT NULL DEFAULT 'copy',
            url             TEXT NOT NULL DEFAULT '',
            audio_encoding  TEXT NOT NULL DEFAULT 'copy',
            last_error      TEXT,
            FOREIGN KEY(pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
        )`,
        ).run();

        db.prepare(`CREATE INDEX IF NOT EXISTS idx_outputs_pipeline ON outputs(pipeline_id)`).run();

        db.prepare(
            `CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`,
        ).run();

        db.prepare(
            `CREATE TABLE IF NOT EXISTS pipeline_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            pipeline_id INTEGER NOT NULL,
            ts          INTEGER NOT NULL,
            event       TEXT NOT NULL,
            message     TEXT NOT NULL,
            FOREIGN KEY(pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
        )`,
        ).run();

        db.prepare(
            `CREATE INDEX IF NOT EXISTS idx_pipeline_logs_pipeline ON pipeline_logs(pipeline_id, id DESC)`,
        ).run();

        db.prepare(
            `CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL
        )`,
        ).run();

        db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
}
