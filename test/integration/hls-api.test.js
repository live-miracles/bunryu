'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeDb() {
    const settings = new Map();
    const sessions = new Map();
    return {
        getSetting: (k) => settings.get(k) ?? null,
        setSetting: (k, v) => settings.set(k, v),
        createSession: (t) => sessions.set(t, Date.now()),
        deleteSession: (t) => sessions.delete(t),
        listSessions: () => [...sessions.keys()],
        pruneExpiredSessions: () => {},
    };
}

describe('HLS preview route', () => {
    let server;
    let base;
    let dir;
    const touched = [];

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-hls-'));
        const { registerAuthApi, initializePassword } = require('../../src/api/auth');
        const { registerHlsRoute } = require('../../src/api/preview');
        const db = makeDb();
        await initializePassword(db, 'pw-for-test');
        const app = express();
        app.use(express.json());
        registerAuthApi(app, db);
        registerHlsRoute(app, {
            baseDir: path.join(dir, 'hls-root'),
            keepalive: (id) => touched.push(id),
        });
        fs.mkdirSync(path.join(dir, 'hls-root', '7'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'hls-root', '7', 'index.m3u8'), '#EXTM3U\nlive\n');
        fs.writeFileSync(path.join(dir, 'db.sqlite'), 'not for the web');
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    async function login() {
        const res = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: 'pw-for-test' }),
        });
        return res.headers.get('set-cookie').split(';')[0];
    }

    test('rejects an unauthenticated playlist fetch and does not count it as a viewer', async () => {
        const before = touched.length;

        const res = await fetch(`${base}/hls/7/index.m3u8`);

        assert.equal(res.status, 401);
        assert.equal(touched.length, before);
    });

    test('serves the playlist to a logged-in session and counts it as a viewer', async () => {
        const cookie = await login();

        const res = await fetch(`${base}/hls/7/index.m3u8`, { headers: { cookie } });

        assert.equal(res.status, 200);
        assert.match(await res.text(), /#EXTM3U/);
        assert.match(res.headers.get('cache-control'), /no-store/);
        assert.ok(touched.includes(7));
    });

    test('does not serve files outside the preview directory', async () => {
        const cookie = await login();
        for (const p of [
            '/hls/..%2fdb.sqlite',
            '/hls/%2e%2e/db.sqlite',
            '/hls/7/..%2f..%2fdb.sqlite',
        ]) {
            const res = await fetch(`${base}${p}`, { headers: { cookie } });
            assert.notEqual(res.status, 200, p);
        }
    });
});
