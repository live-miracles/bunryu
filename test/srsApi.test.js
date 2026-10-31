'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-srs-api-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
fs.writeFileSync(
    path.join(tempDir, 'bunryu.json'),
    JSON.stringify({
        port: 8080,
        database_path: './db.sqlite',
        srs_config_path: './srs.conf',
        ffmpeg_path: 'ffmpeg',
        ffprobe_path: 'ffprobe',
    }),
    'utf8',
);
fs.writeFileSync(
    path.join(tempDir, 'srs.conf'),
    'listen 1935;\nhttp_api {\n    listen 1985;\n}\n',
    'utf8',
);

const {
    fetchSrsStreams,
    fetchSrsClientsForHealth,
    fetchSrsSummaries,
    fetchSrsVersion,
    httpSrsApi,
} = require('../src/utils/srs');

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

// Answers every request with `respond(url)` and records what was asked.
function fakeFetch(t, respond) {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url: String(url), init });
        return respond(String(url));
    });
    return requests;
}

describe('streams', () => {
    test('asks for up to 1000, because SRS answers only 10 when no count is given', async (t) => {
        const requests = fakeFetch(t, () => reply({ code: 0, streams: [{ id: 's1' }] }));
        assert.deepEqual(await fetchSrsStreams(), [{ id: 's1' }]);
        assert.match(requests[0].url, /\/api\/v1\/streams\/\?start=0&count=1000$/);
        assert.equal(requests[0].init.headers.Connection, 'close');
        assert.ok(requests[0].init.signal instanceof AbortSignal);
    });

    test('is empty when SRS names no streams', async (t) => {
        fakeFetch(t, () => reply({ code: 0 }));
        assert.deepEqual(await fetchSrsStreams(), []);
    });

    test('fails when SRS answers with an error, saying which', async (t) => {
        fakeFetch(t, () => reply({}, false, 500));
        await assert.rejects(fetchSrsStreams(), /SRS API 500/);
    });

    test('fails when SRS does not answer', async (t) => {
        fakeFetch(t, () => {
            throw new Error('ECONNREFUSED');
        });
        await assert.rejects(fetchSrsStreams(), /ECONNREFUSED/);
    });
});

describe('clients', () => {
    test('asks for up to 1000 and gives the list', async (t) => {
        const requests = fakeFetch(t, () => reply({ code: 0, clients: [{ id: 'c1' }] }));
        assert.deepEqual(await fetchSrsClientsForHealth(), [{ id: 'c1' }]);
        assert.match(requests[0].url, /\/api\/v1\/clients\?start=0&count=1000$/);
        assert.equal(requests[0].init.headers.Connection, 'close');
    });

    test('is empty when SRS names no clients, and fails on an error status', async (t) => {
        fakeFetch(t, () => reply({ code: 0 }));
        assert.deepEqual(await fetchSrsClientsForHealth(), []);
        fakeFetch(t, () => reply({}, false, 503));
        await assert.rejects(fetchSrsClientsForHealth(), /SRS clients API 503/);
    });
});

describe('summaries', () => {
    test('gives SRS’s answer as it is', async (t) => {
        const body = { data: { self: { cpu_percent: 0.05, mem_kbyte: 100 } } };
        const requests = fakeFetch(t, () => reply(body));
        assert.deepEqual(await fetchSrsSummaries(), body);
        assert.match(requests[0].url, /\/api\/v1\/summaries$/);
        assert.equal(requests[0].init.headers.Connection, 'close');
        assert.ok(requests[0].init.signal instanceof AbortSignal);
    });

    test('fails on an error status or no answer', async (t) => {
        fakeFetch(t, () => reply({}, false, 500));
        await assert.rejects(fetchSrsSummaries(), /SRS summaries HTTP 500/);
        fakeFetch(t, () => {
            throw new Error('timeout');
        });
        await assert.rejects(fetchSrsSummaries(), /timeout/);
    });
});

describe('version', () => {
    test('is the version SRS reports', async (t) => {
        const requests = fakeFetch(t, () => reply({ data: { version: '6.0.184' } }));
        assert.equal(await fetchSrsVersion(), '6.0.184');
        assert.match(requests[0].url, /\/api\/v1\/versions$/);
    });

    test('is null when SRS does not answer, is not JSON, or does not say', async (t) => {
        fakeFetch(t, () => {
            throw new Error('down');
        });
        assert.equal(await fetchSrsVersion(), null);
        fakeFetch(t, () => ({ ok: true, status: 200, json: async () => JSON.parse('nope') }));
        assert.equal(await fetchSrsVersion(), null);
        fakeFetch(t, () => reply({ data: {} }));
        assert.equal(await fetchSrsVersion(), null);
        fakeFetch(t, () => reply(null));
        assert.equal(await fetchSrsVersion(), null);
    });
});

describe('the default SrsApi', () => {
    test('asks SRS over HTTP for its streams and its clients', async (t) => {
        const requests = fakeFetch(t, (url) =>
            url.includes('/streams/')
                ? reply({ streams: [{ id: 's' }] })
                : reply({ clients: [{ id: 'c' }] }),
        );
        assert.deepEqual(await httpSrsApi.streams(), [{ id: 's' }]);
        assert.deepEqual(await httpSrsApi.clients(), [{ id: 'c' }]);
        assert.equal(requests.length, 2);
    });
});
