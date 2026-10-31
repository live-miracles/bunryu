'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-restream-loop-'));
const originalCwd = process.cwd();
let destination;
let createRestreamLoopChecker;
let createDb;

before(() => {
    fs.writeFileSync(
        path.join(tempDir, 'bunryu.json'),
        JSON.stringify({ port: 8080, database_path: './db.sqlite', srs_config_path: './srs.conf' }),
    );
    fs.writeFileSync(
        path.join(tempDir, 'srs.conf'),
        'listen 21935;\nhttp_api {\n    listen 127.0.0.1:1985;\n}\nsrt_server {\n    listen 10080;\n}\n',
    );
    process.chdir(tempDir);
    for (const mod of ['utils/destination', 'utils/srsConfig', 'utils/appConfig']) {
        delete require.cache[require.resolve(`../src/${mod}`)];
    }
    destination = require('../src/utils/destination');
    ({ createRestreamLoopChecker } = require('../src/utils/restreamLoop'));
    ({ createDb } = require('../src/db/index'));
});

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('ownIngestKey', () => {
    const key = (url) => destination.ownIngestKey(url);

    test('reads the key of an RTMP or SRT publish into this server', async () => {
        assert.equal(await key('rtmp://127.0.0.1:21935/live/key01_abc'), 'key01_abc');
        assert.equal(await key('rtmp://localhost:21935/live/key01_abc?x=1'), 'key01_abc');
        assert.equal(await key('rtmp://user:pw@127.0.0.1:21935/live/key01_abc'), 'key01_abc');
        assert.equal(await key('rtmp://2130706433:21935/live/key01_abc'), 'key01_abc');
        assert.equal(
            await key('srt://127.0.0.1:10080?streamid=#!::r=live/key01_abc,m=publish'),
            'key01_abc',
        );
        assert.equal(
            await key(
                'srt://127.0.0.1:10080?streamid=%23!::r=live/key01_abc,m=publish&latency=200',
            ),
            'key01_abc',
        );
    });

    test('a host name that resolves to one of this machine’s own addresses counts as this host', async () => {
        const own = Object.values(os.networkInterfaces())
            .flat()
            .find((i) => i && !i.internal && i.family === 'IPv4');
        if (!own) return;
        assert.equal(await key(`rtmp://${own.address}:21935/live/key01_abc`), 'key01_abc');
    });

    test('anything that does not publish into a pipeline on this server is null', async () => {
        for (const url of [
            'rtmp://8.8.8.8:21935/live/key01_abc',
            'rtmp://192.0.2.10:21935/live/key01_abc',
            'rtmp://127.0.0.1:1985/live/key01_abc',
            'rtmp://127.0.0.1:21935/internal/r1_720p_a0',
            'rtmp://127.0.0.1:21935/other/key01_abc',
            'rtmp://127.0.0.1:21935/live',
            'rtmp://127.0.0.1:21935/live/',
            'srt://127.0.0.1:10080?mode=listener&streamid=#!::r=live/key01_abc,m=publish',
            'srt://127.0.0.1:10080',
            'srt://127.0.0.1:10080?streamid=#!::r=internal/x,m=publish',
            'rtmp://does-not-exist.invalid/live/key01_abc',
        ]) {
            assert.equal(await key(url), null, url);
        }
    });
});

