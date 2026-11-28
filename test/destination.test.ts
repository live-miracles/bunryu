import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '../src/types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-destination-'));
const originalCwd = process.cwd();
let destination: typeof import('../src/utils/destination');
let enforceDestinationPolicy: typeof import('../src/services/destinationPolicy').enforceDestinationPolicy;

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
    destination = require('../src/utils/destination') as typeof import('../src/utils/destination');
    ({ enforceDestinationPolicy } =
        require('../src/services/destinationPolicy') as typeof import('../src/services/destinationPolicy'));
});

// The fakes below implement only the Db methods enforceDestinationPolicy calls.
const asDb = (fake: object) => fake as unknown as Db;

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
    const check = (url: string) => destination.checkOutputDestination(url);
    // assert.match needs a string: an allowed destination (null) becomes '' and fails the match.
    const refusal = async (url: string) => (await check(url)) ?? '';

    test('refuses cloud-metadata and unspecified targets', async () => {
        assert.match(await refusal('rtmp://169.254.169.254/live/k'), /link-local/);
        assert.match(await refusal('rtmp://0.0.0.0:21935/live/k'), /link-local|unspecified/);
        assert.match(await refusal('srt://[fe80::1]:9000'), /link-local/);
    });

    test('refuses loopback spellings that only the OS resolver understands', async () => {
        for (const host of ['2130706433', '0x7f.1', '127.1', '[::ffff:127.0.0.1]']) {
            assert.match(await refusal(`rtmp://${host}:8080/live/k`), /loopback/, host);
        }
        // Decimal form of 169.254.169.254.
        assert.match(await refusal('rtmp://2852039166/live/k'), /link-local/);
    });

    test('userinfo cannot hide the real host', async () => {
        assert.match(await refusal('rtmp://example.com@127.0.0.1:8080/live/k'), /loopback/);
    });

    // FFmpeg starts the host after the LAST '@' of the authority.
    test('several @ in the authority cannot hide the real host either', async () => {
        assert.match(await refusal('rtmp://a@b@169.254.169.254/live/k'), /link-local/);
        assert.match(await refusal('rtmps://a:b@c@d@127.0.0.1:8080/live/k'), /loopback/);
        assert.match(await refusal('srt://a@b@169.254.169.254:80?mode=caller'), /link-local/);
        assert.match(await refusal('rtmp://a@b@[::1]:8080/live/k'), /loopback/);
        assert.equal(await check('rtmp://a@b@192.168.1.50:1935/live/k'), null);
    });

    test('loopback is allowed only on the server’s own RTMP and SRT ports', async () => {
        assert.equal(await check('rtmp://127.0.0.1:21935/live/key01_x'), null);
        assert.equal(await check('rtmp://localhost:21935/live/key01_x'), null);
        assert.equal(await check('srt://127.0.0.1:10080?streamid=x'), null);
        assert.match(await refusal('rtmp://127.0.0.1:1985/live/k'), /own RTMP\/SRT ports/);
        assert.match(await refusal('rtmp://127.0.0.1/live/k'), /own RTMP\/SRT ports/);
        assert.match(await refusal('srt://localhost:8080'), /own RTMP\/SRT ports/);
    });

    test('private LAN and public destinations pass', async () => {
        assert.equal(await check('rtmp://192.168.1.50:1935/live/k'), null);
        assert.equal(await check('srt://10.0.0.7:9000?mode=caller'), null);
        assert.equal(await check('rtmps://8.8.8.8:443/live/k'), null);
    });

    test('an SRT listener output has no remote host to check and is left alone', async () => {
        assert.equal(await check('srt://0.0.0.0:9000?mode=listener'), null);
        assert.equal(await check('srt://0.0.0.0:9000?latency=200&mode=listener'), null);
    });

    // FFmpeg takes the first "mode" option after the first '?', matched exactly, and only
    // for SRT: anything else connects out and must be checked.
    test('only a mode FFmpeg would read as listener skips the check', async () => {
        for (const url of [
            'srt://169.254.169.254:80?mode=caller&mode=listener',
            'srt://169.254.169.254:80?MODE=listener',
            'srt://169.254.169.254:80?streamid=x?mode=listener',
            'rtmp://169.254.169.254/live?mode=listener/k',
        ]) {
            assert.match(await refusal(url), /link-local/, url);
        }
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
        const stopped: string[] = [];
        const events: unknown[][] = [];
        const db = {
            listOutputs: () => outputs,
            setOutputDesiredState: (id: string, value: string) =>
                state.set(id, { ...state.get(id), value }),
            setOutputLastError: (id: string, message: string, kind: string) =>
                state.set(id, { ...state.get(id), message, kind }),
        };

        const count = await enforceDestinationPolicy(
            asDb(db),
            { stop: (id: string) => stopped.push(id) },
            {
                event: (name: string, fields?: Record<string, unknown>) =>
                    events.push([name, fields?.outputId]),
                close: async () => {},
            },
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

    test('stops outputs that loop back into their own pipeline, leaving a one-way restream running', async () => {
        const state = new Map();
        const outputs = [
            { id: 'self', pipelineId: 1, name: 'self', url: 'rtmp://127.0.0.1:21935/live/k1' },
            { id: 'ab', pipelineId: 1, name: 'A to B', url: 'rtmp://127.0.0.1:21935/live/k2' },
            { id: 'ba', pipelineId: 2, name: 'B to A', url: 'rtmp://127.0.0.1:21935/live/k1' },
            { id: 'cb', pipelineId: 3, name: 'C to B', url: 'rtmp://127.0.0.1:21935/live/k2' },
            { id: 'out', pipelineId: 3, name: 'out', url: 'rtmp://8.8.8.8/live/x' },
        ];
        const stopped: string[] = [];
        const db = {
            listOutputs: () => outputs,
            listPipelines: () => [
                { id: 1, name: 'A', streamKey: 'k1' },
                { id: 2, name: 'B', streamKey: 'k2' },
                { id: 3, name: 'C', streamKey: 'k3' },
            ],
            setOutputDesiredState: (id: string, value: string) =>
                state.set(id, { ...state.get(id), value }),
            setOutputLastError: (id: string, message: string, kind: string) =>
                state.set(id, { ...state.get(id), message, kind }),
        };

        const count = await enforceDestinationPolicy(asDb(db), {
            stop: (id: string) => stopped.push(id),
        });

        // A to B and B to A loop together, and A's own self output loops; C to B only feeds B.
        assert.deepEqual(stopped.sort(), ['ab', 'ba', 'self']);
        assert.equal(count, 3);
        assert.match(state.get('self').message, /^Output stopped: .*own input/);
        assert.match(state.get('ab').message, /restream loop/);
        assert.equal(state.has('cb'), false);
        assert.equal(state.has('out'), false);
    });

    test('keeps shared-encode (rendition) outputs: own RTMP port on loopback passes at boot', async () => {
        const outputs = [
            { id: 'r', name: 'Shared encode', url: 'rtmp://127.0.0.1:21935/internal/r1_720p_a0' },
        ];
        const stopped: string[] = [];
        const db = {
            listOutputs: () => outputs,
            setOutputDesiredState: () => assert.fail('must not touch a rendition'),
            setOutputLastError: () => assert.fail('must not touch a rendition'),
        };

        const count = await enforceDestinationPolicy(asDb(db), {
            stop: (id: string) => stopped.push(id),
        });

        assert.equal(count, 0);
        assert.deepEqual(stopped, []);
    });
});

describe('isInternalAppDestination', () => {
    const is = (url: string) => destination.isInternalAppDestination(url);

    test('true for loopback hosts in any spelling with a path under /internal/', async () => {
        for (const url of [
            'rtmp://127.0.0.1:21935/internal/r1_720p_a0',
            'rtmp://localhost:21935/internal/x',
            'rtmp://127.1:21935/internal/x',
            'rtmp://2130706433:21935/internal/x',
            'rtmp://[::1]:21935/internal/x',
            'rtmp://u:p@127.0.0.1/internal/x',
            'rtmp://a@b@127.0.0.1:21935/internal/x',
            'rtmps://127.0.0.1/internal/x',
            // FFmpeg keeps the query in the app and SRS drops it: the app is still internal.
            'rtmp://127.0.0.1:21935/internal?vhost=__defaultVhost__/x',
            'rtmp://127.0.0.1:21935/internal?/x',
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
