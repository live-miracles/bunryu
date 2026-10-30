'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerPreviewApi } = require('../../src/api/preview');
const { PipelineNotFoundError } = require('../../src/utils/pipelineNotFoundError');

describe('preview start API', () => {
    let server;
    let base;
    const started = [];

    before(async () => {
        const app = express();
        app.use(express.json());
        registerPreviewApi(app, {
            baseDir: '/nonexistent',
            start: async (id, count) => {
                if (id === 404) throw new PipelineNotFoundError();
                if (id === 500) throw new Error('ffmpeg exploded');
                started.push([id, count]);
                return { hlsUrl: `/hls/${id}/index.m3u8` };
            },
            keepalive: () => true,
            stop: () => {},
        });
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => server.close());

    const start = (body) =>
        fetch(`${base}/api/pipelines/1/preview/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });

    test('a tiny request with a huge audioTrackCount is refused before any work happens', async () => {
        const before = started.length;

        for (const audioTrackCount of [1_000_000_000, 51, 1e21, 2 ** 53]) {
            const res = await start({ audioTrackCount });
            assert.equal(res.status, 400, String(audioTrackCount));
        }

        assert.equal(started.length, before, 'the preview service must never be called');
    });

    test('rejects values that are not a positive integer', async () => {
        for (const audioTrackCount of [0, -1, 1.5, '3', null, [2], {}]) {
            const res = await start({ audioTrackCount });
            assert.equal(res.status, 400, JSON.stringify(audioTrackCount));
        }
    });

    test('accepts 1 to 50 and defaults to 1 when omitted', async () => {
        assert.equal((await start({ audioTrackCount: 50 })).status, 200);
        assert.equal((await start({ audioTrackCount: 1 })).status, 200);
        assert.equal((await start({})).status, 200);

        assert.deepEqual(started.slice(-3), [
            [1, 50],
            [1, 1],
            [1, 1],
        ]);
    });

    test('an unknown pipeline is a 404, any other failure a 500 with its message', async () => {
        const post = (id) =>
            fetch(`${base}/api/pipelines/${id}/preview/start`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
            });

        const missing = await post(404);
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { error: 'Pipeline not found' });

        const broken = await post(500);
        assert.equal(broken.status, 500);
        assert.match((await broken.json()).error, /ffmpeg exploded/);
    });
});
