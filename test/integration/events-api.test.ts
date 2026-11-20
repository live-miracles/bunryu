import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createDb } from '../../src/db/index';
import { registerEventsApi } from '../../src/api/events';
import type { SrsEvent } from '../../src/services/health';
import type { ActivityEvent } from '../../src/utils/activityFeed';
import { dispatch } from '../helpers/http';

function setup(serverEvents: SrsEvent[] = []) {
    const db = createDb(':memory:');
    const app = express();
    registerEventsApi(app, db, () => serverEvents);
    return { db, app };
}

describe('GET /api/events', () => {
    test('is an empty list on a fresh install', async () => {
        const { app } = setup();
        const res = await dispatch(app, 'GET', '/api/events');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, []);
    });

    test('merges pipeline lines, output History and Server events', async () => {
        const { db, app } = setup([
            {
                ts: Date.now() + 10_000,
                source: 'host',
                type: 'problem',
                message: 'Disk almost full',
            },
        ]);
        const pipeline = db.createPipeline();
        const output = db.createOutput({
            pipelineId: pipeline.id,
            name: 'YT',
            url: 'rtmp://192.0.2.1/live/x',
        });
        db.appendPipelineLog(pipeline.id, 'offline', 'Input disconnected');
        // Events are ordered by time: two in one millisecond keep their source order, which
        // would make the expected order below depend on the clock.
        await new Promise((resolve) => setTimeout(resolve, 5));
        db.setOutputLastError(output.id, 'Connection refused', 'crash');

        const res = await dispatch(app, 'GET', '/api/events');
        assert.equal(res.status, 200);
        assert.deepEqual(
            res.body.map((e: ActivityEvent) => [
                e.source,
                e.pipelineName,
                e.outputName,
                e.label,
                e.severity,
            ]),
            [
                ['server', null, null, 'Host', 'error'],
                ['output', pipeline.name, 'YT', 'crash', 'error'],
                ['input', pipeline.name, null, 'offline', 'warning'],
            ],
        );
    });

    test('limit returns only the newest events', async () => {
        const { db, app } = setup();
        const pipeline = db.createPipeline();
        for (let i = 0; i < 10; i++) db.appendPipelineLog(pipeline.id, 'online', `line ${i}`);

        const res = await dispatch(app, 'GET', '/api/events?limit=3');
        assert.deepEqual(
            res.body.map((e: ActivityEvent) => e.message),
            ['line 9', 'line 8', 'line 7'],
        );
    });

    test('a bad limit gives the default instead of an error', async () => {
        const { db, app } = setup();
        const pipeline = db.createPipeline();
        for (let i = 0; i < 60; i++) db.appendPipelineLog(pipeline.id, 'online', `line ${i}`);

        // The last one makes Express parse `limit` as an array.
        for (const q of ['limit=abc', 'limit=-1', 'limit=0', 'limit=1&limit=2']) {
            const res = await dispatch(app, 'GET', `/api/events?${q}`);
            assert.equal(res.status, 200, q);
            assert.equal(res.body.length, 50, q);
        }
    });

    test('a deleted pipeline leaves no events', async () => {
        const { db, app } = setup();
        const pipeline = db.createPipeline();
        db.appendPipelineLog(pipeline.id, 'online', 'x');
        db.deletePipeline(pipeline.id);

        const res = await dispatch(app, 'GET', '/api/events');
        assert.deepEqual(res.body, []);
    });
});
