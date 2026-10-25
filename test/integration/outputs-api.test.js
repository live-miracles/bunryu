'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

const { createDb } = require('../../src/db/index');
const { registerOutputApi } = require('../../src/api/outputs');

class MockRequest extends Readable {
    constructor(method, url, body) {
        super();
        this.method = method;
        this.url = url;
        this.headers =
            body === undefined
                ? {}
                : {
                      'content-type': 'application/json',
                      'content-length': Buffer.byteLength(JSON.stringify(body)),
                  };
        this.socket = { remoteAddress: '127.0.0.1' };
        this.connection = this.socket;
        this.body = body;
        this.bodyText = body === undefined ? '' : JSON.stringify(body);
    }

    _read() {
        this.push(this.bodyText);
        this.push(null);
        this.bodyText = '';
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
                headers: this.headers,
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
        const req = new MockRequest(method, route, body);
        const res = new MockResponse(resolve);
        app.handle(req, res, reject);
    });
}

// A fake process-management layer: fast, synchronous-ish, and lets tests
// force start() to fail to exercise the API's rollback-to-stopped path.
function makeFakeOutputService() {
    const statuses = new Map();
    let failNextStart = false;
    return {
        failNextStart(value = true) {
            failNextStart = value;
        },
        getStats(id) {
            return {
                status: statuses.get(id) ?? 'stopped',
                pid: null,
                bitrateKbps: null,
                startedAtMs: null,
                failures: 0,
                warningReason: null,
                memoryUsageBytes: null,
                memoryLimitBytes: null,
                cpuPercent: null,
            };
        },
        async start(id) {
            if (failNextStart) {
                failNextStart = false;
                throw new Error('boom: could not start');
            }
            statuses.set(id, 'running');
        },
        stop(id) {
            statuses.set(id, 'stopped');
        },
        async stopAndWait(id) {
            statuses.set(id, 'stopped');
        },
        restarted: [],
        restart(id) {
            if ((statuses.get(id) ?? 'stopped') !== 'running') return false;
            this.restarted.push(id);
            return true;
        },
        restartPipelineOutputs() {
            return 0;
        },
        clearRetryState() {},
        shutdown() {},
    };
}

function createHarness() {
    const app = express();
    const db = createDb(':memory:');
    const outputService = makeFakeOutputService();
    registerOutputApi(app, db, outputService);
    return {
        db,
        outputService,
        request: (method, route, body) => dispatch(app, method, route, body),
    };
}

