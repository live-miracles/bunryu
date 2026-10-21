import BetterSqlite3 from 'better-sqlite3';
import crypto from 'crypto';
import { setupDatabaseSchema } from './schema.js';
import { readAppConfig } from '../utils/appConfig.js';
import { isRenditionUrl } from '../utils/renditions.js';
import type {
    Pipeline,
    PipelineGroup,
    Output,
    PipelineLog,
    StreamKey,
    HostProbeTarget,
    OutputErrorRecord,
    OutputErrorKind,
    Db,
    TranslationConfig,
    TranslationInput,
} from '../types.js';

const PIPELINE_SELECT = `
    SELECT p.id, p.name, p.stream_key_id, p.group_id, COALESCE(sk.key, '') as stream_key
    FROM pipelines p
    LEFT JOIN stream_keys sk ON sk.id = p.stream_key_id
`;

const STREAM_KEY_SLOTS = 99;
// Supported ceiling for output forwards (capacity table in
// docs/1-getting-started/1-introduction.md). Enforced on
// every create path; existing rows above it are left alone, only new ones fail.
export const MAX_OUTPUTS = 500;

export class OutputLimitError extends Error {
    constructor() {
        super(`Output limit reached: at most ${MAX_OUTPUTS} outputs are supported`);
        this.name = 'OutputLimitError';
    }
}
const PIPELINE_LOG_CAP = 100;
const LOG_RETENTION_LIMIT = 100;
const OUTPUT_ERROR_HISTORY_LIMIT = 10;
// Warning records may take at most this many of those slots, so a run of
// warnings can never push crashes and stops out of the history.
const OUTPUT_WARNING_HISTORY_LIMIT = 5;

// Output.lastError's wire format predates the history array and stays
// "<ts_ms>\n<message>" so existing frontend parsing keeps working. It only
// surfaces a crash when that crash is also the *most recent* history entry.
// Every deliberate stop appends a 'stopped' marker (see outputs.ts), even
// with an empty message, specifically so it immediately supersedes any
// earlier crash here — "is this error still current" then falls out of
// history order alone, with no separate timestamp/marker to keep in sync. The
// one exception is a stop that followed repeated failures (failedAttempts), which
// stays current while the output remains stopped.
function toLastErrorString(error: OutputErrorRecord | null): string | null {
    return error ? `${error.ts}\n${error.message}` : null;
}

// Warnings are informational and do not affect whether a crash is current.
// A stop that followed repeated failed attempts also counts as current, but only
// while the output stays stopped: starting it again hides it without a new record.
function currentCrashRecord(
    history: OutputErrorRecord[],
    desiredState: string,
): OutputErrorRecord | null {
    const latest = history.filter((e) => e.kind !== 'warning').at(-1);
    if (!latest) return null;
    if (latest.kind === 'crash') return latest;
    return latest.kind === 'stopped' && latest.failedAttempts && desiredState === 'stopped'
        ? latest
        : null;
}

function trimOutputErrorHistory(history: OutputErrorRecord[]): OutputErrorRecord[] {
    // Drop the oldest warnings beyond their share, then the oldest of anything
    // beyond the total.
    let warningsToDrop =
        history.filter((e) => e.kind === 'warning').length - OUTPUT_WARNING_HISTORY_LIMIT;
    return history
        .filter((e) => {
            if (e.kind !== 'warning' || warningsToDrop <= 0) return true;
            warningsToDrop--;
            return false;
        })
        .slice(-OUTPUT_ERROR_HISTORY_LIMIT);
}

function deriveOutputErrorFields(
    history: OutputErrorRecord[],
    desiredState: string,
): {
    lastError: string | null;
    hasErrorHistory: boolean;
} {
    return {
        lastError: toLastErrorString(currentCrashRecord(history, desiredState)),
        hasErrorHistory: history.length > 0,
    };
}

// Raw values already reported, so a corrupt row is logged once, not on every
// 5 s health poll.
const reportedCorruptHistory = new Set<string>();

