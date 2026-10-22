'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-destination-'));
const originalCwd = process.cwd();
let destination;
let enforceDestinationPolicy;

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
    ({ enforceDestinationPolicy } = require('../src/services/destinationPolicy'));
});

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('classifyAddress', () => {
    test('classifies loopback, link-local/unspecified and ordinary addresses', () => {
        const c = destination.classifyAddress;
        assert.equal(c('127.0.0.1'), 'loopback');
        assert.equal(c('::1'), 'loopback');
        assert.equal(c('::ffff:127.0.0.1'), 'loopback');
        assert.equal(c('169.254.169.254'), 'blocked');
        assert.equal(c('::ffff:169.254.169.254'), 'blocked');
        assert.equal(c('fe80::1'), 'blocked');
        assert.equal(c('0.0.0.0'), 'blocked');
        assert.equal(c('::'), 'blocked');
        assert.equal(c('100.100.100.200'), 'blocked');
        assert.equal(c('8.8.8.8'), 'other');
    });

    test('private LAN ranges are deliberately allowed', () => {
        for (const ip of ['10.1.2.3', '172.16.5.5', '192.168.1.20', 'fd12:3456::1']) {
            assert.equal(destination.classifyAddress(ip), 'other', ip);
        }
    });
});

describe('checkOutputDestination', () => {
    const check = (url) => destination.checkOutputDestination(url);

    test('refuses cloud-metadata and unspecified targets', async () => {
        assert.match(await check('rtmp://169.254.169.254/live/k'), /link-local/);
        assert.match(await check('rtmp://0.0.0.0:21935/live/k'), /link-local|unspecified/);
        assert.match(await check('srt://[fe80::1]:9000'), /link-local/);
    });

    test('refuses loopback spellings that only the OS resolver understands', async () => {
        for (const host of ['2130706433', '0x7f.1', '127.1', '[::ffff:127.0.0.1]']) {
            assert.match(await check(`rtmp://${host}:8080/live/k`), /loopback/, host);
        }
        // Decimal form of 169.254.169.254.
        assert.match(await check('rtmp://2852039166/live/k'), /link-local/);
    });

    test('userinfo cannot hide the real host', async () => {
        assert.match(await check('rtmp://example.com@127.0.0.1:8080/live/k'), /loopback/);
    });

    test('loopback is allowed only on the server’s own RTMP and SRT ports', async () => {
        assert.equal(await check('rtmp://127.0.0.1:21935/live/key01_x'), null);
        assert.equal(await check('rtmp://localhost:21935/live/key01_x'), null);
        assert.equal(await check('srt://127.0.0.1:10080?streamid=x'), null);
        assert.match(await check('rtmp://127.0.0.1:1985/live/k'), /own RTMP\/SRT ports/);
        assert.match(await check('rtmp://127.0.0.1/live/k'), /own RTMP\/SRT ports/);
        assert.match(await check('srt://localhost:8080'), /own RTMP\/SRT ports/);
    });

    test('private LAN and public destinations pass', async () => {
        assert.equal(await check('rtmp://192.168.1.50:1935/live/k'), null);
        assert.equal(await check('srt://10.0.0.7:9000?mode=caller'), null);
        assert.equal(await check('rtmps://8.8.8.8:443/live/k'), null);
    });

    test('an SRT listener output has no remote host to check and is left alone', async () => {
        assert.equal(await check('srt://0.0.0.0:9000?mode=listener'), null);
    });

    test('a name that does not resolve is not blocked (FFmpeg fails the same way)', async () => {
        assert.equal(await check('rtmp://does-not-exist.invalid/live/k'), null);
    });
});

describe('enforceDestinationPolicy', () => {
    test('stops and annotates only outputs whose destination is forbidden', async () => {
        const state = new Map();
        const outputs = [
            { id: 'a', name: 'ok', url: 'rtmp://8.8.8.8/live/k' },
            { id: 'b', name: 'meta', url: 'rtmp://169.254.169.254/live/k' },
            { id: 'c', name: 'local', url: 'rtmp://127.0.0.1:1985/live/k' },
        ];
        const stopped = [];
        const events = [];
        const db = {
            listOutputs: () => outputs,
            setOutputDesiredState: (id, value) => state.set(id, { ...state.get(id), value }),
            setOutputLastError: (id, message, kind) =>
                state.set(id, { ...state.get(id), message, kind }),
        };

        const count = await enforceDestinationPolicy(
            db,
            { stop: (id) => stopped.push(id) },
            { event: (name, fields) => events.push([name, fields.outputId]), close() {} },
        );

        assert.equal(count, 2);
        assert.deepEqual(stopped.sort(), ['b', 'c']);
        assert.equal(state.has('a'), false);
        assert.equal(state.get('b').value, 'stopped');
        assert.equal(state.get('b').kind, 'crash');
        assert.match(state.get('b').message, /^Output stopped: /);
        assert.deepEqual(
            events.map((e) => e[0]),
            ['output-destination-blocked', 'output-destination-blocked'],
        );
    });

    test('keeps shared-encode (rendition) outputs: own RTMP port on loopback passes at boot', async () => {
        const outputs = [
            { id: 'r', name: 'Shared encode', url: 'rtmp://127.0.0.1:21935/internal/r1_720p_a0' },
        ];
        const stopped = [];
        const db = {
            listOutputs: () => outputs,
            setOutputDesiredState: () => assert.fail('must not touch a rendition'),
            setOutputLastError: () => assert.fail('must not touch a rendition'),
        };

        const count = await enforceDestinationPolicy(db, { stop: (id) => stopped.push(id) });

        assert.equal(count, 0);
        assert.deepEqual(stopped, []);
    });
});

describe('isInternalAppDestination', () => {
    const is = (url) => destination.isInternalAppDestination(url);

    test('true for loopback hosts in any spelling with a path under /internal/', async () => {
        for (const url of [
            'rtmp://127.0.0.1:21935/internal/r1_720p_a0',
            'rtmp://localhost:21935/internal/x',
            'rtmp://127.1:21935/internal/x',
            'rtmp://2130706433:21935/internal/x',
            'rtmp://[::1]:21935/internal/x',
            'rtmp://u:p@127.0.0.1/internal/x',
            'rtmps://127.0.0.1/internal/x',
        ]) {
            assert.equal(await is(url), true, url);
        }
    });

    test('false for other apps, other hosts, and non-RTMP URLs', async () => {
        for (const url of [
            'rtmp://127.0.0.1:21935/live/k',
            'rtmp://127.0.0.1:21935/internalx/k',
            'rtmp://127.0.0.1:21935/internal',
            'rtmp://127.0.0.1:21935/?x=/internal/y',
            'rtmp://192.168.1.10:1935/internal/x',
            'rtmp://8.8.8.8/internal/x',
            'srt://127.0.0.1:10080?streamid=#!::r=internal/x,m=publish',
        ]) {
            assert.equal(await is(url), false, url);
        }
    });
});
