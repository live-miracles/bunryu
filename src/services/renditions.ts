import type { Db, Output } from '../types.js';
import type { OutputService } from './outputs.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';
import { cyan, red, yellow } from '../utils/ansiColor.js';
import {
    isRenditionOutput,
    renditionName,
    renditionUrl,
    sharedRecipe,
    type Recipe,
} from '../utils/renditions.js';

// Keeps one rendition output row per distinct shared recipe (see
// utils/renditions.ts) in every pipeline, and turns each on and off with the
// outputs that depend on it. The rendition is an ordinary output row, so its
// process is supervised, retried and reported by the output service; this
// service only decides which rows exist and which should be running.

const RECONCILE_INTERVAL_MS = 1000;
// A rendition keeps running this long after its last running dependent stops, so
// a quick stop/start (or a restart of a single output) does not restart the
// shared encode and drop its other readers.
export const RENDITION_IDLE_GRACE_MS = 15_000;
// A start() that throws is not transient (missing pipeline, invalid URL), so
// retrying every tick would only spam the logs; wait this long between attempts.
const START_RETRY_MS = 30_000;
// The same error repeating every tick is logged at most this often per message.
const ERROR_LOG_INTERVAL_MS = 30_000;
const MAX_TRACKED_ERRORS = 20;

export interface RenditionReconciler {
    start(): void;
    shutdown(): void;
}

