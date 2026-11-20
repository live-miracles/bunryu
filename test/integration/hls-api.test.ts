import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from '../../src/types';
import type { PreviewService } from '../../src/services/preview';

// Only the settings and sessions the auth routes use.
function makeDb(): Db {
    const settings = new Map<string, string>();
    const sessions = new Map<string, number>();
    return {
        getSetting: (k: string) => settings.get(k) ?? null,
        setSetting: (k: string, v: string) => {
            settings.set(k, v);
        },
        createSession: (t: string) => {
            sessions.set(t, Date.now());
        },
        deleteSession: (t: string) => sessions.delete(t),
        listSessions: () => [...sessions.keys()],
        pruneExpiredSessions: () => {},
    } as unknown as Db;
}

describe('HLS preview route', () => {
    let server: Server;
    let base: string;
    let dir: string;
    const touched: number[] = [];

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-hls-'));
        const { registerAuthApi, initializePassword } =
            require('../../src/api/auth') as typeof import('../../src/api/auth');
        const { registerHlsRoute } =
            require('../../src/api/preview') as typeof import('../../src/api/preview');
        const db = makeDb();
        await initializePassword(db, 'pw-for-test');
        const app = express();
        app.use(express.json());
        registerAuthApi(app, db);
        // Only the base directory and the viewer count are read by the route.
        const previewService = {
            baseDir: path.join(dir, 'hls-root'),
            keepalive: (id: number) => {
                touched.push(id);
                return true;
            },
        } as unknown as PreviewService;
        registerHlsRoute(app, previewService);
        fs.mkdirSync(path.join(dir, 'hls-root', '7'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'hls-root', '7', 'index.m3u8'), '#EXTM3U\nlive\n');
        fs.writeFileSync(path.join(dir, 'db.sqlite'), 'not for the web');
        await new Promise<void>((resolve) => {
            server = app.listen(0, '127.0.0.1', () => resolve());
        });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
        return res.headers.get('set-cookie')!.split(';')[0]!;
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
        assert.match(res.headers.get('cache-control')!, /no-store/);
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
