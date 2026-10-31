import type { Db } from '../types.js';
import type { OutputService } from './outputs.js';
import type { DiagnosticsLogger } from '../utils/diagnostics.js';
import { checkOutputDestination } from '../utils/destination.js';
import { createRestreamLoopChecker } from '../utils/restreamLoop.js';

const CHECK_CONCURRENCY = 16;

// New outputs are vetted by the API, but a row edited by hand in the database (or saved
// before a rule existed, like the restream loop check) can still point somewhere the
// policy forbids. Re-check them all
// once at startup: a forbidden destination is stopped and records why, so the
// operator sees it in the dashboard instead of it silently forwarding. Runs in
// the background — a slow resolver must never delay readiness or other outputs.
export async function enforceDestinationPolicy(
    db: Db,
    outputService: Pick<OutputService, 'stop'>,
    diagnostics?: DiagnosticsLogger,
): Promise<number> {
    const outputs = db.listOutputs();
    const checkLoop = createRestreamLoopChecker(db);
    let blockedCount = 0;
    for (let i = 0; i < outputs.length; i += CHECK_CONCURRENCY) {
        await Promise.all(
            outputs.slice(i, i + CHECK_CONCURRENCY).map(async (output) => {
                try {
                    const reason =
                        (await checkOutputDestination(output.url)) ??
                        (await checkLoop(output.pipelineId, output.url, {
                            skipOutputId: output.id,
                        }));
                    if (!reason) return;
                    blockedCount++;
                    db.setOutputDesiredState(output.id, 'stopped');
                    outputService.stop(output.id);
                    db.setOutputLastError(output.id, `Output stopped: ${reason}`, 'crash');
                    console.warn(
                        `[outputs] ${output.id} (${output.name}) stopped by destination policy: ${reason}`,
                    );
                    diagnostics?.event('output-destination-blocked', {
                        outputId: output.id,
                        outputName: output.name,
                        reason,
                    });
                } catch (error) {
                    console.warn(`[outputs] ${output.id} destination policy check failed:`, error);
                }
            }),
        );
    }
    return blockedCount;
}
