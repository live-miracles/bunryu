'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

const { createDb } = require('../../src/db/index');
const { registerSettingsApi } = require('../../src/api/settings');

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
                text,
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

function createHarness() {
    const app = express();

    const db = createDb(':memory:');
    registerSettingsApi(app, db);

    return {
        db,
        request: (method, route, body) => dispatch(app, method, route, body),
    };
}

describe('Settings API integration', () => {
    describe('POST /api/settings/general', () => {
        test('rejects a publicHost that is not a hostname or IP, and an over-long server name', async () => {
            const harness = createHarness();
            for (const body of [
                { name: 'S', publicHost: '<script>alert(1)</script>' },
                { name: 'S', publicHost: 'a b' },
                { name: 'S', publicHost: 123 },
                { name: 'x'.repeat(81) },
            ]) {
                const res = await harness.request('POST', '/api/settings/general', body);
                assert.equal(res.status, 400, JSON.stringify(body));
            }
        });

        test('updates the server name', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/general', {
                name: 'Control Room',
            });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body, {
                serverName: 'Control Room',
                publicHost: '',
            });
            assert.equal(harness.db.getSetting('serverName'), 'Control Room');
        });

        test('leaves other settings untouched when only the name changes', async () => {
            const harness = createHarness();
            harness.db.setSetting('serverName', 'Old Name');
            harness.db.setSetting('srtPassphrase', 'secret-value');
            harness.db.replaceHostProbeTargets([
                { slot: 1, label: 'YouTube', host: 'a.rtmp.youtube.com', port: 1935 },
            ]);

            const res = await harness.request('POST', '/api/settings/general', {
                name: 'New Name',
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.serverName, 'New Name');
            assert.equal(harness.db.getSetting('serverName'), 'New Name');
            assert.equal(harness.db.getSetting('srtPassphrase'), 'secret-value');
            assert.equal(harness.db.listHostProbeTargets().length, 1);
        });

        test('ignores extraneous payload fields such as an SRT passphrase', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/general', {
                name: 'Control Room',
                srtPassphrase: 'secret-value',
            });

            assert.equal(res.status, 200);
            assert.equal(harness.db.getSetting('srtPassphrase'), null);
        });

        test('rejects a missing name', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/general', {});

            assert.equal(res.status, 400);
        });

        test('updates the public host when provided', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/general', {
                name: 'Control Room',
                publicHost: 'stream.example.com',
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.publicHost, 'stream.example.com');
            assert.equal(harness.db.getSetting('publicHost'), 'stream.example.com');
        });
    });

    describe('POST /api/settings/host-probes', () => {
        test('saves host probe targets', async () => {
            const harness = createHarness();
            const hostProbeTargets = [
                { slot: 1, label: 'YouTube', host: 'a.rtmp.youtube.com', port: 1935 },
                { slot: 2, label: 'Facebook', host: 'live-api-s.facebook.com', port: 443 },
            ];

            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets,
            });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body, { hostProbeTargets });
            assert.deepEqual(harness.db.listHostProbeTargets(), hostProbeTargets);
        });

        test('rejects an invalid host probe target', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets: [{ slot: 1, label: '', host: '', port: 1935 }],
            });

            assert.equal(res.status, 400);
            assert.deepEqual(harness.db.listHostProbeTargets(), []);
        });

        test('does not touch the server name', async () => {
            const harness = createHarness();
            harness.db.setSetting('serverName', 'Control Room');

            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets: [],
            });

            assert.equal(res.status, 200);
            assert.equal(harness.db.getSetting('serverName'), 'Control Room');
        });

        // Regression: a missing/malformed field used to be silently treated as
        // "clear everything" (return []) instead of rejected, because that
        // fallback dates back to when this field was one optional part of a
        // combined /api/settings payload. On this dedicated endpoint it must
        // reject instead of wiping existing targets.
        test('rejects a request with no hostProbeTargets field, leaving existing targets intact', async () => {
            const harness = createHarness();
            harness.db.replaceHostProbeTargets([
                { slot: 1, label: 'YouTube', host: 'a.rtmp.youtube.com', port: 1935 },
            ]);

            const res = await harness.request('POST', '/api/settings/host-probes', {});

            assert.equal(res.status, 400);
            assert.equal(harness.db.listHostProbeTargets().length, 1);
        });

        test('rejects a non-array hostProbeTargets value, leaving existing targets intact', async () => {
            const harness = createHarness();
            harness.db.replaceHostProbeTargets([
                { slot: 1, label: 'YouTube', host: 'a.rtmp.youtube.com', port: 1935 },
            ]);

            for (const bad of ['not-an-array', 42, { slot: 1 }, null]) {
                const res = await harness.request('POST', '/api/settings/host-probes', {
                    hostProbeTargets: bad,
                });
                assert.equal(res.status, 400);
            }
            assert.equal(harness.db.listHostProbeTargets().length, 1);
        });

        test('sending an explicit empty array still clears every target (the real no-op-clear path)', async () => {
            const harness = createHarness();
            harness.db.replaceHostProbeTargets([
                { slot: 1, label: 'YouTube', host: 'a.rtmp.youtube.com', port: 1935 },
            ]);

            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets: [],
            });

            assert.equal(res.status, 200);
            assert.deepEqual(harness.db.listHostProbeTargets(), []);
        });

        test('rejects more than the 10-target maximum', async () => {
            const harness = createHarness();
            const hostProbeTargets = Array.from({ length: 11 }, (_, i) => ({
                slot: i + 1,
                label: `T${i}`,
                host: `h${i}.example.com`,
                port: 1000 + i,
            }));

            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets,
            });

            assert.equal(res.status, 400);
            assert.deepEqual(harness.db.listHostProbeTargets(), []);
        });

        test('accepts exactly the 10-target maximum', async () => {
            const harness = createHarness();
            const hostProbeTargets = Array.from({ length: 10 }, (_, i) => ({
                slot: i + 1,
                label: `T${i}`,
                host: `h${i}.example.com`,
                port: 1000 + i,
            }));

            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets,
            });

            assert.equal(res.status, 200);
            assert.equal(harness.db.listHostProbeTargets().length, 10);
        });

        test('rejects duplicate slot numbers', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets: [
                    { slot: 1, label: 'A', host: 'a.example.com', port: 1935 },
                    { slot: 1, label: 'B', host: 'b.example.com', port: 443 },
                ],
            });

            assert.equal(res.status, 400);
            assert.deepEqual(harness.db.listHostProbeTargets(), []);
        });

        test('rejects slot 0 and slot 11 (out of the 1..10 range)', async () => {
            const harness = createHarness();
            for (const slot of [0, 11, -1]) {
                const res = await harness.request('POST', '/api/settings/host-probes', {
                    hostProbeTargets: [{ slot, label: 'A', host: 'a.example.com', port: 1935 }],
                });
                assert.equal(res.status, 400);
            }
        });

        test('rejects port 0 and port 65536 (out of the 1..65535 range)', async () => {
            const harness = createHarness();
            for (const port of [0, 65536, -1]) {
                const res = await harness.request('POST', '/api/settings/host-probes', {
                    hostProbeTargets: [{ slot: 1, label: 'A', host: 'a.example.com', port }],
                });
                assert.equal(res.status, 400);
            }
        });

        test('accepts port at both boundary values (1 and 65535)', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets: [
                    { slot: 1, label: 'A', host: 'a.example.com', port: 1 },
                    { slot: 2, label: 'B', host: 'b.example.com', port: 65535 },
                ],
            });
            assert.equal(res.status, 200);
        });

        test('rejects a whitespace-only label or host (trims to empty)', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets: [{ slot: 1, label: '   ', host: '   ', port: 1935 }],
            });
            assert.equal(res.status, 400);
        });

        test('a non-integer slot (e.g. fractional) is rejected', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets: [{ slot: 1.5, label: 'A', host: 'a.example.com', port: 1935 }],
            });
            assert.equal(res.status, 400);
        });

        test('a non-object array entry (e.g. a string) is rejected', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/host-probes', {
                hostProbeTargets: ['not-an-object'],
            });
            assert.equal(res.status, 400);
        });
    });

    describe('POST /api/settings/pipeline-groups', () => {
        test('saves groups in array order', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [{ name: 'Main' }, { name: 'Backup' }],
            });

            assert.equal(res.status, 200);
            assert.deepEqual(
                res.body.groups.map((g) => [g.name, g.position]),
                [
                    ['Main', 0],
                    ['Backup', 1],
                ],
            );
            assert.equal(harness.db.listPipelineGroups().length, 2);
        });

        test('preserves the id of a group that survives across saves', async () => {
            const harness = createHarness();
            const first = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [{ name: 'Main' }],
            });
            const groupId = first.body.groups[0].id;

            const second = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [{ id: groupId, name: 'Renamed' }],
            });

            assert.equal(second.status, 200);
            assert.equal(second.body.groups[0].id, groupId);
            assert.equal(second.body.groups[0].name, 'Renamed');
        });

        test('omitting a group from the array deletes it and unassigns member pipelines', async () => {
            const harness = createHarness();
            const first = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [{ name: 'Main' }],
            });
            const groupId = first.body.groups[0].id;
            const pipeline = harness.db.createPipeline();
            harness.db.updatePipeline(pipeline.id, pipeline.name, undefined, groupId);

            const res = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [],
            });

            assert.equal(res.status, 200);
            assert.deepEqual(harness.db.listPipelineGroups(), []);
            assert.equal(harness.db.getPipeline(pipeline.id).groupId, null);
        });

        test('rejects a missing name', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [{ name: '' }],
            });
            assert.equal(res.status, 400);
        });

        test('rejects a whitespace-only name', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [{ name: '   ' }],
            });
            assert.equal(res.status, 400);
        });

        test('rejects a non-array groups value', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: 'not-an-array',
            });
            assert.equal(res.status, 400);
        });

        test('rejects an over-length name', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [{ name: 'x'.repeat(81) }],
            });
            assert.equal(res.status, 400);
        });

        test('rejects more than the 50-group maximum', async () => {
            const harness = createHarness();
            const groups = Array.from({ length: 51 }, (_, i) => ({ name: `Group ${i}` }));
            const res = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups,
            });
            assert.equal(res.status, 400);
        });

        test('rejects a duplicate id in the same request', async () => {
            const harness = createHarness();
            const first = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [{ name: 'Main' }],
            });
            const groupId = first.body.groups[0].id;

            const res = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [
                    { id: groupId, name: 'A' },
                    { id: groupId, name: 'B' },
                ],
            });
            assert.equal(res.status, 400);
        });

        test('rejects a non-object array entry', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: ['not-an-object'],
            });
            assert.equal(res.status, 400);
        });
    });

    describe('POST /api/settings/layout-order', () => {
        test('saves custom pipeline and output order', async () => {
            const harness = createHarness();
            const order = [
                { id: 2, outs: ['2-2', '2-1'] },
                { id: 1, outs: ['1-1'] },
            ];

            const res = await harness.request('POST', '/api/settings/layout-order', { order });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body, { layoutOrder: order });
            assert.deepEqual(JSON.parse(harness.db.getSetting('layoutOrder')), order);
        });

        test('rejects invalid layout order', async () => {
            const harness = createHarness();
            harness.db.setSetting('layoutOrder', JSON.stringify([{ id: 1, outs: ['1-1'] }]));

            const res = await harness.request('POST', '/api/settings/layout-order', {
                order: [{ id: '1', outs: ['1-1'] }],
            });

            assert.equal(res.status, 400);
            assert.deepEqual(JSON.parse(harness.db.getSetting('layoutOrder')), [
                { id: 1, outs: ['1-1'] },
            ]);
        });

        test('rejects a missing order field entirely', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/layout-order', {});
            assert.equal(res.status, 400);
            assert.equal(harness.db.getSetting('layoutOrder'), null);
        });

        test('rejects a non-array order field', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/layout-order', {
                order: 'not-an-array',
            });
            assert.equal(res.status, 400);
        });

        test('rejects an entry whose outs array contains a non-string', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/layout-order', {
                order: [{ id: 1, outs: ['1-1', 42] }],
            });
            assert.equal(res.status, 400);
        });

        test('accepts an empty order array (clears the layout override)', async () => {
            const harness = createHarness();
            harness.db.setSetting('layoutOrder', JSON.stringify([{ id: 1, outs: [] }]));

            const res = await harness.request('POST', '/api/settings/layout-order', { order: [] });

            assert.equal(res.status, 200);
            assert.deepEqual(JSON.parse(harness.db.getSetting('layoutOrder')), []);
        });

        test('accepts an entry with an empty outs array', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/layout-order', {
                order: [{ id: 1, outs: [] }],
            });
            assert.equal(res.status, 200);
        });

        test('rejects a non-integer pipeline id', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/layout-order', {
                order: [{ id: 1.5, outs: [] }],
            });
            assert.equal(res.status, 400);
        });
    });

    describe('POST /api/settings/regenerate-stream-keys', () => {
        test('regenerates keys when no pipelines exist', async () => {
            const harness = createHarness();
            const before = harness.db.listStreamKeys();

            const res = await harness.request('POST', '/api/settings/regenerate-stream-keys', {});

            assert.equal(res.status, 200);
            assert.equal(res.body.streamKeys.length, before.length);
            assert.notEqual(res.body.streamKeys[0].key, before[0].key);
        });

        test('409s and leaves keys untouched when any pipeline exists', async () => {
            const harness = createHarness();
            const pipeline = harness.db.createPipeline();
            const before = harness.db.listStreamKeys();

            const res = await harness.request('POST', '/api/settings/regenerate-stream-keys', {});

            assert.equal(res.status, 409);
            assert.deepEqual(harness.db.listStreamKeys(), before);
            // Sanity: the pipeline itself is unaffected too.
            assert.ok(harness.db.getPipeline(pipeline.id));
        });
    });
});
