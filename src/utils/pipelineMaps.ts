// State kept per pipeline between polls. Every map made here is emptied of a deleted
// pipeline by `keepOnly`, so a new one cannot be forgotten there.
export function createPipelineMaps() {
    const maps: Map<number, unknown>[] = [];
    return {
        map<T>(): Map<number, T> {
            const map = new Map<number, T>();
            maps.push(map);
            return map;
        },
        // Forgets every pipeline that is not in the set (the ones that were deleted).
        keepOnly(activePipelineIds: Set<number>): void {
            for (const map of maps) {
                for (const pipelineId of map.keys()) {
                    if (!activePipelineIds.has(pipelineId)) map.delete(pipelineId);
                }
            }
        },
    };
}
