'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

const { createDb } = require('../../src/db/index');
const { registerPipelineApi } = require('../../src/api/pipelines');

class MockRequest extends Readable {
    constructor(method, url, body) {
        super();
        this.method = method;
        this.url = url;
        this.headers = {};
        this.socket = { remoteAddress: '127.0.0.1' };
        this.connection = this.socket;
        this.body = body;
    }

    _read() {
        this.push(null);
    }
}

class MockResponse extends Writable {
    constructor(resolve) {
        super();
        this.statusCode = 200;
        this.headers = {};
        this.chunks = [];
        this.resolve = resolve;
        this.setHeader = (name, value) => {
            this.headers[String(name).toLowerCase()] = value;
        };
        this.getHeader = (name) => this.headers[String(name).toLowerCase()];
        this.removeHeader = (name) => {
            delete this.headers[String(name).toLowerCase()];
        };
        this.writeHead = (statusCode, headers = {}) => {
            this.statusCode = statusCode;
            for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
            return this;
        };
        this.end = (chunk, encoding, callback) => {
            if (chunk) this.chunks.push(Buffer.from(chunk, encoding));
            const text = Buffer.concat(this.chunks).toString('utf8');
            this.resolve({
                status: this.statusCode,
                body: text ? JSON.parse(text) : undefined,
            });
            if (callback) callback();
            return this;
        };
    }

    _write(chunk, _encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }
}

function dispatch(app, method, route, body) {
    return new Promise((resolve, reject) => {
        app.handle(new MockRequest(method, route, body), new MockResponse(resolve), reject);
    });
}

function makeFakePreviewService() {
    const stopped = [];
    return {
        stopped,
        stop(pipelineId) {
            stopped.push(pipelineId);
        },
    };
}

function makeFakeOutputService() {
    const stoppedAndWaited = [];
    const retired = [];
    // Outputs whose FFmpeg has not exited yet, though the operator stopped them.
    const stillRunning = new Set();
    return {
        stoppedAndWaited,
        retired,
        stillRunning,
        getStats: (outputId) => ({ status: stillRunning.has(outputId) ? 'running' : 'stopped' }),
        async stopAndWait(outputId) {
            stoppedAndWaited.push(outputId);
        },
        async retire(outputId) {
            retired.push(outputId);
        },
    };
}

function makeFakeSrtRelayService() {
    return {
        getStats() {
            return { status: 'running', pid: 4242 };
        },
        getStreamStatus(streamId) {
            return { streamId, acceptedBySrs: false };
        },
    };
}

function createHarness() {
    const app = express();
    const db = createDb(':memory:');
    const previewService = makeFakePreviewService();
    const outputService = makeFakeOutputService();
    const srtRelayService = makeFakeSrtRelayService();
    registerPipelineApi(app, db, outputService, previewService, srtRelayService);
    return {
        db,
        previewService,
        outputService,
        srtRelayService,
        request: (method, route, body) => dispatch(app, method, route, body),
    };
}

