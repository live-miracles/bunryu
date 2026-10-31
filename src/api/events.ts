import type { Express } from 'express';
import type { Db } from '../types.js';
import type { SrsEvent } from '../services/health.js';
import { buildActivityFeed, parseEventsLimit } from '../utils/activityFeed.js';

// The Events table on the Logs page: pipeline log lines, output History and Server
// events of every pipeline, merged and newest first. Read on request (not in the 5 s
// health poll): one indexed query plus the stored History of the outputs that have one.
export function registerEventsApi(app: Express, db: Db, getServerEvents: () => SrsEvent[]): void {
    app.get('/api/events', (req, res) => {
        const limit = parseEventsLimit(req.query.limit);
        return res.json(
            buildActivityFeed({
                pipelines: db.listPipelines(),
                // Each source can hold more than `limit` lines, but only the newest `limit`
                // of the merge are returned, so `limit` lines of each is always enough.
                pipelineLogs: db.listRecentPipelineLogs(limit),
                outputHistories: db.listOutputHistories(),
                serverEvents: getServerEvents(),
                limit,
            }),
        );
    });
}
