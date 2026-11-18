import type { Db } from '../types.js';
import type { OutputService } from './outputs.js';

// A person, the destination policy or the shared-encode reconciler changes what an output
// should be doing: the Desired state is written first, then the process is told. The order
// is the point. The close handler of an exited ffmpeg retries only an output that is
// desired-running, so a Stop that kills first can see its output respawned, and a Start
// that spawns first can see its output never retried after a crash. Every caller goes
// through here, so none repeats the pair by hand (`retire()`, for an output about to be
// deleted, is the third member and stays in the service).

// Desired-running, then start. If the start throws (an invalid URL, an output that is gone)
// the output goes back to desired-stopped and the error is rethrown, so nothing is left
// "running" that no retry loop owns.
export async function wantRunning(
    db: Pick<Db, 'setOutputDesiredState'>,
    outputService: Pick<OutputService, 'start'>,
    outputId: string,
    options?: { byUser?: boolean },
): Promise<void> {
    db.setOutputDesiredState(outputId, 'running');
    try {
        await outputService.start(outputId, options);
    } catch (err) {
        try {
            db.setOutputDesiredState(outputId, 'stopped');
        } catch {
            /* best-effort: the start error is the one to report */
        }
        throw err;
    }
}

// Desired-stopped, then stop. Does not wait for the process to exit: use `retire()` when the
// row is about to be deleted.
export function wantStopped(
    db: Pick<Db, 'setOutputDesiredState'>,
    outputService: Pick<OutputService, 'stop'>,
    outputId: string,
): void {
    db.setOutputDesiredState(outputId, 'stopped');
    outputService.stop(outputId);
}