describe('Pipelines API integration', () => {
    describe('POST /api/pipelines', () => {
        test('creates a pipeline with an assigned stream key', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/pipelines');
            assert.equal(res.status, 201);
            assert.ok(res.body.id > 0);
            assert.ok(res.body.streamKey.startsWith('key'));
        });

        test('409s with the reason when every stream key is already assigned', async () => {
            const harness = createHarness();
            for (const _key of harness.db.listStreamKeys()) harness.db.createPipeline();

            const res = await harness.request('POST', '/api/pipelines');

            assert.equal(res.status, 409);
            assert.equal(res.body.error, 'No unassigned stream keys available');
        });
    });

    describe('GET /api/pipelines/:id', () => {
        test('400s for a non-numeric id', async () => {
            const harness = createHarness();
            const res = await harness.request('GET', '/api/pipelines/abc');
            assert.equal(res.status, 400);
        });

        test('404s for an unknown id', async () => {
            const harness = createHarness();
            const res = await harness.request('GET', '/api/pipelines/9999');
            assert.equal(res.status, 404);
        });

        test('merges srtRelay stats and srtBonding stream status into the pipeline payload', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();

            const res = await harness.request('GET', `/api/pipelines/${p.id}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.id, p.id);
            assert.deepEqual(res.body.srtRelay, { status: 'running', pid: 4242 });
            assert.equal(res.body.srtBonding.streamId, `#!::r=live/${p.streamKey},m=publish`);
        });
    });

    describe('POST /api/pipelines/:id (update)', () => {
        test('400s for a non-numeric id', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/pipelines/abc', { name: 'X' });
            assert.equal(res.status, 400);
        });

        test('404s for an unknown id', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/pipelines/9999', { name: 'X' });
            assert.equal(res.status, 404);
        });

        test('rejects an over-long, control-character or non-string name', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            for (const name of ['x'.repeat(81), 'a\nb', { trim: () => 'x' }, 7]) {
                const res = await harness.request('POST', `/api/pipelines/${p.id}`, { name });
                assert.equal(res.status, 400, JSON.stringify(name));
            }
            assert.equal(harness.db.getPipeline(p.id).name, p.name);
        });

        test('rejects a missing name', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}`, {});
            assert.equal(res.status, 400);
        });

        test('rejects a whitespace-only name', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}`, { name: '   ' });
            assert.equal(res.status, 400);
        });

        test('renames without touching the stream key when streamKeyId is omitted', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}`, { name: 'New' });
            assert.equal(res.status, 200);
            assert.equal(res.body.name, 'New');
            assert.equal(res.body.streamKeyId, p.streamKeyId);
            assert.deepEqual(harness.previewService.stopped, []);
        });

        test('reassigns the stream key when none of its outputs are active, and stops the preview', async () => {
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();

            const res = await harness.request('POST', `/api/pipelines/${p1.id}`, {
                name: p1.name,
                streamKeyId: p2.streamKeyId,
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.streamKeyId, p2.streamKeyId);
            assert.deepEqual(harness.previewService.stopped, [p1.id]);
        });

        test('refuses a stream key that would make an output loop back into its pipeline', async () => {
            const harness = createHarness();
            const a = harness.db.createPipeline();
            const b = harness.db.createPipeline();
            const spare = harness.db
                .listStreamKeys()
                .find((k) => k.id !== a.streamKeyId && k.id !== b.streamKeyId);
            // A feeds B, and B feeds the spare key. Putting A on the spare key closes the circle.
            harness.db.createOutput({
                pipelineId: a.id,
                name: 'A to B',
                url: `rtmp://127.0.0.1:21935/live/${b.streamKey}`,
            });
            harness.db.createOutput({
                pipelineId: b.id,
                name: 'B to spare',
                url: `rtmp://127.0.0.1:21935/live/${spare.key}`,
            });
            const res = await harness.request('POST', `/api/pipelines/${a.id}`, {
                name: a.name,
                streamKeyId: spare.id,
            });
            assert.equal(res.status, 409);
            assert.match(res.body.error, /restream loop/);
            assert.equal(harness.db.getPipeline(a.id).streamKeyId, a.streamKeyId);
            assert.equal(harness.previewService.stopped.length, 0);
        });

        test('rejects a streamKeyId that is not an existing key, before stopping anything', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            for (const streamKeyId of [null, 'abc', 1.5, 99999]) {
                const res = await harness.request('POST', `/api/pipelines/${p.id}`, {
                    name: p.name,
                    streamKeyId,
                });
                assert.equal(res.status, 400, String(streamKeyId));
                assert.equal(res.body.error, 'invalid streamKeyId');
            }
            assert.equal(harness.db.getPipeline(p.id).streamKeyId, p.streamKeyId);
            assert.deepEqual(harness.previewService.stopped, []);
        });

        test('409s a stream key change while any output is running, and does not touch the preview or db', async () => {
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p1.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');

            const res = await harness.request('POST', `/api/pipelines/${p1.id}`, {
                name: p1.name,
                streamKeyId: p2.streamKeyId,
            });

            assert.equal(res.status, 409);
            assert.equal(harness.db.getPipeline(p1.id).streamKeyId, p1.streamKeyId);
            assert.deepEqual(harness.previewService.stopped, []);
        });

        test('a shared encode still winding down does not block a key change; it is set stopped and stopped first', async () => {
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();
            const user = harness.db.createOutput({ pipelineId: p1.id, name: 'U', url: 'rtmp://u' });
            const r = harness.db.createOutput({
                pipelineId: p1.id,
                name: 'Shared encode 720p · track 0',
                url: 'rtmp://127.0.0.1:21935/internal/r1_720p_a0',
                videoEncoding: '720p',
                audioEncoding: '0',
            });
            harness.db.setOutputDesiredState(r.id, 'running');
            const desiredAtKill = {};
            const realStopAndWait = harness.outputService.stopAndWait;
            harness.outputService.stopAndWait = async (id) => {
                desiredAtKill[id] = harness.db.getOutput(id)?.desiredState;
                return realStopAndWait.call(harness.outputService, id);
            };

            const res = await harness.request('POST', `/api/pipelines/${p1.id}`, {
                name: p1.name,
                streamKeyId: p2.streamKeyId,
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.streamKeyId, p2.streamKeyId);
            // It pulled the old key: stopped (not respawned by its close handler) so
            // the next one starts on the new key. User outputs are not touched.
            assert.equal(desiredAtKill[r.id], 'stopped');
            assert.equal(user.id in desiredAtKill, false);
            assert.deepEqual(harness.previewService.stopped, [p1.id]);
        });

        test('an output the operator stopped does not block a key change while its process is still winding down', async () => {
            // Only intent counts here: a stopped output is not restarted by its close
            // handler, and nothing it still holds can break by the key changing.
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p1.id, name: 'U', url: 'rtmp://u' });
            harness.db.setOutputDesiredState(o.id, 'stopped');
            harness.outputService.stillRunning.add(o.id);

            const res = await harness.request('POST', `/api/pipelines/${p1.id}`, {
                name: p1.name,
                streamKeyId: p2.streamKeyId,
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.streamKeyId, p2.streamKeyId);
            assert.equal(harness.db.getOutput(o.id).desiredState, 'stopped');
            assert.deepEqual(harness.outputService.stoppedAndWaited, []);
        });

        test('a rendition-only change of key still refuses while a user output runs, touching no encode', async () => {
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();
            const user = harness.db.createOutput({ pipelineId: p1.id, name: 'U', url: 'rtmp://u' });
            harness.db.setOutputDesiredState(user.id, 'running');
            const r = harness.db.createOutput({
                pipelineId: p1.id,
                name: 'Shared encode 720p · track 0',
                url: 'rtmp://127.0.0.1:21935/internal/r1_720p_a0',
                videoEncoding: '720p',
                audioEncoding: '0',
            });
            harness.db.setOutputDesiredState(r.id, 'running');

            const res = await harness.request('POST', `/api/pipelines/${p1.id}`, {
                name: p1.name,
                streamKeyId: p2.streamKeyId,
            });

            assert.equal(res.status, 409);
            assert.deepEqual(harness.outputService.stoppedAndWaited, []);
            assert.equal(harness.db.getOutput(r.id).desiredState, 'running');
        });

        test('renaming with an unchanged streamKeyId succeeds even with a running output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');

            const res = await harness.request('POST', `/api/pipelines/${p.id}`, {
                name: 'Renamed',
                streamKeyId: p.streamKeyId,
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.name, 'Renamed');
            // Key didn't actually change, so the active-output guard never applies.
            assert.deepEqual(harness.previewService.stopped, []);
        });

        test('leaves the group untouched when groupId is omitted', async () => {
            const harness = createHarness();
            const [group] = harness.db.replacePipelineGroups([{ name: 'Main' }]);
            const p = harness.db.createPipeline();
            harness.db.updatePipeline(p.id, p.name, undefined, group.id);

            const res = await harness.request('POST', `/api/pipelines/${p.id}`, { name: 'New' });

            assert.equal(res.status, 200);
            assert.equal(res.body.groupId, group.id);
        });

        test('reassigns the group', async () => {
            const harness = createHarness();
            const [group] = harness.db.replacePipelineGroups([{ name: 'Main' }]);
            const p = harness.db.createPipeline();

            const res = await harness.request('POST', `/api/pipelines/${p.id}`, {
                name: p.name,
                groupId: group.id,
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.groupId, group.id);
        });

        test('clears the group with an explicit null groupId', async () => {
            const harness = createHarness();
            const [group] = harness.db.replacePipelineGroups([{ name: 'Main' }]);
            const p = harness.db.createPipeline();
            harness.db.updatePipeline(p.id, p.name, undefined, group.id);

            const res = await harness.request('POST', `/api/pipelines/${p.id}`, {
                name: p.name,
                groupId: null,
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.groupId, null);
        });

        test('rejects an unknown groupId with 400 and does not change the pipeline', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();

            const res = await harness.request('POST', `/api/pipelines/${p.id}`, {
                name: p.name,
                groupId: 999999,
            });

            assert.equal(res.status, 400);
            assert.equal(harness.db.getPipeline(p.id).groupId, null);
        });

        test('a bad groupId stops no preview and changes nothing when the key changes too', async () => {
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();

            const res = await harness.request('POST', `/api/pipelines/${p1.id}`, {
                name: p1.name,
                streamKeyId: p2.streamKeyId,
                groupId: 999999,
            });

            assert.equal(res.status, 400);
            assert.deepEqual(harness.previewService.stopped, []);
            assert.equal(harness.db.getPipeline(p1.id).streamKeyId, p1.streamKeyId);
        });
    });

    describe('DELETE /api/pipelines/:id', () => {
        test('400s for a non-numeric id', async () => {
            const harness = createHarness();
            const res = await harness.request('DELETE', '/api/pipelines/abc');
            assert.equal(res.status, 400);
        });

        test('404s for an unknown id', async () => {
            const harness = createHarness();
            const res = await harness.request('DELETE', '/api/pipelines/9999');
            assert.equal(res.status, 404);
        });

        test('409s and deletes nothing while any output is running', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}`);

            assert.equal(res.status, 409);
            assert.ok(harness.db.getPipeline(p.id));
            assert.deepEqual(harness.outputService.retired, []);
        });

        test('a shared encode still winding down does not block deleting; every output is retired', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const user = harness.db.createOutput({ pipelineId: p.id, name: 'U', url: 'rtmp://u' });
            const r = harness.db.createOutput({
                pipelineId: p.id,
                name: 'Shared encode 720p · track 0',
                url: 'rtmp://127.0.0.1:21935/internal/r1_720p_a0',
                videoEncoding: '720p',
                audioEncoding: '0',
            });
            harness.db.setOutputDesiredState(r.id, 'running');

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}`);

            assert.equal(res.status, 200);
            assert.equal(harness.db.getPipeline(p.id), undefined);
            assert.deepEqual(new Set(harness.outputService.retired), new Set([r.id, user.id]));
        });

        test('an output the operator stopped but whose process is still winding down is retired, so it is awaited before the row goes', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'U', url: 'rtmp://u' });
            harness.db.setOutputDesiredState(o.id, 'stopped');
            harness.outputService.stillRunning.add(o.id);

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}`);

            assert.equal(res.status, 200);
            assert.deepEqual(harness.outputService.retired, [o.id]);
            assert.equal(harness.db.getPipeline(p.id), undefined);
        });

        test('stops the preview and every output, then deletes the pipeline and cascades its outputs', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o1 = harness.db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
            const o2 = harness.db.createOutput({ pipelineId: p.id, name: 'B', url: 'rtmp://b' });

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}`);

            assert.equal(res.status, 200);
            assert.equal(harness.db.getPipeline(p.id), undefined);
            assert.deepEqual(harness.previewService.stopped, [p.id]);
            assert.deepEqual(new Set(harness.outputService.retired), new Set([o1.id, o2.id]));
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 0);
        });
    });

    describe('GET /api/pipelines/:id/logs', () => {
        test('400s for a non-numeric id', async () => {
            const harness = createHarness();
            const res = await harness.request('GET', '/api/pipelines/abc/logs');
            assert.equal(res.status, 400);
        });

        test('404s for an unknown pipeline', async () => {
            const harness = createHarness();
            const res = await harness.request('GET', '/api/pipelines/9999/logs');
            assert.equal(res.status, 404);
        });

        test('returns logs newest first', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            harness.db.appendPipelineLog(p.id, 'online', 'first');
            harness.db.appendPipelineLog(p.id, 'online', 'second');

            const res = await harness.request('GET', `/api/pipelines/${p.id}/logs`);

            assert.equal(res.status, 200);
            assert.deepEqual(
                res.body.map((l) => l.message),
                ['second', 'first'],
            );
        });

        test('returns an empty array for a pipeline with no logs', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('GET', `/api/pipelines/${p.id}/logs`);
            assert.deepEqual(res.body, []);
        });
    });
});