export function createRenditionReconciler(
    db: Db,
    outputService: Pick<OutputService, 'start' | 'stop' | 'stopAndWait' | 'clearRetryState'>,
    diagnostics?: DiagnosticsLogger,
): RenditionReconciler {
    // Grace and back-off timestamps live in memory: after an app restart a
    // rendition with no running dependent simply idles out 15 s later.
    const idleSince = new Map<string, number>();
    const startBlockedUntil = new Map<string, number>();
    const errorLog = new Map<string, { atMs: number; suppressed: number }>();
    let timer: NodeJS.Timeout | null = null;
    let reconciling = false;
    let stopped = false;

    function reportError(pipelineId: number | null, err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        const now = Date.now();
        const seen = errorLog.get(message);
        if (seen && now - seen.atMs < ERROR_LOG_INTERVAL_MS) {
            seen.suppressed++;
            return;
        }
        if (errorLog.size >= MAX_TRACKED_ERRORS) errorLog.clear();
        errorLog.set(message, { atMs: now, suppressed: 0 });
        console.warn(red(`[renditions] reconcile failed (pipeline=${pipelineId}): ${message}`));
        diagnostics?.event('rendition-reconcile-error', {
            pipelineId,
            error: message,
            suppressedSimilar: seen?.suppressed ?? 0,
        });
    }

    function dependentsOf(userOutputs: Output[], recipe: Recipe): Output[] {
        return userOutputs.filter((o) => sharedRecipe(o)?.key === recipe.key);
    }

    function stillNeeded(pipelineId: number, url: string): boolean {
        return db.listOutputsForPipeline(pipelineId).some((o) => {
            if (isRenditionOutput(o)) return false;
            const recipe = sharedRecipe(o);
            return recipe !== null && renditionUrl(pipelineId, recipe) === url;
        });
    }

    async function removeRendition(pipelineId: number, row: Output): Promise<void> {
        // Desired-stopped first: the output service restarts a process it was
        // asked to stop while the row still says "running" (its close handler
        // cannot tell a stop from a start that raced the kill).
        if (row.desiredState === 'running') db.setOutputDesiredState(row.id, 'stopped');
        await outputService.stopAndWait(row.id);
        outputService.clearRetryState(row.id);
        // An output may have been switched to this recipe while the encode was
        // being stopped. Keep the row, desired-stopped (set above), so the next
        // dependent start is seen as a transition and starts it again.
        if (stillNeeded(pipelineId, row.url)) return;
        idleSince.delete(row.id);
        startBlockedUntil.delete(row.id);
        db.deleteOutput(row.id);
        console.log(cyan(`[renditions] ${row.id} (${row.name}) removed: no output uses it`));
        diagnostics?.event('rendition-deleted', {
            pipelineId,
            outputId: row.id,
            outputName: row.name,
            recipe: `${row.videoEncoding}/${row.audioEncoding}`,
        });
    }

    async function applyDesiredState(
        pipelineId: number,
        row: Output,
        recipe: Recipe,
        dependents: Output[],
        now: number,
    ): Promise<void> {
        const anyRunning = dependents.some((o) => o.desiredState === 'running');
        if (anyRunning) {
            idleSince.delete(row.id);
            if (row.desiredState === 'running') return;
            if (now < (startBlockedUntil.get(row.id) ?? 0)) return;
            // Only on the stopped -> running edge: start() resets the retry
            // back-off, so calling it every tick would defeat it.
            db.setOutputDesiredState(row.id, 'running');
            startBlockedUntil.delete(row.id);
            console.log(
                cyan(
                    `[renditions] ${row.id} (${row.name}) starting for ${dependents.length} output(s)`,
                ),
            );
            try {
                await outputService.start(row.id);
            } catch (err) {
                db.setOutputDesiredState(row.id, 'stopped');
                startBlockedUntil.set(row.id, now + START_RETRY_MS);
                const message = err instanceof Error ? err.message : String(err);
                console.warn(
                    red(`[renditions] ${row.id} (${row.name}) could not start: ${message}`),
                );
                diagnostics?.event('rendition-start-error', {
                    pipelineId,
                    outputId: row.id,
                    outputName: row.name,
                    recipe: recipe.key,
                    error: message,
                    retryInMs: START_RETRY_MS,
                });
            }
            return;
        }
        if (row.desiredState !== 'running') {
            idleSince.delete(row.id);
            return;
        }
        const since = idleSince.get(row.id) ?? now;
        idleSince.set(row.id, since);
        if (now - since < RENDITION_IDLE_GRACE_MS) return;
        idleSince.delete(row.id);
        db.setOutputDesiredState(row.id, 'stopped');
        outputService.stop(row.id);
        console.log(
            yellow(
                `[renditions] ${row.id} (${row.name}) stopped: no running output for ${Math.round((now - since) / 1000)}s`,
            ),
        );
        diagnostics?.event('rendition-idle-stop', {
            pipelineId,
            outputId: row.id,
            outputName: row.name,
            recipe: recipe.key,
            idleMs: now - since,
            graceMs: RENDITION_IDLE_GRACE_MS,
        });
    }

    async function reconcilePipeline(
        pipelineId: number,
        outputs: Output[],
        liveRows: Set<string>,
    ): Promise<void> {
        const userOutputs = outputs.filter((o) => !isRenditionOutput(o));
        const rows = outputs.filter(isRenditionOutput);
        const rowByUrl = new Map(rows.map((r) => [r.url, r]));

        const needed = new Map<string, Recipe>();
        for (const o of userOutputs) {
            const recipe = sharedRecipe(o);
            if (recipe) needed.set(renditionUrl(pipelineId, recipe), recipe);
        }

        for (const [url, recipe] of needed) {
            if (rowByUrl.has(url)) continue;
            const created = db.createOutput({
                pipelineId,
                name: renditionName(recipe),
                url,
                videoEncoding: recipe.videoEncoding,
                audioEncoding: recipe.audioEncoding,
            });
            rowByUrl.set(url, created);
            console.log(cyan(`[renditions] ${created.id} (${created.name}) created`));
            diagnostics?.event('rendition-created', {
                pipelineId,
                outputId: created.id,
                outputName: created.name,
                recipe: recipe.key,
            });
        }

        for (const row of rows) {
            if (!needed.has(row.url)) await removeRendition(pipelineId, row);
        }

        const now = Date.now();
        for (const [url, recipe] of needed) {
            const row = rowByUrl.get(url)!;
            liveRows.add(row.id);
            await applyDesiredState(
                pipelineId,
                row,
                recipe,
                dependentsOf(userOutputs, recipe),
                now,
            );
        }
    }

    async function reconcile(): Promise<void> {
        if (reconciling || stopped) return;
        reconciling = true;
        try {
            const byPipeline = new Map<number, Output[]>();
            for (const o of db.listOutputs()) {
                const list = byPipeline.get(o.pipelineId);
                if (list) list.push(o);
                else byPipeline.set(o.pipelineId, [o]);
            }
            const liveRows = new Set<string>();
            for (const pipeline of db.listPipelines()) {
                try {
                    await reconcilePipeline(
                        pipeline.id,
                        byPipeline.get(pipeline.id) ?? [],
                        liveRows,
                    );
                } catch (err) {
                    // One pipeline's failure must not stop the others.
                    reportError(pipeline.id, err);
                }
            }
            for (const id of [...idleSince.keys(), ...startBlockedUntil.keys()]) {
                if (!liveRows.has(id)) {
                    idleSince.delete(id);
                    startBlockedUntil.delete(id);
                }
            }
        } catch (err) {
            reportError(null, err);
        } finally {
            reconciling = false;
        }
    }

    return {
        start(): void {
            if (timer || stopped) return;
            timer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
            timer.unref?.();
        },
        shutdown(): void {
            stopped = true;
            if (timer) clearInterval(timer);
            timer = null;
        },
    };
}