describe('Outputs API integration', () => {
    describe('POST /api/pipelines/:pipelineId/outputs', () => {
        test('creates an output with a valid rtmp destination', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'YouTube',
                url: 'rtmp://a.rtmp.youtube.com/live2/key',
            });

            assert.equal(res.status, 201);
            assert.equal(res.body.name, 'YouTube');
            assert.equal(res.body.videoEncoding, 'copy');
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 1);
        });

        test('stores translation source volumes in dB and defaults them when omitted', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const translator = harness.db.createPipeline();
            const body = (translation) => ({
                name: 'T',
                url: 'rtmp://a.rtmp.youtube.com/live2/key',
                audioEncoding: 'translation',
                translation: { translatorStreamKey: translator.streamKey, ...translation },
            });

            const explicit = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs`,
                body({ duckVolumeDb: -30, restoreVolumeDb: -3 }),
            );
            assert.equal(explicit.status, 201);
            assert.equal(explicit.body.translation.duckVolumeDb, -30);
            assert.equal(explicit.body.translation.restoreVolumeDb, -3);

            const defaults = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs`,
                body({}),
            );
            assert.equal(defaults.status, 201);
            assert.equal(defaults.body.translation.duckVolumeDb, -24);
            assert.equal(defaults.body.translation.restoreVolumeDb, -6);
        });

        test('rejects translation source volumes outside -60..0 dB', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const translator = harness.db.createPipeline();
            for (const [field, value] of [
                ['duckVolumeDb', 6],
                ['duckVolumeDb', -61],
                ['restoreVolumeDb', 50],
                ['restoreVolumeDb', -100],
            ]) {
                const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                    name: 'T',
                    url: 'rtmp://a.rtmp.youtube.com/live2/key',
                    audioEncoding: 'translation',
                    translation: { translatorStreamKey: translator.streamKey, [field]: value },
                });
                assert.equal(res.status, 400, `${field}=${value}`);
                assert.match(res.body.error, new RegExp(field));
            }
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 0);
        });

        test('404s for a nonexistent pipeline', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/pipelines/9999/outputs', {
                name: 'X',
                url: 'rtmp://x',
            });
            assert.equal(res.status, 404);
        });

        test('400s for a non-numeric pipelineId', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/pipelines/abc/outputs', {
                name: 'X',
                url: 'rtmp://x',
            });
            assert.equal(res.status, 400);
        });

        test('rejects a missing name', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                url: 'rtmp://x',
            });
            assert.equal(res.status, 400);
        });

        test('rejects a blank (whitespace-only) name', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: '   ',
                url: 'rtmp://x',
            });
            assert.equal(res.status, 400);
        });

        test('rejects an unknown videoEncoding', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'X',
                url: 'rtmp://x',
                videoEncoding: '8k_ultra',
            });
            assert.equal(res.status, 400);
        });

        test('rejects a non-rtmp/srt destination url', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'X',
                url: 'http://example.com',
            });
            assert.equal(res.status, 400);
        });

        test('rejects multiple audio tracks on a non-SRT destination', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'X',
                url: 'rtmp://x',
                audioEncoding: '0,1',
            });
            assert.equal(res.status, 400);
        });

        test('allows multiple audio tracks on an SRT destination', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'X',
                url: 'srt://host:10080?streamid=test',
                audioEncoding: '0,1',
            });
            assert.equal(res.status, 201);
        });
    });

    describe('destination policy', () => {
        const post = (harness, p, url) =>
            harness.request('POST', `/api/pipelines/${p.id}/outputs`, { name: 'X', url });

        test('rejects cloud-metadata, wrong-port loopback and numeric loopback spellings', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            for (const url of [
                'rtmp://169.254.169.254/live/k',
                'rtmp://127.0.0.1:1985/live/k',
                'rtmp://2130706433:8080/live/k',
                'srt://0.0.0.0:9000',
            ]) {
                const res = await post(harness, p, url);
                assert.equal(res.status, 400, url);
            }
            assert.equal(harness.db.listOutputs().length, 0);
        });

        test('allows the server’s own ports on loopback and private-LAN destinations', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            for (const url of [
                'rtmp://localhost:21935/live/key02_abc',
                'rtmp://192.168.1.10:1935/live/k',
                'srt://0.0.0.0:9000?mode=listener',
            ]) {
                const res = await post(harness, p, url);
                assert.equal(res.status, 201, url);
            }
        });

        test('bulk and update paths are checked too', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const bulk = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [
                    { name: 'fine', url: 'rtmp://192.168.1.10/live/k' },
                    { name: 'bad', url: 'rtmp://169.254.169.254/live/k' },
                ],
            });
            assert.equal(bulk.status, 400);
            assert.equal(harness.db.listOutputs().length, 0);

            const o = harness.db.createOutput({
                pipelineId: p.id,
                name: 'O',
                url: 'rtmp://h.example/x',
            });
            const upd = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'O',
                url: 'rtmp://127.0.0.1:1985/live/k',
            });
            assert.equal(upd.status, 400);
            assert.equal(harness.db.getOutput(o.id).url, 'rtmp://h.example/x');
        });
    });

    describe('input bounds', () => {
        test('rejects over-long, empty, control-character and non-string output names', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            for (const name of ['x'.repeat(81), '   ', 'a\nb', { trim: () => 'x' }, 42]) {
                const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                    name,
                    url: 'rtmp://192.168.1.2/live/k',
                });
                assert.equal(res.status, 400, JSON.stringify(name));
            }
            assert.equal(harness.db.listOutputs().length, 0);
        });

        test('rejects destination URLs carrying markup or whitespace', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            for (const url of ['rtmp://<svg onload=a()>', 'rtmp://h/live/a b', 'rtmp://h/"x']) {
                const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                    name: 'x',
                    url,
                });
                assert.equal(res.status, 400, url);
            }
        });

        test('rejects an audioEncoding with an out-of-range track index', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            for (const audioEncoding of ['50', '0,99999999999']) {
                const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                    name: 'x',
                    url: 'rtmp://192.168.1.2/live/k',
                    audioEncoding,
                });
                assert.equal(res.status, 400, audioEncoding);
            }
        });
    });

    describe('shared encodes (renditions)', () => {
        const RENDITION_URL = 'rtmp://127.0.0.1:21935/internal/r1_720p_a0';
        const makeRendition = (harness, p, url = RENDITION_URL) =>
            harness.db.createOutput({
                pipelineId: p.id,
                name: 'Shared encode 720p · track 0',
                url,
                videoEncoding: '720p',
                audioEncoding: '0',
            });

        test('user outputs cannot target the internal app, whatever the host spelling', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            for (const url of [
                'rtmp://127.0.0.1:21935/internal/r1_720p_a0',
                'rtmp://localhost:21935/internal/r1_720p_a0',
                'rtmp://127.1:21935/internal/anything',
                'rtmp://2130706433:21935/internal/anything',
                'rtmp://[::1]:21935/internal/anything',
                'rtmp://user:pw@127.0.0.1:21935/internal/anything',
            ]) {
                const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                    name: 'X',
                    url,
                });
                assert.equal(res.status, 400, url);
                assert.match(res.body.error, /internal app is reserved for shared encodes/, url);
            }
            assert.equal(harness.db.listOutputs().length, 0);
        });

        test('other apps on the same loopback port and other hosts named internal stay allowed', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            for (const url of [
                'rtmp://localhost:21935/live/key02_abc',
                'rtmp://localhost:21935/internalx/y',
                'rtmp://192.168.1.10:1935/internal/r1_720p_a0',
            ]) {
                const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                    name: 'X',
                    url,
                });
                assert.equal(res.status, 201, url);
            }
        });

        test('bulk create and update refuse the internal app too', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const bulk = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [
                    { name: 'fine', url: 'rtmp://192.168.1.10/live/k' },
                    { name: 'bad', url: 'rtmp://localhost:21935/internal/r1_720p_a0' },
                ],
            });
            assert.equal(bulk.status, 400);
            assert.equal(harness.db.listOutputs().length, 0);

            const o = harness.db.createOutput({ pipelineId: p.id, name: 'O', url: 'rtmp://h/x' });
            const upd = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'O',
                url: RENDITION_URL,
            });
            assert.equal(upd.status, 400);
            assert.equal(harness.db.getOutput(o.id).url, 'rtmp://h/x');
        });

        test('update, delete, start and stop of a rendition are refused with 409', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const r = makeRendition(harness, p);
            const base = `/api/pipelines/${p.id}/outputs/${r.id}`;
            const expected = { error: 'Shared encodes are managed automatically' };

            const upd = await harness.request('POST', base, { name: 'x', url: 'rtmp://h/x' });
            const del = await harness.request('DELETE', base);
            const start = await harness.request('POST', `${base}/start`);
            const stop = await harness.request('POST', `${base}/stop`);

            for (const res of [upd, del, start, stop]) {
                assert.equal(res.status, 409);
                assert.deepEqual(res.body, expected);
            }
            assert.ok(harness.db.getOutput(r.id), 'row survives');
            assert.equal(harness.db.getOutput(r.id).desiredState, 'stopped');
            assert.equal(harness.outputService.getStats(r.id).status, 'stopped');
        });

        test('error history of a rendition can be read', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const r = makeRendition(harness, p);
            harness.db.setOutputLastError(r.id, 'boom', 'crash');
            const base = `/api/pipelines/${p.id}/outputs/${r.id}/errors`;

            const got = await harness.request('GET', base);
            assert.equal(got.status, 200);
            assert.equal(got.body[0].message, 'boom');
        });

        test('clear-all needs only the user outputs stopped, and removes renditions too', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const user = harness.db.createOutput({
                pipelineId: p.id,
                name: 'U',
                url: 'rtmp://h/x',
            });
            const r = makeRendition(harness, p);
            harness.db.setOutputDesiredState(r.id, 'running');
            await harness.outputService.start(r.id);
            const desiredAtKill = [];
            const realStopAndWait = harness.outputService.stopAndWait;
            harness.outputService.stopAndWait = async (id) => {
                desiredAtKill.push(harness.db.getOutput(id)?.desiredState);
                return realStopAndWait.call(harness.outputService, id);
            };

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs`);

            assert.equal(res.status, 200);
            assert.deepEqual(desiredAtKill, ['stopped'], 'not respawned by its close handler');
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 0);
            assert.equal(harness.outputService.getStats(r.id).status, 'stopped');
            assert.ok(user);
        });

        test('clear-all still refuses while a user output runs', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const user = harness.db.createOutput({
                pipelineId: p.id,
                name: 'U',
                url: 'rtmp://h/x',
            });
            harness.db.setOutputDesiredState(user.id, 'running');
            makeRendition(harness, p);

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs`);

            assert.equal(res.status, 409);
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 2);
        });
    });

    describe('POST /api/pipelines/:pipelineId/outputs/bulk', () => {
        test('creates every valid output in the array', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [
                    { name: 'A', url: 'rtmp://a' },
                    { name: 'B', url: 'rtmp://b' },
                ],
            });
            assert.equal(res.status, 201);
            assert.equal(res.body.length, 2);
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 2);
        });

        test('rejects an empty outputs array', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [],
            });
            assert.equal(res.status, 400);
        });

        test('rejects a non-array outputs field', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: 'not-an-array',
            });
            assert.equal(res.status, 400);
        });

        test('creates nothing when one item in the batch is invalid', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [
                    { name: 'A', url: 'rtmp://a' },
                    { name: 'B', url: 'not-a-valid-url' },
                ],
            });
            assert.equal(res.status, 400);
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 0);
        });
    });

    describe('start-all / stop-all', () => {
        test('start-all flips desired state to running for every output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const a = harness.db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
            const b = harness.db.createOutput({ pipelineId: p.id, name: 'B', url: 'rtmp://b' });

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/start-all`,
                {},
            );
            assert.equal(res.status, 200);
            assert.equal(harness.db.getOutput(a.id).desiredState, 'running');
            assert.equal(harness.db.getOutput(b.id).desiredState, 'running');
        });

        test('stop-all flips desired state to stopped and calls stop on every output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const a = harness.db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
            harness.db.setOutputDesiredState(a.id, 'running');

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/stop-all`,
                {},
            );
            assert.equal(res.status, 200);
            assert.equal(harness.db.getOutput(a.id).desiredState, 'stopped');
        });

        test('start-all 404s for a nonexistent pipeline', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/pipelines/9999/outputs/start-all', {});
            assert.equal(res.status, 404);
        });
    });

    describe('POST /api/pipelines/:pipelineId/outputs/:outId (edit)', () => {
        test('edits a stopped output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'Old', url: 'rtmp://old' });

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'New',
                url: 'rtmp://new',
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.name, 'New');
            assert.equal(res.body.url, 'rtmp://new');
        });

        test('fields left out of an edit keep their stored values', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({
                pipelineId: p.id,
                name: 'Old',
                url: 'srt://dest.example:9000',
                audioEncoding: '1,2',
            });

            const renamed = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}`,
                { name: 'New' },
            );
            assert.equal(renamed.status, 200);
            assert.equal(renamed.body.name, 'New');
            assert.equal(renamed.body.url, 'srt://dest.example:9000');
            assert.equal(renamed.body.audioEncoding, '1,2');

            const moved = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                url: 'srt://other.example:9000',
            });
            assert.equal(moved.status, 200);
            assert.equal(moved.body.audioEncoding, '1,2', 'a url change keeps the tracks');
        });

        test('409s when the output is running in the process layer even if desiredState is stopped', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            // Simulate a stale-running process the DB doesn't know about yet.
            await harness.outputService.start(o.id);

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'New',
                url: 'rtmp://new',
            });
            assert.equal(res.status, 409);
        });

        test('409s when desiredState is running', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'New',
                url: 'rtmp://new',
            });
            assert.equal(res.status, 409);
        });

        describe('while the output is running', () => {
            const runningOutput = () => {
                const harness = createHarness();
                const p = harness.db.createPipeline();
                const o = harness.db.createOutput({
                    pipelineId: p.id,
                    name: 'Old',
                    url: 'rtmp://x',
                    audioEncoding: '0',
                });
                harness.db.setOutputDesiredState(o.id, 'running');
                return { harness, p, o };
            };

            test('a name-only edit renames it and leaves the settings and the process alone', async () => {
                const { harness, p, o } = runningOutput();

                const res = await harness.request(
                    'POST',
                    `/api/pipelines/${p.id}/outputs/${o.id}`,
                    {
                        name: 'Renamed',
                    },
                );

                assert.equal(res.status, 200);
                assert.equal(res.body.name, 'Renamed');
                const stored = harness.db.getOutput(o.id);
                assert.equal(stored.name, 'Renamed');
                assert.equal(stored.url, 'rtmp://x');
                assert.equal(stored.audioEncoding, '0');
                assert.equal(stored.desiredState, 'running');
                assert.deepEqual(harness.outputService.restarted, []);
            });

            test('a name-only edit still validates the name', async () => {
                const { harness, p, o } = runningOutput();

                const res = await harness.request(
                    'POST',
                    `/api/pipelines/${p.id}/outputs/${o.id}`,
                    {
                        name: '   ',
                    },
                );

                assert.equal(res.status, 400);
                assert.equal(harness.db.getOutput(o.id).name, 'Old');
            });

            for (const [label, extra] of [
                ['url', { url: 'rtmp://new' }],
                ['videoEncoding', { videoEncoding: '720p' }],
                ['audioEncoding', { audioEncoding: 'copy' }],
                ['translation', { translation: null }],
            ]) {
                test(`an edit that carries ${label} is still refused with 409, even with the same value`, async () => {
                    const { harness, p, o } = runningOutput();

                    const res = await harness.request(
                        'POST',
                        `/api/pipelines/${p.id}/outputs/${o.id}`,
                        { name: 'Renamed', ...extra },
                    );

                    assert.equal(res.status, 409);
                    assert.equal(harness.db.getOutput(o.id).name, 'Old');
                });
            }

            test('an output running in the process layer can be renamed too', async () => {
                const harness = createHarness();
                const p = harness.db.createPipeline();
                const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
                await harness.outputService.start(o.id);

                const res = await harness.request(
                    'POST',
                    `/api/pipelines/${p.id}/outputs/${o.id}`,
                    {
                        name: 'Renamed',
                    },
                );

                assert.equal(res.status, 200);
                assert.equal(harness.db.getOutput(o.id).name, 'Renamed');
            });
        });

        test('404s when the output belongs to a different pipeline', async () => {
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p1.id, name: 'X', url: 'rtmp://x' });

            const res = await harness.request('POST', `/api/pipelines/${p2.id}/outputs/${o.id}`, {
                name: 'New',
                url: 'rtmp://new',
            });
            assert.equal(res.status, 404);
        });

        test('rejects an invalid destination on edit', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'New',
                url: 'ftp://bad',
            });
            assert.equal(res.status, 400);
        });
    });

    describe('DELETE /api/pipelines/:pipelineId/outputs (clear all)', () => {
        test('deletes every stopped output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            harness.db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
            harness.db.createOutput({ pipelineId: p.id, name: 'B', url: 'rtmp://b' });

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs`);
            assert.equal(res.status, 200);
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 0);
        });

        test('409s and deletes nothing if any output is still running', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const a = harness.db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
            harness.db.createOutput({ pipelineId: p.id, name: 'B', url: 'rtmp://b' });
            harness.db.setOutputDesiredState(a.id, 'running');

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs`);
            assert.equal(res.status, 409);
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 2);
        });
    });

    describe('DELETE /api/pipelines/:pipelineId/outputs/:outId', () => {
        test('stops and deletes the output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');
            await harness.outputService.start(o.id);

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs/${o.id}`);
            assert.equal(res.status, 200);
            assert.equal(harness.db.getOutput(o.id), null);
            assert.equal(harness.outputService.getStats(o.id).status, 'stopped');
        });

        test('404s for an unknown output id', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs/nope-1`);
            assert.equal(res.status, 404);
        });
    });

    describe('GET /api/pipelines/:pipelineId/outputs/:outId/errors', () => {
        test('returns the error history', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputLastError(o.id, 'boom', 'crash');

            const res = await harness.request(
                'GET',
                `/api/pipelines/${p.id}/outputs/${o.id}/errors`,
            );
            assert.equal(res.status, 200);
            assert.equal(res.body.length, 1);
            assert.equal(res.body[0].message, 'boom');
        });

        test('404s for a mismatched pipeline/output pair', async () => {
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p1.id, name: 'X', url: 'rtmp://x' });

            const res = await harness.request(
                'GET',
                `/api/pipelines/${p2.id}/outputs/${o.id}/errors`,
            );
            assert.equal(res.status, 404);
        });
    });

    describe('POST /api/pipelines/:pipelineId/outputs/:outId/start', () => {
        test('starts the output and sets desiredState to running', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/start`,
            );
            assert.equal(res.status, 200);
            assert.equal(res.body.status.status, 'running');
            assert.equal(harness.db.getOutput(o.id).desiredState, 'running');
        });

        test('rolls desiredState back to stopped when the process layer fails to start', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.outputService.failNextStart();

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/start`,
            );
            assert.equal(res.status, 400);
            assert.match(res.body.error, /boom/);
            assert.equal(harness.db.getOutput(o.id).desiredState, 'stopped');
        });

        test('404s for an unknown output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/nope-1/start`,
            );
            assert.equal(res.status, 404);
        });
    });

    describe('POST /api/pipelines/:pipelineId/outputs/:outId/restart', () => {
        const RENDITION_URL = 'rtmp://127.0.0.1:21935/internal/r1_720p_a0';

        test('restarts a running output', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');
            await harness.outputService.start(o.id);

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/restart`,
            );

            assert.equal(res.status, 200);
            assert.deepEqual(res.body, { ok: true });
            assert.deepEqual(harness.outputService.restarted, [o.id]);
            assert.equal(harness.db.getOutput(o.id).desiredState, 'running');
        });

        test('works for a rendition, which has no start or stop of its own', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const r = harness.db.createOutput({
                pipelineId: p.id,
                name: 'Shared encode 720p · track 0',
                url: RENDITION_URL,
                videoEncoding: '720p',
                audioEncoding: '0',
            });
            await harness.outputService.start(r.id);

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${r.id}/restart`,
            );

            assert.equal(res.status, 200);
            assert.deepEqual(harness.outputService.restarted, [r.id]);
        });

        test('409s when the output is not running', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/restart`,
            );

            assert.equal(res.status, 409);
            assert.match(res.body.error, /not running/);
            assert.deepEqual(harness.outputService.restarted, []);
        });

        test('409s when the service cannot restart it (e.g. it just exited)', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            await harness.outputService.start(o.id);
            harness.outputService.restart = () => false;

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/restart`,
            );

            assert.equal(res.status, 409);
            // A refused restart must not start the 5 s lockout.
            harness.outputService.restart = () => true;
            const again = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/restart`,
            );
            assert.equal(again.status, 200);
        });

        test('refuses a second restart of the same output within 5 s, then allows it', async (t) => {
            t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const a = harness.db.createOutput({ pipelineId: p.id, name: 'A', url: 'rtmp://a' });
            const b = harness.db.createOutput({ pipelineId: p.id, name: 'B', url: 'rtmp://b' });
            await harness.outputService.start(a.id);
            await harness.outputService.start(b.id);
            const restart = (o) =>
                harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}/restart`);

            assert.equal((await restart(a)).status, 200);
            t.mock.timers.tick(4999);
            const tooSoon = await restart(a);
            assert.equal(tooSoon.status, 409);
            assert.match(tooSoon.body.error, /few seconds/);
            assert.equal((await restart(b)).status, 200, 'another output is not affected');
            t.mock.timers.tick(1);
            assert.equal((await restart(a)).status, 200);
            assert.deepEqual(harness.outputService.restarted, [a.id, b.id, a.id]);
        });

        test('translation outputs are restarted by the mixer, not here', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({
                pipelineId: p.id,
                name: 'T',
                url: 'rtmp://t',
                audioEncoding: 'translation',
            });
            await harness.outputService.start(o.id);

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/restart`,
            );

            assert.equal(res.status, 409);
            assert.match(res.body.error, /translation/i);
            assert.deepEqual(harness.outputService.restarted, []);
        });

        test('404s for an unknown output and for a mismatched pipeline', async () => {
            const harness = createHarness();
            const p1 = harness.db.createPipeline();
            const p2 = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p1.id, name: 'X', url: 'rtmp://x' });

            const unknown = await harness.request(
                'POST',
                `/api/pipelines/${p1.id}/outputs/nope-1/restart`,
            );
            const mismatched = await harness.request(
                'POST',
                `/api/pipelines/${p2.id}/outputs/${o.id}/restart`,
            );

            assert.equal(unknown.status, 404);
            assert.equal(mismatched.status, 404);
        });
    });

    describe('POST /api/pipelines/:pipelineId/outputs/:outId/stop', () => {
        test('stops the output and sets desiredState to stopped', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');
            await harness.outputService.start(o.id);

            const res = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}/stop`,
            );
            assert.equal(res.status, 200);
            assert.equal(harness.db.getOutput(o.id).desiredState, 'stopped');
            assert.equal(harness.outputService.getStats(o.id).status, 'stopped');
        });
    });
});
