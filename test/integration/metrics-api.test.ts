import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { MetricSample, ResourceUsage } from '../../src/services/resourceUsage';
import { dispatch } from '../helpers/http';

// A resource usage module that answers from fixed values and records what it was asked.
function fakeResourceUsage() {
    const asked: (number | undefined)[] = [];
    const sample = (ts: number): MetricSample => ({
        ts,
        cpu: 1,
        ramUsed: 2,
        ramTotal: 3,
        rxBps: 4,
        txBps: 5,
    });
    return {
        asked,
        system: () => ({ cpu: { cores: 2, percent: 7 }, uptimeSeconds: 9 }),
        history: (after?: number) => {
            asked.push(after);
            return [sample(1), sample(2)].filter((s) => after === undefined || s.ts > after);
        },
    };
}

function loadApp() {
    const { registerMetricsApi } =
        require('../../src/api/metrics') as typeof import('../../src/api/metrics');
    const resourceUsage = fakeResourceUsage();
    const app = express();
    // The fake answers only the two calls this route makes, so it is not a full ResourceUsage.
    registerMetricsApi(app, resourceUsage as unknown as ResourceUsage);
    return {
        resourceUsage,
        system: () => dispatch(app, 'GET', '/api/metrics/system'),
        history: (query = '') => dispatch(app, 'GET', `/api/metrics/history${query}`),
    };
}

describe('Metrics API integration', () => {
    test('GET /api/metrics/system answers with the resource usage module’s figures', async () => {
        const { system } = loadApp();
        const res = await system();
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { cpu: { cores: 2, percent: 7 }, uptimeSeconds: 9 });
    });

    test('GET /api/metrics/history gives every sample when no cursor is passed', async () => {
        const { history, resourceUsage } = loadApp();
        const res = await history();
        assert.equal(res.status, 200);
        assert.deepEqual(
            res.body.map((s: MetricSample) => s.ts),
            [1, 2],
        );
        assert.deepEqual(resourceUsage.asked, [undefined]);
    });

    test('GET /api/metrics/history?after= passes the cursor on and returns only newer samples', async () => {
        const { history, resourceUsage } = loadApp();
        const res = await history('?after=1');
        assert.deepEqual(
            res.body.map((s: MetricSample) => s.ts),
            [2],
        );
        assert.deepEqual(resourceUsage.asked, [1]);
        assert.deepEqual((await history('?after=2')).body, []);
    });

    test('a cursor that is not a number gives the full history', async () => {
        const { history, resourceUsage } = loadApp();
        const res = await history('?after=soon');
        assert.equal(res.body.length, 2);
        assert.deepEqual(resourceUsage.asked, [undefined]);
    });
});
