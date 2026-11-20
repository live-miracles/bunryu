import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '../../src/types';
import type { InputState } from '../../src/services/inputState';
import type { OutputService } from '../../src/services/outputs';
import type { DiagnosticsLogger } from '../../src/utils/diagnostics';
import type { KeyVaultStatus } from '../../src/utils/keyVaultStatus';
import { dispatch } from '../helpers/http';

// The reset route rewrites srs.conf and goryu.json, so point the app config at a
// temporary copy before any module reads it (never the repository's own files).
const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-settings-api-'));
const SRS_CONF_PATH = path.join(confDir, 'srs.conf');
const RELAY_CONF_PATH = path.join(confDir, 'goryu.json');
const SRS_CONF = 'srt_server {\n    listen 10080;\n    passphrase      old-passphrase-value;\n}\n';
const RELAY_CONF = JSON.stringify({ passphrase: 'old-passphrase-value' }, null, 4) + '\n';
fs.writeFileSync(
    path.join(confDir, 'bunryu.json'),
    JSON.stringify({
        port: 8080,
        database_path: path.join(confDir, 'db.sqlite'),
        srs_config_path: SRS_CONF_PATH,
        ffmpeg_path: 'ffmpeg',
        ffprobe_path: 'ffprobe',
    }),
);
process.env.BUNRYU_CONFIG = path.join(confDir, 'bunryu.json');

const { createDb } = require('../../src/db/index') as typeof import('../../src/db/index');
const { registerSettingsApi } =
    require('../../src/api/settings') as typeof import('../../src/api/settings');
const { deriveKeyVaultSecrets } =
    require('../../src/utils/keyVaultConfig') as typeof import('../../src/utils/keyVaultConfig');

after(() => fs.rmSync(confDir, { recursive: true, force: true }));

// The settings routes use one method of the input state and one of the output service, so
// the fakes carry only those; these factories hold the cast to the real interfaces.
const fakeInputState = (liveInputs: Set<number>) =>
    ({ isLive: (id: number) => liveInputs.has(id) }) as unknown as InputState;
const fakeOutputService = (outputStatus: Map<string, string>) =>
    ({
        getStats: (id: string) => ({ status: outputStatus.get(id) ?? 'stopped' }),
    }) as unknown as OutputService;

// A stored JSON setting, which the tests that read one have just saved.
const storedJson = (db: Db, key: string): unknown => JSON.parse(db.getSetting(key) as string);