describe('restream loop checker', () => {
    const ownUrl = (k) => `rtmp://127.0.0.1:21935/live/${k}`;

    function setup() {
        const db = createDb(':memory:');
        const a = db.createPipeline();
        const b = db.createPipeline();
        const c = db.createPipeline();
        return { db, a, b, c, check: createRestreamLoopChecker(db) };
    }

    test('an output into its own pipeline’s key loops', async () => {
        const { a, check } = setup();
        assert.match(await check(a.id, ownUrl(a.streamKey)), /own input/);
    });

    test('an output into another pipeline is fine', async () => {
        const { a, b, check } = setup();
        assert.equal(await check(a.id, ownUrl(b.streamKey)), null);
        assert.equal(await check(a.id, 'rtmp://8.8.8.8/live/anything'), null);
    });

    test('an output into a key that no pipeline reads is fine', async () => {
        const { a, check } = setup();
        assert.equal(await check(a.id, ownUrl('nobody_reads_this')), null);
    });

    test('a pipeline that shares the key still loops into itself', async () => {
        const { db, a, b, check } = setup();
        db.updatePipeline(b.id, 'B', a.streamKeyId);
        assert.match(await check(a.id, ownUrl(a.streamKey)), /own input/);
        assert.match(await check(b.id, ownUrl(a.streamKey)), /own input/);
    });

    test('A to B and B to A is a loop, found from either side', async () => {
        const { db, a, b, check } = setup();
        db.createOutput({ pipelineId: b.id, name: 'B to A', url: ownUrl(a.streamKey) });
        const reason = await check(a.id, ownUrl(b.streamKey));
        assert.match(reason, /restream loop/);
        assert.ok(reason.includes(b.name), reason);
    });

    test('a longer chain A to B to C to A is a loop', async () => {
        const { db, a, b, c, check } = setup();
        db.createOutput({ pipelineId: b.id, name: 'B to C', url: ownUrl(c.streamKey) });
        db.createOutput({ pipelineId: c.id, name: 'C to A', url: ownUrl(a.streamKey) });
        assert.match(await check(a.id, ownUrl(b.streamKey)), /restream loop/);
    });

    test('a chain that ends elsewhere is fine, and a branch that loops elsewhere is not followed past the loop', async () => {
        const { db, a, b, c, check } = setup();
        db.createOutput({ pipelineId: b.id, name: 'B to C', url: ownUrl(c.streamKey) });
        db.createOutput({ pipelineId: c.id, name: 'C out', url: 'rtmp://8.8.8.8/live/x' });
        assert.equal(await check(a.id, ownUrl(b.streamKey)), null);
        // B and C loop between themselves; checking A into B must terminate.
        db.createOutput({ pipelineId: c.id, name: 'C to B', url: ownUrl(b.streamKey) });
        assert.equal(await check(a.id, ownUrl(b.streamKey)), null);
    });

    test('a pipeline that shares a key is followed through that key', async () => {
        const { db, a, b, c, check } = setup();
        // C reads B's key; C's output goes back to A.
        db.updatePipeline(c.id, 'C', b.streamKeyId);
        db.createOutput({ pipelineId: c.id, name: 'C to A', url: ownUrl(a.streamKey) });
        assert.match(await check(a.id, ownUrl(b.streamKey)), /restream loop/);
    });

    test('the output being edited does not count against itself', async () => {
        const { db, a, b, check } = setup();
        const o = db.createOutput({ pipelineId: a.id, name: 'A to B', url: ownUrl(b.streamKey) });
        db.createOutput({ pipelineId: b.id, name: 'B out', url: 'rtmp://8.8.8.8/live/x' });
        assert.equal(await check(a.id, ownUrl(b.streamKey), { skipOutputId: o.id }), null);
    });

    test('a pipeline with a new key is checked against that key', async () => {
        const { db, a, b, check } = setup();
        db.createOutput({ pipelineId: a.id, name: 'A to B', url: ownUrl(b.streamKey) });
        const spare = db
            .listStreamKeys()
            .find((k) => k.id !== a.streamKeyId && k.id !== b.streamKeyId);
        db.createOutput({ pipelineId: b.id, name: 'B to spare', url: ownUrl(spare.key) });
        // A moves onto the key B publishes into: A to B to A.
        assert.match(
            await check(a.id, ownUrl(b.streamKey), { streamKey: spare.key }),
            /restream loop/,
        );
        assert.equal(await check(a.id, ownUrl(b.streamKey), { streamKey: a.streamKey }), null);
    });

    test('shared encodes (renditions) never take part', async () => {
        const { db, a, check } = setup();
        db.createOutput({
            pipelineId: a.id,
            name: 'Shared encode',
            url: 'rtmp://127.0.0.1:21935/internal/r1_720p_a0',
        });
        assert.equal(await check(a.id, ownUrl('other')), null);
    });
});
