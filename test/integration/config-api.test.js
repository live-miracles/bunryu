'use strict';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-config-'));
const originalCwd = process.cwd();

before(() => {
    fs.writeFileSync(
        path.join(tempDir, 'bunryu.json'),
        JSON.stringify(
            {
                port: 8080,
                database_path: './db.sqlite',
                srs_config_path: './srs.conf',
                ffmpeg_path: 'ffmpeg',
                ffprobe_path: 'ffprobe',
            },
            null,
            4,
        ),
        'utf8',
    );
    fs.writeFileSync(
        path.join(tempDir, 'srs.conf'),
        [
            'listen 1935;',
            'http_api {',
            '    listen 1985;',
            '}',
            'srt_server {',
            '    listen 10080;',
            '    passphrase srs-secret-pass;',
            '}',
        ].join('\n'),
        'utf8',
    );
    fs.writeFileSync(
        path.join(tempDir, 'srt-bonding-relay.json'),
        JSON.stringify(
            {
                input_host: '0.0.0.0',
                input_port: 10081,
                output_host: '127.0.0.1',
                output_port: 10080,
                status_port: 8081,
                passphrase: 'relay-secret-pass',
            },
            null,
            4,
        ),
        'utf8',
    );
});

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

class MockRequest extends Readable {
    constructor(method, url) {
        super();
        this.method = method;
        this.url = url;
        this.headers = {};
        this.socket = { remoteAddress: '127.0.0.1' };
        this.connection = this.socket;
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

function dispatch(app, method, route) {
    return new Promise((resolve, reject) => {
        app.handle(new MockRequest(method, route), new MockResponse(resolve), reject);
    });
}

// appConfig/srsConfig/relayConfig each cache their parsed result at module
// scope, so every test needs a fully fresh require to see its own fixture.
function loadHarness() {
    process.chdir(tempDir);
    for (const mod of [
        '../../src/api/config',
        '../../src/utils/appConfig',
        '../../src/utils/srsConfig',
        '../../src/utils/relayConfig',
    ]) {
        delete require.cache[require.resolve(mod)];
    }
    const { registerConfigApi } = require('../../src/api/config');
    const { createDb } = require('../../src/db/index');
    const app = express();
    const db = createDb(':memory:');
    registerConfigApi(app, db);
    return { app, db, get: () => dispatch(app, 'GET', '/api/config') };
}

describe('Config API integration', () => {
    beforeEach(() => {
        process.chdir(tempDir);
    });

    test('returns defaults with no pipelines and no custom settings', async () => {
        const { get } = loadHarness();
        const res = await get();

        assert.equal(res.status, 200);
        assert.deepEqual(res.body.pipelines, []);
        assert.deepEqual(res.body.outputs, []);
        assert.deepEqual(res.body.hostProbeTargets, []);
        assert.deepEqual(res.body.groups, []);
        assert.equal(res.body.serverName, 'Bunryu');
        assert.equal(res.body.publicHost, 'localhost');
        assert.deepEqual(res.body.layoutOrder, []);
        assert.equal(res.body.streamKeys.length, 99);
        assert.ok(Array.isArray(res.body.encodings) && res.body.encodings.includes('copy'));
    });

    test('pipeline publish URLs use the public host, local variants always use localhost', async () => {
        const { db, get } = loadHarness();
        db.setSetting('publicHost', 'stream.example.com');
        const p = db.createPipeline();

        const res = await get();
        const pipeline = res.body.pipelines.find((x) => x.id === p.id);

        assert.match(pipeline.rtmpPublishUrl, /stream\.example\.com/);
        assert.match(pipeline.srtPublishUrl, /stream\.example\.com/);
        assert.match(pipeline.rtmpPublishUrlLocal, /localhost/);
        assert.match(pipeline.srtPublishUrlLocal, /localhost/);
        assert.doesNotMatch(pipeline.rtmpPublishUrlLocal, /stream\.example\.com/);
    });

    test('srtPublishUrl carries the SRS-side srt_server passphrase from srs.conf', async () => {
        const { db, get } = loadHarness();
        db.createPipeline();

        const res = await get();
        assert.match(res.body.pipelines[0].srtPublishUrl, /srs-secret-pass/);
    });

    test('srtPassphrase in the response comes from the relay config, not the SRS config', async () => {
        const { get } = loadHarness();
        const res = await get();
        // The relay listener passphrase (used for the bonding-relay URL) is a
        // separate value from SRS's own srt_server passphrase.
        assert.equal(res.body.srtPassphrase, 'relay-secret-pass');
    });

    test('configRev increments as the db is mutated', async () => {
        const { db, get } = loadHarness();
        const before = await get();
        db.createPipeline();
        const after = await get();
        assert.ok(after.body.configRev > before.body.configRev);
    });

    test('valid layoutOrder JSON round-trips through the config response', async () => {
        const { db, get } = loadHarness();
        const order = [{ id: 1, outs: ['1-1', '1-2'] }];
        db.setSetting('layoutOrder', JSON.stringify(order));

        const res = await get();
        assert.deepEqual(res.body.layoutOrder, order);
    });

    test('corrupt (non-JSON) layoutOrder falls back to an empty array instead of crashing', async () => {
        const { db, get } = loadHarness();
        db.setSetting('layoutOrder', 'not json{{{');

        const res = await get();
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.layoutOrder, []);
    });

    test('layoutOrder that is valid JSON but not an array falls back to an empty array', async () => {
        const { db, get } = loadHarness();
        db.setSetting('layoutOrder', JSON.stringify({ id: 1, outs: [] }));

        const res = await get();
        assert.deepEqual(res.body.layoutOrder, []);
    });

    test('layoutOrder entries with the wrong shape fall back to an empty array', async () => {
        const { db, get } = loadHarness();
        for (const bad of [
            [{ id: '1', outs: [] }], // id not an integer
            [{ id: 1, outs: 'nope' }], // outs not an array
            [{ id: 1, outs: [42] }], // outs entries not strings
            [{ id: 1 }], // missing outs
            ['not-an-object'],
        ]) {
            db.setSetting('layoutOrder', JSON.stringify(bad));
            const res = await get();
            assert.deepEqual(res.body.layoutOrder, [], `expected [] for ${JSON.stringify(bad)}`);
        }
    });

    test('an empty-string layoutOrder setting is treated as "none set"', async () => {
        const { db, get } = loadHarness();
        db.setSetting('layoutOrder', '');
        const res = await get();
        assert.deepEqual(res.body.layoutOrder, []);
    });

    test('pipeline groups are present in the response, ordered by position', async () => {
        const { db, get } = loadHarness();
        const [backup, main] = db.replacePipelineGroups([{ name: 'Backup' }, { name: 'Main' }]);
        // Reorder so 'Main' comes first — position follows array order.
        db.replacePipelineGroups([
            { id: main.id, name: main.name },
            { id: backup.id, name: backup.name },
        ]);

        const res = await get();
        assert.deepEqual(
            res.body.groups.map((g) => g.name),
            ['Main', 'Backup'],
        );
    });

    test('multiple pipelines and outputs are all present in the response', async () => {
        const { db, get } = loadHarness();
        const p1 = db.createPipeline();
        const p2 = db.createPipeline();
        db.createOutput({ pipelineId: p1.id, name: 'A', url: 'rtmp://a' });
        db.createOutput({ pipelineId: p2.id, name: 'B', url: 'rtmp://b' });

        const res = await get();
        assert.equal(res.body.pipelines.length, 2);
        assert.equal(res.body.outputs.length, 2);
    });
});