function parseOutputErrorHistory(raw: string | null): OutputErrorRecord[] {
    if (!raw) return [];
    let parsed: Array<Partial<OutputErrorRecord> & { ts: number; message: string }>;
    try {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) throw new Error('not an array');
        parsed = value;
    } catch (err) {
        // One unreadable row must not make every output listing (watchdog,
        // health, API) throw: treat it as no history; the next error replaces it.
        const key = raw.slice(0, 200);
        if (reportedCorruptHistory.size < 100 && !reportedCorruptHistory.has(key)) {
            reportedCorruptHistory.add(key);
            console.error(
                `[db] unreadable output Error History, treating it as empty: ${String(err)} (${key})`,
            );
        }
        return [];
    }
    // Records written before 'kind' existed have none — they all predate this
    // feature and were all crash/watchdog errors, so default them as such.
    return trimOutputErrorHistory(
        parsed.map((e) => ({
            ts: e.ts,
            message: e.message,
            kind: e.kind ?? 'crash',
            ...(e.failedAttempts ? { failedAttempts: e.failedAttempts } : {}),
        })),
    );
}

function encodeOutputErrorHistory(history: OutputErrorRecord[]): string {
    return JSON.stringify(trimOutputErrorHistory(history));
}

function rowToPipeline(row: Record<string, unknown>): Pipeline {
    return {
        id: row.id as number,
        name: row.name as string,
        streamKey: row.stream_key as string,
        streamKeyId: row.stream_key_id as number,
        groupId: row.group_id as number | null,
    };
}

function rowToPipelineGroup(row: Record<string, unknown>): PipelineGroup {
    return {
        id: row.id as number,
        name: row.name as string,
        position: row.position as number,
    };
}

function normalizeTranslationConfig(input: TranslationInput): TranslationConfig {
    return {
        translatorStreamKey: input.translatorStreamKey,
        sourceTrackIndex: input.sourceTrackIndex ?? 0,
        translatorTrackIndex: input.translatorTrackIndex ?? 0,
        translationDelayMs: input.translationDelayMs ?? 800,
        voiceThresholdDb: input.voiceThresholdDb ?? -20,
        duckVolumeDb: input.duckVolumeDb ?? -24,
        duckDurationMs: input.duckDurationMs ?? 900,
        restoreSilenceMs: input.restoreSilenceMs ?? 2000,
        restoreVolumeDb: input.restoreVolumeDb ?? -6,
        restoreDurationMs: input.restoreDurationMs ?? 5000,
    };
}

function rowToStreamKey(row: Record<string, unknown>): StreamKey {
    return { id: row.id as number, slot: row.slot as number, key: row.key as string };
}

function rowToHostProbeTarget(row: Record<string, unknown>): HostProbeTarget {
    return {
        slot: row.slot as number,
        label: row.label as string,
        host: row.host as string,
        port: row.port as number,
    };
}

