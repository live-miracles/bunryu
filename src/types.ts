export interface StreamKey {
    id: number;
    slot: number;
    key: string;
}

export interface Pipeline {
    id: number;
    name: string;
    streamKey: string;
    streamKeyId: number;
    groupId: number | null;
}

export interface PipelineGroup {
    id: number;
    name: string;
    position: number;
}

export interface TranslationConfig {
    // The translator pipeline's own stream key, not its id — resolved once at
    // save time, same as a Restream SRT/RTMP destination stores the resolved
    // publish URL rather than a live foreign key to the target pipeline. This
    // means it keeps working if the translator pipeline is deleted and its
    // stream key slot is reassigned to a new pipeline (see
    // Db.getPipelineByStreamKey), matching Restream's behavior.
    translatorStreamKey: string;
    // Which audio track of the source/translator input to mix. Both default
    // to 0 (the first track) since most inputs are single-track.
    sourceTrackIndex: number;
    translatorTrackIndex: number;
    translationDelayMs: number;
    voiceThresholdDb: number;
    duckVolumeDb: number;
    duckDurationMs: number;
    restoreSilenceMs: number;
    restoreVolumeDb: number;
    restoreDurationMs: number;
}

export interface TranslationInput {
    translatorStreamKey: string;
    sourceTrackIndex?: number;
    translatorTrackIndex?: number;
    translationDelayMs?: number;
    voiceThresholdDb?: number;
    duckVolumeDb?: number;
    duckDurationMs?: number;
    restoreSilenceMs?: number;
    restoreVolumeDb?: number;
    restoreDurationMs?: number;
}

export interface PipelineLog {
    id: number;
    pipelineId: number;
    ts: number;
    event: string;
    message: string;
}

// 'crash' covers anything that forced ffmpeg to stop unexpectedly (unhandled
// exit, or the app's own watchdogs killing a stalled/stuck/OOM process) —
// these are genuine failures and drive retry/error-status logic. 'stopped' is
// recorded on every deliberate stop, even with an empty message: whatever
// ffmpeg had printed to stderr at that moment (if anything) is kept as a
// diagnostic breadcrumb, but the marker itself exists so it becomes the
// newest history entry and supersedes any earlier crash — a stop always
// clears "is there a current error", regardless of whether stderr had
// anything to say. 'warning' records an FFmpeg warning burst (timestamp or
// decode errors) on a still-running output: it is informational, never counts
// as the current error, and has its own, smaller share of the history.
// 'started' marks a person pressing Start; like 'stopped' it supersedes an
// earlier crash as the current error.
export type OutputErrorKind = 'crash' | 'stopped' | 'warning' | 'started';

export interface OutputErrorRecord {
    ts: number;
    message: string;
    kind: OutputErrorKind;
    // On a 'stopped' record: the output was stopped while it kept failing to
    // stay up (this many failed attempts in a row), so the stop stays visible as
    // an error until the output is started again.
    failedAttempts?: number;
}

export interface Output {
    id: string;
    pipelineId: number;
    seq: number;
    name: string;
    desiredState: 'running' | 'stopped';
    videoEncoding: string;
    url: string;
    audioEncoding: string;
    translation: TranslationConfig | null;
    lastError: string | null;
    hasErrorHistory: boolean;
}

export interface Db {
    getConfigRev(): number;

    getSetting(key: string): string | null;
    setSetting(key: string, value: string): void;

    listStreamKeys(): StreamKey[];
    regenerateStreamKeys(): StreamKey[];

    listPipelineGroups(): PipelineGroup[];
    // Whole-collection replace, keyed by id (not by array position) so a
    // group that survives the save keeps the same id — pipelines reference
    // groups by id via a foreign key. An item with no id is inserted as a
    // new group; an existing group id left out of the array is deleted
    // (member pipelines fall back to ungrouped via ON DELETE SET NULL).
    replacePipelineGroups(groups: { id?: number; name: string }[]): PipelineGroup[];

    createPipeline(): Pipeline;
    getPipeline(id: number): Pipeline | undefined;
    // Resolves a translator selection back to its owning pipeline. Stream
    // keys can intentionally be shared by more than one pipeline (see
    // updatePipeline) — this returns whichever pipeline currently holds the
    // key, same ambiguity Restream destinations already accept.
    getPipelineByStreamKey(streamKey: string): Pipeline | undefined;
    listPipelines(): Pipeline[];
    // groupId is tri-state: omitted leaves the pipeline's group untouched,
    // null clears it, a number reassigns it.
    updatePipeline(
        id: number,
        name: string,
        streamKeyId?: number,
        groupId?: number | null,
    ): Pipeline | null;
    deletePipeline(id: number): boolean;

    createOutput(params: {
        pipelineId: number;
        name: string;
        videoEncoding?: string;
        url: string;
        audioEncoding?: string;
        translation?: TranslationInput | null;
    }): Output;
    // All-or-nothing batch create (single transaction, single configRev bump).
    createOutputs(
        paramsList: {
            pipelineId: number;
            name: string;
            videoEncoding?: string;
            url: string;
            audioEncoding?: string;
        }[],
    ): Output[];
    getOutput(id: string): Output | null;
    listOutputs(): Output[];
    listOutputIds(): {
        id: string;
        pipelineId: number;
        lastError: string | null;
        hasErrorHistory: boolean;
    }[];
    listOutputsForPipeline(pipelineId: number): Output[];
    updateOutput(
        id: string,
        params: {
            name: string;
            videoEncoding: string;
            url: string;
            audioEncoding: string;
            translation?: TranslationInput | null;
        },
    ): Output | null;
    setOutputDesiredState(id: string, desiredState: 'running' | 'stopped'): Output | null;
    deleteOutput(id: string): boolean;
    deleteOutputsForPipeline(pipelineId: number): void;
    setDesiredStateForPipeline(pipelineId: number, state: 'running' | 'stopped'): void;

    setOutputLastError(
        id: string,
        message: string,
        kind: OutputErrorKind,
        failedAttempts?: number,
    ): void;
    getOutputErrorHistory(id: string): OutputErrorRecord[];

    appendPipelineLog(pipelineId: number, event: string, message: string): void;
    getPipelineLogs(pipelineId: number, limit?: number): PipelineLog[];

    createSession(token: string): void;
    deleteSession(token: string): void;
    listSessions(): string[];
    pruneExpiredSessions(maxAgeMs: number): void;
}
