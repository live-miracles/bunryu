import type Database from 'better-sqlite3';

// Bump when a table or column changes. There are no migrations: a database
// stamped with another version is refused at startup (see DatabaseSchemaError)
// and has to be recreated. Databases from before the stamp existed carry user
// version 0 and have the version-1 schema, so they are accepted and stamped.
export const SCHEMA_VERSION = 1;

export class DatabaseSchemaError extends Error {}

export function setupDatabaseSchema(db: Database.Database): void {
    const found = db.pragma('user_version', { simple: true }) as number;
    if (found !== 0 && found !== SCHEMA_VERSION) {
        throw new DatabaseSchemaError(
            `Database schema version ${found} does not match this build (version ${SCHEMA_VERSION}). ` +
                'There are no migrations: stop the service, move db.sqlite aside (the installer keeps a backup when it wipes) and start again to create a fresh database.',
        );
    }
    db.pragma('foreign_keys = ON');

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
            translation_config TEXT,
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
}