export function createDb(dbPath?: string): Db {
    const resolvedPath = dbPath ?? readAppConfig().databasePath;
    const sqlite = new BetterSqlite3(resolvedPath);
    // WAL mode not enabled: better-sqlite3 is synchronous with a single connection, so all
    // reads and writes are already serialized by the JS event loop — no concurrency benefit.
    try {
        setupDatabaseSchema(sqlite);
    } catch (err) {
        sqlite.close();
        throw err;
    }

    // Seed stream key slots 1–99 if missing
    for (let slot = 1; slot <= STREAM_KEY_SLOTS; slot++) {
        const existing = sqlite.prepare('SELECT id FROM stream_keys WHERE slot = ?').get(slot);
        if (!existing) {
            const key = `key${String(slot).padStart(2, '0')}_${crypto.randomBytes(16).toString('hex')}`;
            sqlite.prepare('INSERT INTO stream_keys (slot, key) VALUES (?, ?)').run(slot, key);
        }
    }

    // Read prepared statements — load entire tables, combine in JS.
    // The dataset is small (~30 pipelines / 300+ outputs) so full-table reads
    // are cheaper and simpler than maintaining targeted per-entity queries.
    const stmtLoadPipelines = sqlite.prepare(`${PIPELINE_SELECT} ORDER BY p.id`);
    const stmtLoadOutputs = sqlite.prepare('SELECT * FROM outputs ORDER BY pipeline_id, seq');
    // Lightweight id/pipeline map for the 5s health poll — avoids loading every
    // output row just to group output ids by pipeline.
    const stmtLoadOutputIds = sqlite.prepare(
        'SELECT id, pipeline_id, desired_state, last_error FROM outputs ORDER BY pipeline_id, seq',
    );
    // Targeted single-row lookups for the hot retry / process-exit paths.
    const stmtGetPipeline = sqlite.prepare(`${PIPELINE_SELECT} WHERE p.id = ?`);
    // Slot collisions are intentional (see updatePipeline) — order by p.id so
    // the pick is at least deterministic when more than one pipeline shares a key.
    const stmtGetPipelineByStreamKey = sqlite.prepare(
        `${PIPELINE_SELECT} WHERE sk.key = ? ORDER BY p.id LIMIT 1`,
    );
    const stmtGetOutput = sqlite.prepare('SELECT * FROM outputs WHERE id = ?');
    // Targeted per-pipeline lookups — avoids full-table scans in the hot restart
    // path where restartPipelineOutputs is called once per reconnecting pipeline.
    const stmtGetOutputsByPipeline = sqlite.prepare(
        'SELECT * FROM outputs WHERE pipeline_id = ? ORDER BY seq',
    );
    const stmtListStreamKeys = sqlite.prepare(
        'SELECT id, slot, key FROM stream_keys WHERE slot IS NOT NULL ORDER BY slot',
    );
    const stmtListStreamKeySlots = sqlite.prepare(
        'SELECT id, slot FROM stream_keys WHERE slot IS NOT NULL ORDER BY slot',
    );
    const stmtListHostProbeTargets = sqlite.prepare(
        'SELECT slot, label, host, port FROM host_probe_targets ORDER BY slot',
    );
    const stmtListPipelineGroups = sqlite.prepare(
        'SELECT id, name, position FROM pipeline_groups ORDER BY position',
    );
    const stmtGetSetting = sqlite.prepare('SELECT value FROM settings WHERE key = ?');
    const stmtSetSetting = sqlite.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );

    // Write prepared statements
    const stmtUpdateStreamKey = sqlite.prepare('UPDATE stream_keys SET key = ? WHERE id = ?');
    const stmtInsertHostProbeTarget = sqlite.prepare(
        `INSERT INTO host_probe_targets (slot, label, host, port)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET
            label = excluded.label,
            host = excluded.host,
            port = excluded.port`,
    );
    const stmtDeleteHostProbeTarget = sqlite.prepare(
        'DELETE FROM host_probe_targets WHERE slot = ?',
    );
    const stmtInsertPipelineGroup = sqlite.prepare(
        'INSERT INTO pipeline_groups (name, position) VALUES (?, ?)',
    );
    const stmtUpdatePipelineGroup = sqlite.prepare(
        'UPDATE pipeline_groups SET name = ?, position = ? WHERE id = ?',
    );
    const stmtDeletePipelineGroup = sqlite.prepare('DELETE FROM pipeline_groups WHERE id = ?');
    const stmtDeleteOutputsForPipeline = sqlite.prepare(
        'DELETE FROM outputs WHERE pipeline_id = ?',
    );
    const stmtSetDesiredStateForPipeline = sqlite.prepare(
        'UPDATE outputs SET desired_state = ? WHERE pipeline_id = ?',
    );
    const stmtClearLastErrorsForPipeline = sqlite.prepare(
        'UPDATE outputs SET last_error = NULL WHERE pipeline_id = ?',
    );
    const stmtSetLastError = sqlite.prepare('UPDATE outputs SET last_error = ? WHERE id = ?');
    const stmtClearLastError = sqlite.prepare('UPDATE outputs SET last_error = NULL WHERE id = ?');
    const stmtInsertPipelineLog = sqlite.prepare(
        'INSERT INTO pipeline_logs (pipeline_id, ts, event, message) VALUES (?, ?, ?, ?)',
    );
    const stmtPrunePipelineLogs = sqlite.prepare(
        `DELETE FROM pipeline_logs WHERE pipeline_id = ? AND id NOT IN (
            SELECT id FROM pipeline_logs WHERE pipeline_id = ? ORDER BY id DESC LIMIT ${PIPELINE_LOG_CAP}
        )`,
    );
    const stmtGetPipelineLogs = sqlite.prepare(
        'SELECT id, pipeline_id, ts, event, message FROM pipeline_logs WHERE pipeline_id = ? ORDER BY id DESC LIMIT ?',
    );
    const stmtCreateSession = sqlite.prepare(
        'INSERT OR REPLACE INTO sessions (token, created_at) VALUES (?, ?)',
    );
    const stmtDeleteSession = sqlite.prepare('DELETE FROM sessions WHERE token = ?');
    const stmtListSessions = sqlite.prepare('SELECT token FROM sessions');
    const stmtPruneExpiredSessions = sqlite.prepare('DELETE FROM sessions WHERE created_at < ?');

    function loadAllPipelines(): Pipeline[] {
        return (stmtLoadPipelines.all() as Record<string, unknown>[]).map(rowToPipeline);
    }

    function getOutputsByPipeline(pipelineId: number): Output[] {
        return (stmtGetOutputsByPipeline.all(pipelineId) as Record<string, unknown>[]).map(
            rowToOutput,
        );
    }

    function loadAllOutputs(): Output[] {
        return (stmtLoadOutputs.all() as Record<string, unknown>[]).map(rowToOutput);
    }

    function rowToOutput(row: Record<string, unknown>): Output {
        const errorHistory = parseOutputErrorHistory(row.last_error as string | null);
        let translation: TranslationConfig | null = null;
        if (typeof row.translation_config === 'string' && row.translation_config) {
            try {
                // Through the normalizer so a stored config missing a setting (e.g. the
                // pre-dB volume fields) gets that setting's default, never NaN gain.
                translation = normalizeTranslationConfig(
                    JSON.parse(row.translation_config) as TranslationInput,
                );
            } catch {
                translation = null;
            }
        }
        return {
            id: row.id as string,
            pipelineId: row.pipeline_id as number,
            seq: row.seq as number,
            name: row.name as string,
            desiredState: row.desired_state as 'running' | 'stopped',
            videoEncoding: (row.encoding as string) || 'copy',
            url: row.url as string,
            audioEncoding: (row.audio_encoding as string) || 'copy',
            translation,
            ...deriveOutputErrorFields(errorHistory, row.desired_state as string),
        };
    }

    function getOutputById(id: string): Output | null {
        const row = stmtGetOutput.get(id) as Record<string, unknown> | undefined;
        return row ? rowToOutput(row) : null;
    }

    function loadOutputErrorHistory(id: string): OutputErrorRecord[] {
        const row = stmtGetOutput.get(id) as Record<string, unknown> | undefined;
        return row ? parseOutputErrorHistory(row.last_error as string | null) : [];
    }

    // Monotonic config revision, bumped on every config-shaping write (pipelines,
    // outputs, stream keys, settings). Clients compare the value delivered
    // with the health snapshot against the rev they loaded /api/config at; a higher
    // server rev means someone else edited the config and they should reload.
    //
    // Seeded from Date.now() (not 0) and bumped to the max of "current+1" and
    // Date.now() so it is (a) strictly increasing — even for several edits in the
    // same millisecond — and (b) always larger than any rev a client loaded before
    // a process restart. That makes a restart look like a config change to old
    // clients and prompts them to reload, which is the desired behaviour after a
    // deploy. It is kept in process memory only — no DB persistence needed.
    //
    // Deliberately excludes lastError and pipeline logs — those reach clients
    // through the health snapshot already, so bumping on them would cause needless
    // config reloads.
    let configRev = Date.now();
    const bumpConfigRev = (): void => {
        configRev = Math.max(configRev + 1, Date.now());
    };

    function nextPipelineId(): number {
        // Deliberately fills gaps: if existing IDs are [1, 2, 4, 5] the next
        // pipeline gets id=3, not 6. Pipelines are deleted and recreated often
        // enough that leaving permanent holes would exhaust readable slot names.
        const existing = loadAllPipelines();
        let id = 1;
        while (existing.some((p) => p.id === id)) id++;
        return id;
    }

    // The cap is user-facing, so shared-encode (rendition) rows are left out of the
    // count and never refused: they are bounded by the number of distinct recipes
    // per pipeline, and the system creates them on the user's behalf. They are
    // recognised by their loopback internal-app URL (see isRenditionUrl); user
    // outputs cannot be created with such a URL (api/outputs.ts).
    function assertOutputCapacity(adding: { url: string }[]): void {
        const addingUser = adding.filter((o) => !isRenditionUrl(o.url)).length;
        if (addingUser === 0) return;
        const { n } = sqlite
            .prepare(
                "SELECT COUNT(*) AS n FROM outputs WHERE url NOT LIKE 'rtmp://127.0.0.1:%/internal/r%'",
            )
            .get() as { n: number };
        if (n + addingUser > MAX_OUTPUTS) throw new OutputLimitError();
    }

    // Insert one output row without bumping the config revision — callers bump
    // once per logical write (single create or a whole bulk batch).
    function insertOutput({
        pipelineId,
        name,
        videoEncoding = 'copy',
        url,
        audioEncoding = 'copy',
        translation,
    }: {
        pipelineId: number;
        name: string;
        videoEncoding?: string;
        url: string;
        audioEncoding?: string;
        translation?: TranslationInput | null;
    }): string {
        const seqRow = sqlite
            .prepare(
                'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM outputs WHERE pipeline_id = ?',
            )
            .get(pipelineId) as { next_seq: number };
        const seq = seqRow.next_seq;
        const id = `${pipelineId}-${seq}`;
        sqlite
            .prepare(
                'INSERT INTO outputs (id, pipeline_id, seq, name, desired_state, encoding, url, audio_encoding, translation_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
                id,
                pipelineId,
                seq,
                name,
                'stopped',
                videoEncoding,
                url,
                audioEncoding,
                translation ? JSON.stringify(normalizeTranslationConfig(translation)) : null,
            );
        return id;
    }

    return {
        getSetting(key: string): string | null {
            const row = stmtGetSetting.get(key) as { value: string } | undefined;
            return row?.value ?? null;
        },

        getConfigRev(): number {
            return configRev;
        },

        setSetting(key: string, value: string): void {
            stmtSetSetting.run(key, value);
            bumpConfigRev();
        },

        listHostProbeTargets(): HostProbeTarget[] {
            return (stmtListHostProbeTargets.all() as Record<string, unknown>[]).map(
                rowToHostProbeTarget,
            );
        },

        replaceHostProbeTargets(targets: HostProbeTarget[]): void {
            const existing = new Map(
                (stmtListHostProbeTargets.all() as Record<string, unknown>[]).map((row) => {
                    const target = rowToHostProbeTarget(row);
                    return [target.slot, target];
                }),
            );
            const incomingSlots = new Set(targets.map((target) => target.slot));
            sqlite.transaction(() => {
                for (const target of targets) {
                    stmtInsertHostProbeTarget.run(
                        target.slot,
                        target.label,
                        target.host,
                        target.port,
                    );
                }
                for (const [slot] of existing) {
                    if (!incomingSlots.has(slot)) {
                        stmtDeleteHostProbeTarget.run(slot);
                    }
                }
            })();
            bumpConfigRev();
        },

        listPipelineGroups(): PipelineGroup[] {
            return (stmtListPipelineGroups.all() as Record<string, unknown>[]).map(
                rowToPipelineGroup,
            );
        },

        replacePipelineGroups(groups: { id?: number; name: string }[]): PipelineGroup[] {
            const existingIds = new Set(
                (stmtListPipelineGroups.all() as Record<string, unknown>[]).map(
                    (row) => row.id as number,
                ),
            );
            const incomingIds = new Set(
                groups.filter((g) => g.id !== undefined).map((g) => g.id as number),
            );
            sqlite.transaction(() => {
                groups.forEach((group, index) => {
                    if (group.id !== undefined && existingIds.has(group.id)) {
                        stmtUpdatePipelineGroup.run(group.name, index, group.id);
                    } else {
                        stmtInsertPipelineGroup.run(group.name, index);
                    }
                });
                for (const id of existingIds) {
                    if (!incomingIds.has(id)) stmtDeletePipelineGroup.run(id);
                }
            })();
            bumpConfigRev();
            return (stmtListPipelineGroups.all() as Record<string, unknown>[]).map(
                rowToPipelineGroup,
            );
        },

        listStreamKeys(): StreamKey[] {
            return (stmtListStreamKeys.all() as Record<string, unknown>[]).map(rowToStreamKey);
        },

        regenerateStreamKeys(): StreamKey[] {
            const rows = stmtListStreamKeySlots.all() as { id: number; slot: number }[];
            sqlite.transaction(() => {
                for (const row of rows) {
                    const newKey = `key${String(row.slot).padStart(2, '0')}_${crypto.randomBytes(16).toString('hex')}`;
                    stmtUpdateStreamKey.run(newKey, row.id);
                }
            })();
            bumpConfigRev();
            return (stmtListStreamKeys.all() as Record<string, unknown>[]).map(rowToStreamKey);
        },

        createPipeline(): Pipeline {
            const id = nextPipelineId();
            const keyRow = sqlite
                .prepare(
                    `SELECT sk.id FROM stream_keys sk
                     WHERE sk.slot IS NOT NULL
                     AND sk.id NOT IN (SELECT stream_key_id FROM pipelines WHERE stream_key_id IS NOT NULL)
                     ORDER BY sk.slot LIMIT 1`,
                )
                .get() as { id: number } | undefined;
            if (!keyRow) throw new Error('No unassigned stream keys available');
            sqlite
                .prepare('INSERT INTO pipelines (id, name, stream_key_id) VALUES (?, ?, ?)')
                .run(id, `Pipeline ${id}`, keyRow.id);
            bumpConfigRev();
            return rowToPipeline(stmtGetPipeline.get(id) as Record<string, unknown>);
        },

        getPipeline(id: number): Pipeline | undefined {
            const row = stmtGetPipeline.get(id) as Record<string, unknown> | undefined;
            return row ? rowToPipeline(row) : undefined;
        },

        getPipelineByStreamKey(streamKey: string): Pipeline | undefined {
            const row = stmtGetPipelineByStreamKey.get(streamKey) as
                | Record<string, unknown>
                | undefined;
            return row ? rowToPipeline(row) : undefined;
        },

        listPipelines(): Pipeline[] {
            return loadAllPipelines();
        },

        updatePipeline(
            id: number,
            name: string,
            streamKeyId?: number,
            groupId?: number | null,
        ): Pipeline | null {
            const columns = ['name = ?'];
            const values: (string | number | null)[] = [name];
            if (streamKeyId !== undefined) {
                columns.push('stream_key_id = ?');
                values.push(streamKeyId);
            }
            if (groupId !== undefined) {
                columns.push('group_id = ?');
                values.push(groupId);
            }
            values.push(id);
            sqlite
                .prepare(`UPDATE pipelines SET ${columns.join(', ')} WHERE id = ?`)
                .run(...values);
            bumpConfigRev();
            const row = stmtGetPipeline.get(id) as Record<string, unknown> | undefined;
            return row ? rowToPipeline(row) : null;
        },

        deletePipeline(id: number): boolean {
            const result = sqlite.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
            if (result.changes > 0) bumpConfigRev();
            return result.changes > 0;
        },

        createOutput(params): Output {
            assertOutputCapacity([params]);
            const id = insertOutput(params);
            bumpConfigRev();
            return getOutputById(id)!;
        },

        // Bulk create is all-or-nothing: a failure partway through (e.g. disk
        // error) must not leave a half-created batch behind, and the config
        // revision bumps once for the whole batch instead of once per row.
        createOutputs(paramsList): Output[] {
            const ids: string[] = [];
            sqlite.transaction(() => {
                assertOutputCapacity(paramsList);
                for (const params of paramsList) {
                    ids.push(insertOutput(params));
                }
            })();
            bumpConfigRev();
            return ids.map((id) => getOutputById(id)!);
        },

        getOutput(id: string): Output | null {
            return getOutputById(id);
        },

        listOutputs(): Output[] {
            return loadAllOutputs();
        },

        listOutputIds(): {
            id: string;
            pipelineId: number;
            lastError: string | null;
            hasErrorHistory: boolean;
        }[] {
            return (stmtLoadOutputIds.all() as Record<string, unknown>[]).map((r) => {
                const errorHistory = parseOutputErrorHistory(r.last_error as string | null);
                return {
                    id: r.id as string,
                    pipelineId: r.pipeline_id as number,
                    ...deriveOutputErrorFields(errorHistory, r.desired_state as string),
                };
            });
        },

        listOutputsForPipeline(pipelineId: number): Output[] {
            return getOutputsByPipeline(pipelineId);
        },

        updateOutput(
            id: string,
            { name, videoEncoding, url, audioEncoding, translation },
        ): Output | null {
            const existing = getOutputById(id);
            if (!existing) return null;
            sqlite
                .prepare(
                    'UPDATE outputs SET name = ?, encoding = ?, url = ?, audio_encoding = ?, translation_config = ? WHERE id = ?',
                )
                .run(
                    name,
                    videoEncoding,
                    url,
                    audioEncoding,
                    translation === undefined
                        ? existing.translation
                            ? JSON.stringify(existing.translation)
                            : null
                        : translation
                          ? JSON.stringify(normalizeTranslationConfig(translation))
                          : null,
                    id,
                );
            bumpConfigRev();
            return getOutputById(id);
        },

        setOutputDesiredState(id: string, desiredState: 'running' | 'stopped'): Output | null {
            sqlite
                .prepare('UPDATE outputs SET desired_state = ? WHERE id = ?')
                .run(desiredState, id);
            bumpConfigRev();
            return getOutputById(id);
        },

        deleteOutput(id: string): boolean {
            const output = getOutputById(id);
            if (!output) return false;
            const result = sqlite.prepare('DELETE FROM outputs WHERE id = ?').run(id);
            if (result.changes > 0) bumpConfigRev();
            return result.changes > 0;
        },

        deleteOutputsForPipeline(pipelineId: number): void {
            const result = stmtDeleteOutputsForPipeline.run(pipelineId);
            if (result.changes > 0) bumpConfigRev();
        },

        setDesiredStateForPipeline(pipelineId: number, state: 'running' | 'stopped'): void {
            const result = stmtSetDesiredStateForPipeline.run(state, pipelineId);
            if (result.changes > 0) bumpConfigRev();
        },

        clearLastErrorsForPipeline(pipelineId: number): void {
            stmtClearLastErrorsForPipeline.run(pipelineId);
        },

        setOutputLastError(
            id: string,
            message: string,
            kind: OutputErrorKind,
            failedAttempts?: number,
        ): void {
            const existing = loadOutputErrorHistory(id);
            const next = trimOutputErrorHistory([
                ...existing,
                { ts: Date.now(), message, kind, ...(failedAttempts ? { failedAttempts } : {}) },
            ]);
            stmtSetLastError.run(encodeOutputErrorHistory(next), id);
        },

        clearOutputLastError(id: string): void {
            stmtClearLastError.run(id);
        },

        getOutputErrorHistory(id: string): OutputErrorRecord[] {
            return loadOutputErrorHistory(id);
        },

        appendPipelineLog(pipelineId: number, event: string, message: string): void {
            stmtInsertPipelineLog.run(pipelineId, Date.now(), event, message);
            stmtPrunePipelineLogs.run(pipelineId, pipelineId);
        },

        getPipelineLogs(pipelineId: number, limit = LOG_RETENTION_LIMIT): PipelineLog[] {
            return (stmtGetPipelineLogs.all(pipelineId, limit) as Record<string, unknown>[]).map(
                (r) => ({
                    id: r.id as number,
                    pipelineId: r.pipeline_id as number,
                    ts: r.ts as number,
                    event: r.event as string,
                    message: r.message as string,
                }),
            );
        },

        createSession(token: string): void {
            stmtCreateSession.run(token, Date.now());
        },

        deleteSession(token: string): void {
            stmtDeleteSession.run(token);
        },

        listSessions(): string[] {
            return (stmtListSessions.all() as { token: string }[]).map((r) => r.token);
        },

        pruneExpiredSessions(maxAgeMs: number): void {
            stmtPruneExpiredSessions.run(Date.now() - maxAgeMs);
        },
    };
}
