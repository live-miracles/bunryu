import type { Db } from '../types.js';
import { ownIngestKey } from './destination.js';

// An output that publishes into this server's own ingest feeds whichever pipelines read
// that stream key. A loop is a chain of such outputs that comes back to the key the
// output's own pipeline reads: A to itself, A to B to A, and so on. Keys decide it, not
// pipeline ids, because pipelines may share a key and then read the same stream.
export interface RestreamLoopOptions {
    // An output that is being edited: its stored URL is about to be replaced.
    skipOutputId?: string;
    // The key the pipeline is about to move to, when it is not the stored one.
    streamKey?: string;
}

export type RestreamLoopChecker = (
    pipelineId: number,
    url: string,
    options?: RestreamLoopOptions,
) => Promise<string | null>;

export function createRestreamLoopChecker(
    db: Pick<Db, 'listPipelines' | 'listOutputs'>,
): RestreamLoopChecker {
    // One URL is resolved once however many checks look at it.
    const targets = new Map<string, Promise<string | null>>();
    const targetKey = (url: string): Promise<string | null> => {
        let known = targets.get(url);
        if (!known) {
            known = ownIngestKey(url).catch(() => null);
            targets.set(url, known);
        }
        return known;
    };

    return async (pipelineId, url, options = {}) => {
        const pipelines = new Map(db.listPipelines().map((p) => [p.id, p]));
        const inputKey = options.streamKey ?? pipelines.get(pipelineId)?.streamKey;
        if (!inputKey) return null;
        const first = await targetKey(url);
        if (first === null) return null;
        if (first === inputKey) {
            return "destination publishes into this pipeline's own input, which would loop the stream back into itself";
        }

        // Outputs of the other pipelines, grouped by the key their pipeline reads. This
        // pipeline's own outputs never need following: reaching its key is the loop.
        const byKey = new Map<string, { pipelineName: string; url: string }[]>();
        for (const output of db.listOutputs()) {
            if (output.pipelineId === pipelineId || output.id === options.skipOutputId) continue;
            const pipeline = pipelines.get(output.pipelineId);
            if (!pipeline?.streamKey) continue;
            const list = byKey.get(pipeline.streamKey) ?? [];
            list.push({ pipelineName: pipeline.name, url: output.url });
            byKey.set(pipeline.streamKey, list);
        }

        const seen = new Set<string>([first]);
        const queue = [first];
        while (queue.length > 0) {
            const key = queue.shift() as string;
            for (const next of byKey.get(key) ?? []) {
                const nextKey = await targetKey(next.url);
                if (nextKey === null) continue;
                if (nextKey === inputKey) {
                    return `destination loops back into this pipeline's input through pipeline "${next.pipelineName}" (a restream loop)`;
                }
                if (!seen.has(nextKey)) {
                    seen.add(nextKey);
                    queue.push(nextKey);
                }
            }
        }
        return null;
    };
}