function createHarness() {
    const app = express();

    const db = createDb(':memory:');
    const liveInputs = new Set<number>();
    const outputStatus = new Map<string, string>();
    const events: Record<string, unknown>[] = [];
    const keyVault = {
        reconfigured: 0,
        reconfigure() {
            this.reconfigured += 1;
        },
        // What the reporter says about its connection; a test sets it.
        current: null as KeyVaultStatus | null,
        status() {
            return this.current;
        },
    };
    const diagnostics: DiagnosticsLogger = {
        event: (type, fields) => {
            events.push({ type, ...fields });
        },
        close: async () => {},
    };
    registerSettingsApi(
        app,
        db,
        fakeInputState(liveInputs),
        fakeOutputService(outputStatus),
        diagnostics,
        keyVault,
    );
    fs.writeFileSync(SRS_CONF_PATH, SRS_CONF);
    fs.writeFileSync(RELAY_CONF_PATH, RELAY_CONF);

    return {
        db,
        liveInputs,
        outputStatus,
        events,
        keyVault,
        request: (method: string, route: string, body?: unknown) =>
            dispatch(app, method, route, body),
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
            harness.db.replacePipelineGroups([{ name: 'Main' }]);

            const res = await harness.request('POST', '/api/settings/general', {
                name: 'New Name',
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.serverName, 'New Name');
            assert.equal(harness.db.getSetting('serverName'), 'New Name');
            assert.equal(harness.db.getSetting('srtPassphrase'), 'secret-value');
            assert.equal(harness.db.listPipelineGroups().length, 1);
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

    describe('POST /api/settings/pipeline-groups', () => {
        test('saves groups in array order', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/pipeline-groups', {
                groups: [{ name: 'Main' }, { name: 'Backup' }],
            });

            assert.equal(res.status, 200);
            assert.deepEqual(
                res.body.groups.map((g: { name: string; position: number }) => [
                    g.name,
                    g.position,
                ]),
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
            assert.equal(harness.db.getPipeline(pipeline.id)?.groupId, null);
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
            assert.deepEqual(storedJson(harness.db, 'layoutOrder'), order);
        });

        test('rejects invalid layout order', async () => {
            const harness = createHarness();
            harness.db.setSetting('layoutOrder', JSON.stringify([{ id: 1, outs: ['1-1'] }]));

            const res = await harness.request('POST', '/api/settings/layout-order', {
                order: [{ id: '1', outs: ['1-1'] }],
            });

            assert.equal(res.status, 400);
            assert.deepEqual(storedJson(harness.db, 'layoutOrder'), [{ id: 1, outs: ['1-1'] }]);
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
            assert.deepEqual(storedJson(harness.db, 'layoutOrder'), []);
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

    describe('POST /api/settings/reset-srt-passphrase', () => {
        const unchanged = () => {
            assert.equal(fs.readFileSync(SRS_CONF_PATH, 'utf8'), SRS_CONF);
            assert.equal(fs.readFileSync(RELAY_CONF_PATH, 'utf8'), RELAY_CONF);
        };

        test('writes the same new passphrase to srs.conf and goryu.json', async () => {
            const harness = createHarness();
            const res = await harness.request('POST', '/api/settings/reset-srt-passphrase');

            assert.equal(res.status, 200);
            // The new value never leaves the server in the response; it is in the files.
            assert.deepEqual(res.body, { ok: true });
            const srtPassphrase = JSON.parse(fs.readFileSync(RELAY_CONF_PATH, 'utf8')).passphrase;
            assert.match(srtPassphrase, /^[A-Za-z0-9]{32}$/);
            assert.ok(
                fs
                    .readFileSync(SRS_CONF_PATH, 'utf8')
                    .includes(`passphrase      ${srtPassphrase};`),
            );
            assert.equal(
                JSON.parse(fs.readFileSync(RELAY_CONF_PATH, 'utf8')).passphrase,
                srtPassphrase,
            );
            assert.deepEqual(harness.events, [
                { type: 'srt-passphrase-reset', pendingRestart: true },
            ]);
            assert.ok(!JSON.stringify(harness.events).includes(srtPassphrase));
        });

        test('is refused while an input is live', async () => {
            const harness = createHarness();
            const pipeline = harness.db.createPipeline();
            harness.liveInputs.add(pipeline.id);

            const res = await harness.request('POST', '/api/settings/reset-srt-passphrase');

            assert.equal(res.status, 409);
            assert.match(res.body.error, /1 live input/);
            unchanged();
        });

        test('is refused while an output is running or retrying, but not when all are stopped', async () => {
            const harness = createHarness();
            const pipeline = harness.db.createPipeline();
            const output = harness.db.createOutput({
                pipelineId: pipeline.id,
                name: 'A',
                url: 'rtmp://a',
            });
            for (const status of ['running', 'failed']) {
                harness.outputStatus.set(output.id, status);
                const res = await harness.request('POST', '/api/settings/reset-srt-passphrase');
                assert.equal(res.status, 409, status);
                assert.match(res.body.error, /1 active output/);
                unchanged();
            }

            harness.outputStatus.set(output.id, 'stopped');
            const res = await harness.request('POST', '/api/settings/reset-srt-passphrase');
            assert.equal(res.status, 200);
        });

        test('reports a config it cannot edit as 500 and changes nothing', async () => {
            const harness = createHarness();
            fs.writeFileSync(SRS_CONF_PATH, 'srt_server {\n    listen 10080;\n}\n');

            const res = await harness.request('POST', '/api/settings/reset-srt-passphrase');

            assert.equal(res.status, 500);
            assert.match(res.body.error, /no "passphrase" directive/);
            assert.equal(fs.readFileSync(RELAY_CONF_PATH, 'utf8'), RELAY_CONF);
            assert.equal(harness.events[0].type, 'srt-passphrase-reset-failed');
        });
    });
});

describe('Key Vault settings API', () => {
    const LINK = {
        url: 'https://203.0.113.5/functions/v1/ingest',
        secret: 'fake-key-vault-secret-0123456789-abcdef',
    };
    const DERIVED = deriveKeyVaultSecrets(LINK.secret);

    test('saves the link, applies it at once and never returns the secret or what is derived from it', async () => {
        const harness = createHarness();
        const res = await harness.request('POST', '/api/settings/key-vault', LINK);

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            keyVault: { url: LINK.url, secretSet: true },
        });
        for (const value of [LINK.secret, DERIVED.token, DERIVED.hashSecret]) {
            assert.ok(!res.text.includes(value));
        }
        // Only the derived values are stored, never the secret itself.
        const stored = harness.db.getSetting('keyVault') as string;
        assert.deepEqual(JSON.parse(stored), { url: LINK.url, ...DERIVED });
        assert.ok(!stored.includes(LINK.secret));
        assert.equal(harness.keyVault.reconfigured, 1);
    });

    test('an empty secret keeps the saved one; a new one replaces it', async () => {
        const harness = createHarness();
        await harness.request('POST', '/api/settings/key-vault', LINK);

        const kept = await harness.request('POST', '/api/settings/key-vault', {
            url: 'https://203.0.113.6/ingest',
            secret: '',
        });
        assert.equal(kept.status, 200);
        assert.deepEqual(storedJson(harness.db, 'keyVault'), {
            url: 'https://203.0.113.6/ingest',
            ...DERIVED,
        });

        const replacement = 'replacement-secret-0123456789-abcdefg';
        await harness.request('POST', '/api/settings/key-vault', {
            ...LINK,
            secret: ` ${replacement} `,
        });
        assert.deepEqual(storedJson(harness.db, 'keyVault'), {
            url: LINK.url,
            ...deriveKeyVaultSecrets(replacement),
        });
    });

    test('refuses a wrong value with 400 and saves and applies nothing', async () => {
        const harness = createHarness();
        await harness.request('POST', '/api/settings/key-vault', LINK);
        const before = harness.db.getSetting('keyVault');
        const applied = harness.keyVault.reconfigured;

        const refusals: [unknown, RegExp][] = [
            [{ ...LINK, url: 'ftp://203.0.113.5/x' }, /https/],
            [{ ...LINK, url: 'http://203.0.113.5/x' }, /https/],
            [{ ...LINK, url: 'not a url' }, /valid URL/],
            [{ ...LINK, url: 'https://user:pw@203.0.113.5/x' }, /credentials/],
            [{ ...LINK, url: 'https://169.254.169.254/latest' }, /not allowed/],
            [{ ...LINK, secret: 'has a space' }, /printable ASCII/],
            [{ ...LINK, secret: 'short' }, /at least 32/],
            [{ ...LINK, secret: 12345 }, /string/],
        ];
        for (const [body, message] of refusals) {
            const res = await harness.request('POST', '/api/settings/key-vault', body);
            assert.equal(res.status, 400, JSON.stringify(body));
            assert.match(res.body.error, message);
        }
        assert.equal(harness.db.getSetting('keyVault'), before);
        assert.equal(harness.keyVault.reconfigured, applied);
    });

    test('the first save needs a secret', async () => {
        const harness = createHarness();
        const res = await harness.request('POST', '/api/settings/key-vault', {
            ...LINK,
            secret: '',
        });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /secret is required/);
        assert.equal(harness.db.getSetting('keyVault'), null);
    });

    test('http is accepted for localhost, a receiver on this machine', async () => {
        const harness = createHarness();
        const res = await harness.request('POST', '/api/settings/key-vault', {
            ...LINK,
            url: 'http://127.0.0.1:9999/ingest',
        });
        assert.equal(res.status, 200);
    });

    test('shows whether the reports get through, with the server clock, and null while off', async () => {
        const harness = createHarness();
        let res = await harness.request('GET', '/api/settings/key-vault/status');
        assert.equal(res.status, 200);
        assert.equal(res.body.status, null);
        assert.ok(Math.abs(res.body.nowMs - Date.now()) < 2000);

        harness.keyVault.current = {
            state: 'failing',
            lastReportAtMs: 1000,
            problem: 'Key Vault refused the secret (HTTP 401).',
            failingSinceMs: 2000,
            skipped: null,
        };
        res = await harness.request('GET', '/api/settings/key-vault/status');
        assert.deepEqual(res.body.status, harness.keyVault.current);
    });

    test('an empty link turns the reports off and forgets the secret', async () => {
        const harness = createHarness();
        await harness.request('POST', '/api/settings/key-vault', LINK);
        const res = await harness.request('POST', '/api/settings/key-vault', { url: '' });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { keyVault: null });
        assert.equal(harness.db.getSetting('keyVault'), '');
        assert.equal(harness.keyVault.reconfigured, 2);
    });
});
