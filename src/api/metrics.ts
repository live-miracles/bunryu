import type { Express } from 'express';
import type { ResourceUsage } from '../services/resourceUsage.js';

export function registerMetricsApi(app: Express, resourceUsage: ResourceUsage): void {
    app.get('/api/metrics/system', (_req, res) => {
        res.json(resourceUsage.system());
    });

    app.get('/api/metrics/history', (req, res) => {
        // The dashboard keeps samples it has already received. On regular
        // refreshes it asks only for samples newer than its latest timestamp;
        // omitting/invalidating `after` preserves the initial full-history API.
        const requestedAfter = typeof req.query.after === 'string' ? Number(req.query.after) : NaN;
        res.json(
            resourceUsage.history(Number.isFinite(requestedAfter) ? requestedAfter : undefined),
        );
    });
}
