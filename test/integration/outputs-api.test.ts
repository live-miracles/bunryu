import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createDb } from '../../src/db/index';
import { registerOutputApi } from '../../src/api/outputs';
import type { OutputService } from '../../src/services/outputs';
import type { Db, Output, Pipeline } from '../../src/types';
import { dispatch } from '../helpers/http';

// An output the test expects to be stored; the assertion narrows getOutput's null.
function storedOutput(db: Db, id: string): Output {
    const output = db.getOutput(id);
    assert.ok(output, `output ${id} is not stored`);
    return output;
}

// A fake process-management layer: fast, synchronous-ish, and lets tests
// force start() to fail to exercise the API's rollback-to-stopped path.
function makeFakeOutputService() {
    const statuses = new Map<string, 'running' | 'stopped'>();
    let failNextStart = false;
    return {
        failNextStart(value = true) {
            failNextStart = value;
        },
        getStats(id: string) {
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
        async start(id: string) {
            if (failNextStart) {
                failNextStart = false;
                throw new Error('boom: could not start');
            }
            statuses.set(id, 'running');
        },
        stop(id: string) {
            statuses.set(id, 'stopped');
        },
        async stopAndWait(id: string) {
            statuses.set(id, 'stopped');
        },
        retired: [] as string[],
        async retire(id: string) {
            this.retired.push(id);
            statuses.set(id, 'stopped');
        },
        restarted: [] as string[],
        restart(id: string) {
            if ((statuses.get(id) ?? 'stopped') !== 'running') return false;
            this.restarted.push(id);
            return true;
        },
        restartPipelineOutputs() {
            return 0;
        },
        shutdown() {},
    };
}

type Harness = ReturnType<typeof createHarness>;

function createHarness() {
    const app = express();
    const db = createDb(':memory:');
    const outputService = makeFakeOutputService();
    // The fake implements only what the output API calls, so it is cast once, here.
    registerOutputApi(app, db, outputService as unknown as OutputService);
    return {
        db,
        outputService,
        request: (method: string, route: string, body?: unknown) =>
            dispatch(app, method, route, body),
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

        test('rejects an invalid audioEncoding, one at a time and in bulk', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const item = {
                name: 'T',
                url: 'rtmp://a.rtmp.youtube.com/live2/key',
                audioEncoding: 'not-a-track',
            };
            const single = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, item);
            assert.equal(single.status, 400);
            assert.match(single.body.error, /audioEncoding/);
            const bulk = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [item],
            });
            assert.equal(bulk.status, 400);
            assert.match(bulk.body.error, /audioEncoding/);
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

        test('rejects a videoEncoding that is only an Object.prototype name', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            for (const videoEncoding of ['constructor', '__proto__', 'toString']) {
                const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                    name: 'X',
                    url: 'rtmp://x',
                    videoEncoding,
                });
                assert.equal(res.status, 400, videoEncoding);
            }
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 0);
        });

        test('answers 400, not 500, to a url or videoEncoding that is not a string', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'Old', url: 'rtmp://old' });
            const bodies = [
                { name: 'X', url: 123 },
                { name: 'X', url: 'rtmp://x', videoEncoding: 7 },
                { name: 'X', url: 'rtmp://x', videoEncoding: {} },
            ];
            for (const body of bodies) {
                const created = await harness.request(
                    'POST',
                    `/api/pipelines/${p.id}/outputs`,
                    body,
                );
                assert.equal(created.status, 400, JSON.stringify(body));
                const edited = await harness.request(
                    'POST',
                    `/api/pipelines/${p.id}/outputs/${o.id}`,
                    body,
                );
                assert.equal(edited.status, 400, JSON.stringify(body));
            }
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 1);
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
        const post = (harness: Harness, p: Pipeline, url: string) =>
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
            assert.equal(storedOutput(harness.db, o.id).url, 'rtmp://h.example/x');
        });
    });

    describe('restream loops', () => {
        const own = (key: string) => `rtmp://127.0.0.1:21935/live/${key}`;
        const ownSrt = (key: string) =>
            `srt://127.0.0.1:10080?streamid=#!::r=live/${key},m=publish`;

        // The server does not refuse a destination that loops back into its own pipeline:
        // the dashboard marks it on the card (output-advice.ts), and the startup re-check
        // still stops one that is running.
        test('saves an output that publishes into its own pipeline, on create, bulk and edit', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const create = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'Loop',
                url: own(p.streamKey),
            });
            assert.equal(create.status, 201);

            const srt = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'Loop SRT',
                url: ownSrt(p.streamKey),
            });
            assert.equal(srt.status, 201);

            const bulk = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [
                    { name: 'fine', url: 'rtmp://192.168.1.10/live/k' },
                    { name: 'Loop', url: own(p.streamKey) },
                ],
            });
            assert.equal(bulk.status, 201);
            assert.equal(harness.db.listOutputsForPipeline(p.id).length, 4);

            const o = harness.db.createOutput({
                pipelineId: p.id,
                name: 'O',
                url: 'rtmp://h.example/x',
            });
            const upd = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'O',
                url: own(p.streamKey),
            });
            assert.equal(upd.status, 200);
            assert.equal(storedOutput(harness.db, o.id).url, own(p.streamKey));
        });

        test('saves a loop through another pipeline, and a pipeline sharing the key', async () => {
            const harness = createHarness();
            const a = harness.db.createPipeline();
            const b = harness.db.createPipeline();
            const c = harness.db.createPipeline();
            harness.db.updatePipeline(c.id, 'C', a.streamKeyId);
            const links: [Pipeline, string][] = [
                [a, own(b.streamKey)],
                [b, own(a.streamKey)],
                [c, own(a.streamKey)],
            ];
            for (const [pipeline, url] of links) {
                const res = await harness.request('POST', `/api/pipelines/${pipeline.id}/outputs`, {
                    name: 'Restream',
                    url,
                });
                assert.equal(res.status, 201, url);
            }
        });
    });

    describe('watch link', () => {
        const url = 'https://www.youtube.com/watch?v=abc';

        test('is saved on create, in bulk and on edit, and stays when an edit leaves it out', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const created = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                name: 'YouTube',
                url: 'rtmp://a.rtmp.youtube.com/live2/key',
                watchUrl: ` ${url} `,
            });
            assert.equal(created.status, 201);
            assert.equal(created.body.watchUrl, url);

            const bulk = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                outputs: [
                    { name: 'A', url: 'rtmp://a/live/k', watchUrl: url },
                    { name: 'B', url: 'rtmp://b/live/k' },
                ],
            });
            assert.equal(bulk.status, 201);
            assert.deepEqual(
                bulk.body.map((o: Output) => o.watchUrl),
                [url, ''],
            );

            const renamed = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${created.body.id}`,
                { name: 'Renamed' },
            );
            assert.equal(renamed.body.watchUrl, url, 'an edit without it keeps it');
            const cleared = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${created.body.id}`,
                { watchUrl: '' },
            );
            assert.equal(cleared.status, 200);
            assert.equal(cleared.body.watchUrl, '');
        });

        test('refuses a link that is not http(s), on create, in bulk and on edit', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'X', url: 'rtmp://x' });
            for (const watchUrl of ['javascript:alert(1)', 'rtmp://h/a', 'not a link', 5]) {
                const label = String(watchUrl);
                const create = await harness.request('POST', `/api/pipelines/${p.id}/outputs`, {
                    name: 'x',
                    url: 'rtmp://192.168.1.2/live/k',
                    watchUrl,
                });
                assert.equal(create.status, 400, label);
                const bulk = await harness.request('POST', `/api/pipelines/${p.id}/outputs/bulk`, {
                    outputs: [{ name: 'x', url: 'rtmp://192.168.1.2/live/k', watchUrl }],
                });
                assert.equal(bulk.status, 400, label);
                const edit = await harness.request(
                    'POST',
                    `/api/pipelines/${p.id}/outputs/${o.id}`,
                    { watchUrl },
                );
                assert.equal(edit.status, 400, label);
            }
            assert.equal(harness.db.listOutputs().length, 1);
            assert.equal(storedOutput(harness.db, o.id).watchUrl, '');
        });

        test('a running output can change it without a restart, and its other settings stay locked', async () => {
            const harness = createHarness();
            const p = harness.db.createPipeline();
            const o = harness.db.createOutput({ pipelineId: p.id, name: 'Old', url: 'rtmp://x' });
            harness.db.setOutputDesiredState(o.id, 'running');

            const res = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                name: 'Old',
                watchUrl: url,
            });
            assert.equal(res.status, 200);
            const stored = storedOutput(harness.db, o.id);
            assert.equal(stored.watchUrl, url);
            assert.equal(stored.url, 'rtmp://x');
            assert.equal(stored.desiredState, 'running');
            assert.deepEqual(harness.outputService.restarted, []);

            const keepsIt = await harness.request(
                'POST',
                `/api/pipelines/${p.id}/outputs/${o.id}`,
                { name: 'Renamed' },
            );
            assert.equal(keepsIt.status, 200);
            assert.equal(storedOutput(harness.db, o.id).watchUrl, url, 'a rename keeps the link');

            const bad = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                watchUrl: 'javascript:alert(1)',
            });
            assert.equal(bad.status, 400);
            const locked = await harness.request('POST', `/api/pipelines/${p.id}/outputs/${o.id}`, {
                watchUrl: url,
                url: 'rtmp://new',
            });
            assert.equal(locked.status, 409);
            assert.equal(storedOutput(harness.db, o.id).url, 'rtmp://x');
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
        const makeRendition = (harness: Harness, p: Pipeline, url = RENDITION_URL) =>
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
            assert.equal(storedOutput(harness.db, o.id).url, 'rtmp://h/x');
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
            assert.equal(storedOutput(harness.db, r.id).desiredState, 'stopped');
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

            const res = await harness.request('DELETE', `/api/pipelines/${p.id}/outputs`);

            assert.equal(res.status, 200);
            assert.deepEqual(harness.outputService.retired, [r.id]);
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
            assert.equal(storedOutput(harness.db, a.id).desiredState, 'running');
            assert.equal(storedOutput(harness.db, b.id).desiredState, 'running');
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
            assert.equal(storedOutput(harness.db, a.id).desiredState, 'stopped');
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
                const stored = storedOutput(harness.db, o.id);
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
                assert.equal(storedOutput(harness.db, o.id).name, 'Old');
            });

            const carried: [string, Record<string, string>][] = [
                ['url', { url: 'rtmp://new' }],
                ['videoEncoding', { videoEncoding: '720p' }],
                ['audioEncoding', { audioEncoding: 'copy' }],
            ];
            for (const [label, extra] of carried) {
                test(`an edit that carries ${label} is still refused with 409, even with the same value`, async () => {
                    const { harness, p, o } = runningOutput();

                    const res = await harness.request(
                        'POST',
                        `/api/pipelines/${p.id}/outputs/${o.id}`,
                        { name: 'Renamed', ...extra },
                    );

                    assert.equal(res.status, 409);
                    assert.equal(storedOutput(harness.db, o.id).name, 'Old');
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
                assert.equal(storedOutput(harness.db, o.id).name, 'Renamed');
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
            assert.deepEqual(harness.outputService.retired, [o.id]);
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
            assert.equal(storedOutput(harness.db, o.id).desiredState, 'running');
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
            assert.equal(storedOutput(harness.db, o.id).desiredState, 'stopped');
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
            assert.equal(storedOutput(harness.db, o.id).desiredState, 'running');
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
            const restart = (o: Output) =>
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
            assert.equal(storedOutput(harness.db, o.id).desiredState, 'stopped');
            assert.equal(harness.outputService.getStats(o.id).status, 'stopped');
        });
    });
});
