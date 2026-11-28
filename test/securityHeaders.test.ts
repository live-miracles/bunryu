import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import fs from 'node:fs';
import path from 'node:path';
import { securityHeaders, rejectCrossSiteWrites } from '../src/api/securityHeaders';

let server: Server;
let base: string;

before(async () => {
    const app = express();
    app.use(securityHeaders);
    app.use(rejectCrossSiteWrites);
    app.all('/api/x', (_req, res) => res.json({ ok: true }));
    app.all('/page', (_req, res) => res.send('page'));
    await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('securityHeaders', () => {
    test('every response closes off framing, sniffing, referrers and device features', async () => {
        const res = await fetch(`${base}/page`);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-frame-options'), 'DENY');
        const csp = res.headers.get('content-security-policy') ?? '';
        for (const directive of [
            "script-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        ]) {
            assert.ok(csp.split('; ').includes(directive), directive);
        }
        assert.doesNotMatch(csp, /script-src[^;]*'unsafe-(inline|eval)'/);
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
        assert.match(res.headers.get('permissions-policy') ?? '', /microphone=\(\)/);
        assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    });

    test('API answers are never cached; pages are left to their own rules', async () => {
        assert.equal((await fetch(`${base}/api/x`)).headers.get('cache-control'), 'no-store');
        // Express routes case-insensitively, so /API/x reaches the same handler.
        assert.equal((await fetch(`${base}/API/x`)).headers.get('cache-control'), 'no-store');
        assert.equal((await fetch(`${base}/page`)).headers.get('cache-control'), null);
    });

    test('HSTS only when the request came over TLS', async () => {
        assert.equal((await fetch(`${base}/page`)).headers.get('strict-transport-security'), null);
        const viaProxy = await fetch(`${base}/page`, {
            headers: { 'X-Forwarded-Proto': 'https' },
        });
        assert.equal(viaProxy.headers.get('strict-transport-security'), 'max-age=31536000');
    });
});

describe('rejectCrossSiteWrites', () => {
    const post = (site: string | undefined) =>
        fetch(`${base}/api/x`, {
            method: 'POST',
            headers: site ? { 'Sec-Fetch-Site': site } : {},
        });

    test('refuses a write that the browser says came from another site', async () => {
        for (const site of ['cross-site', 'same-site']) {
            const res = await post(site);
            assert.equal(res.status, 403, site);
            assert.deepEqual(await res.json(), { error: 'Cross-site request refused' });
        }
    });

    test('allows same-origin and user-initiated writes and clients that send no header', async () => {
        for (const site of ['same-origin', 'none', undefined]) {
            assert.equal((await post(site)).status, 200, String(site));
        }
    });

    test('never blocks reads', async () => {
        const res = await fetch(`${base}/api/x`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
        assert.equal(res.status, 200);
    });
});

// The policy refuses inline script, so the pages and the markup the dashboard builds must
// have none: an inline handler or <script> body would just stop working in the browser.
describe('dashboard markup', () => {
    const publicDir = path.join(__dirname, '..', 'public');
    const files = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const p = path.join(dir, e.name);
            return e.isDirectory() ? files(p) : [p];
        });

    test('has no inline event handlers or inline script', () => {
        const sources = [
            ...fs
                .readdirSync(publicDir)
                .filter((f) => f.endsWith('.html'))
                .map((f) => path.join(publicDir, f)),
            ...files(path.join(publicDir, 'ts')),
        ];
        for (const file of sources) {
            const text = fs.readFileSync(file, 'utf8');
            assert.doesNotMatch(text, /\son[a-z]+\s*=\s*["'`$]/, file);
            assert.doesNotMatch(text, /<script(?![^>]*\ssrc=)[^>]*>/, file);
            assert.doesNotMatch(text, /javascript:\s*[a-z(]/i, file);
        }
    });
});
