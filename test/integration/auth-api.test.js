'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

class MockRequest extends Readable {
    constructor(method, url, body, ip = '127.0.0.1', cookie, extraHeaders = {}) {
        super();
        this.method = method;
        this.url = url;
        this.headers = { ...(cookie ? { cookie } : {}), ...extraHeaders };
        this.socket = { remoteAddress: ip };
        this.connection = this.socket;
        this.body = body;
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
                headers: this.headers,
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

function dispatch(app, method, route, body, ip, cookie, extraHeaders) {
    return new Promise((resolve, reject) => {
        app.handle(
            new MockRequest(method, route, body, ip, cookie, extraHeaders),
            new MockResponse(resolve),
            reject,
        );
    });
}

function makeDb() {
    const settings = new Map();
    const sessionRows = new Map();
    return {
        getSetting: (key) => settings.get(key) ?? null,
        setSetting: (key, value) => settings.set(key, value),
        createSession: (token) => sessionRows.set(token, Date.now()),
        deleteSession: (token) => sessionRows.delete(token),
        listSessions: () => [...sessionRows.keys()],
        pruneExpiredSessions: (maxAgeMs) => {
            const cutoff = Date.now() - maxAgeMs;
            for (const [token, createdAt] of sessionRows) {
                if (createdAt < cutoff) sessionRows.delete(token);
            }
        },
    };
}

// The auth module keeps sessions and the login rate limiter in module state,
// so each test loads a fresh copy.
async function createHarness(initialPassword = 'admin', existingDb) {
    delete require.cache[require.resolve('../../src/api/auth')];
    const { registerAuthApi, initializePassword } = require('../../src/api/auth');
    const app = express();
    const db = existingDb ?? makeDb();
    await initializePassword(db, initialPassword);
    registerAuthApi(app, db);
    return {
        db,
        login: (password, ip, headers) =>
            dispatch(app, 'POST', '/api/auth/login', { password }, ip, undefined, headers),
        logout: (cookie) => dispatch(app, 'POST', '/api/auth/logout', undefined, undefined, cookie),
        changePassword: (currentPassword, newPassword, cookie) =>
            dispatch(
                app,
                'POST',
                '/api/auth/change-password',
                { currentPassword, newPassword },
                undefined,
                cookie,
            ),
        request: (method, route, body, cookie) =>
            dispatch(app, method, route, body, undefined, cookie),
    };
}

// Extracts just "session=<token>" from a Set-Cookie response header so it can
// be replayed as a request's Cookie header.
function sessionCookieFrom(res) {
    return res.headers['set-cookie'].split(';')[0];
}

describe('auth login integration', () => {
    beforeEach(() => {
        delete require.cache[require.resolve('../../src/api/auth')];
    });

    test('accepts the correct password and sets a session cookie', async () => {
        const harness = await createHarness();

        const res = await harness.login('admin');

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { ok: true });
        assert.match(res.headers['set-cookie'], /^session=[0-9a-f]{64}; HttpOnly/);
    });

    test('loginLimiterKey groups IPv6 by /64 and unwraps IPv4-mapped addresses', () => {
        const { loginLimiterKey } = require('../../src/api/auth');
        assert.equal(loginLimiterKey('203.0.113.9'), '203.0.113.9');
        assert.equal(loginLimiterKey('::ffff:203.0.113.9'), '203.0.113.9');
        assert.equal(loginLimiterKey('2001:db8:1:2::5'), '2001:db8:1:2::/64');
        assert.equal(
            loginLimiterKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd'),
            '2001:db8:1:2::/64',
        );
        assert.equal(loginLimiterKey('::1'), '0:0:0:0::/64');
        assert.equal(loginLimiterKey('fe80::1%en0'), 'fe80:0:0:0::/64');
    });

    test('rejects a wrong password', async () => {
        const harness = await createHarness();

        const res = await harness.login('wrong');

        assert.equal(res.status, 401);
    });

    test('blocks an IP after repeated failures, others unaffected', async () => {
        const harness = await createHarness();

        for (let i = 0; i < 5; i++) {
            const res = await harness.login('wrong', '203.0.113.9');
            assert.equal(res.status, 401);
        }

        // Even the correct password is refused while the IP is blocked.
        const blocked = await harness.login('admin', '203.0.113.9');
        assert.equal(blocked.status, 429);
        assert.ok(Number(blocked.headers['retry-after']) > 0);

        // A different client IP is not affected.
        const other = await harness.login('admin', '198.51.100.7');
        assert.equal(other.status, 200);
    });

    test('a burst of parallel wrong passwords is cut off after the fifth', async () => {
        const harness = await createHarness();

        const burst = await Promise.all(
            Array.from({ length: 20 }, () => harness.login('wrong', '203.0.113.9')),
        );

        // Only the first five get as far as checking the password.
        assert.equal(burst.filter((res) => res.status === 401).length, 5);
        assert.equal(burst.filter((res) => res.status === 429).length, 15);
    });

    test('a successful login resets the failure counter', async () => {
        const harness = await createHarness();

        for (let i = 0; i < 4; i++) {
            await harness.login('wrong', '203.0.113.9');
        }
        const ok = await harness.login('admin', '203.0.113.9');
        assert.equal(ok.status, 200);

        // Counter was reset: the next failure is a plain 401, not a block.
        const res = await harness.login('wrong', '203.0.113.9');
        assert.equal(res.status, 401);
    });

    test('a non-string password does not crash the server and is rejected', async () => {
        const harness = await createHarness();

        for (const badPassword of [12345, { toString: () => 'admin' }, ['admin'], null]) {
            const res = await harness.request('POST', '/api/auth/login', { password: badPassword });
            assert.equal(res.status, 401);
        }
    });

    test('a missing password field is rejected, not treated as an empty-string match', async () => {
        const harness = await createHarness();
        const res = await harness.request('POST', '/api/auth/login', {});
        assert.equal(res.status, 401);
    });
});

describe('auth session integration', () => {
    beforeEach(() => {
        delete require.cache[require.resolve('../../src/api/auth')];
    });

    test('protected routes reject requests with no session cookie', async () => {
        const harness = await createHarness();

        const logoutRes = await harness.logout(undefined);
        assert.equal(logoutRes.status, 401);

        const changeRes = await harness.changePassword('admin', 'newpass123', undefined);
        assert.equal(changeRes.status, 401);
    });

    test('protected routes reject a garbage cookie header', async () => {
        const harness = await createHarness();
        const res = await harness.logout('not-a-real-cookie-format');
        assert.equal(res.status, 401);
    });

    test('protected routes reject a well-formed but unknown session token', async () => {
        const harness = await createHarness();
        const res = await harness.logout(
            'session=0000000000000000000000000000000000000000000000000000000000000000',
        );
        assert.equal(res.status, 401);
    });

    test('the session cookie is parsed correctly alongside unrelated cookies', async () => {
        const harness = await createHarness();
        const login = await harness.login('admin');
        const token = sessionCookieFrom(login);

        const res = await harness.logout(`theme=dark; ${token}; other=1`);
        assert.equal(res.status, 200);
    });

    test('logout invalidates the session so it cannot be reused', async () => {
        const harness = await createHarness();
        const login = await harness.login('admin');
        const cookie = sessionCookieFrom(login);

        const logoutRes = await harness.logout(cookie);
        assert.equal(logoutRes.status, 200);
        assert.match(logoutRes.headers['set-cookie'], /Max-Age=0/);

        // The same token must no longer authenticate anything.
        const replay = await harness.logout(cookie);
        assert.equal(replay.status, 401);
    });

    test('logging out an already-invalidated session is a harmless no-op, not a crash', async () => {
        const harness = await createHarness();
        const login = await harness.login('admin');
        const cookie = sessionCookieFrom(login);
        await harness.logout(cookie);

        const again = await harness.logout(cookie);
        assert.equal(again.status, 401);
    });

    test('change-password succeeds with the correct current password and rotates it', async () => {
        const harness = await createHarness();
        const login = await harness.login('admin');
        const cookie = sessionCookieFrom(login);

        const res = await harness.changePassword('admin', 'new-secure-pw', cookie);
        assert.equal(res.status, 200);

        // Old password no longer works; new one does.
        const oldLogin = await harness.login('admin');
        assert.equal(oldLogin.status, 401);
        const newLogin = await harness.login('new-secure-pw');
        assert.equal(newLogin.status, 200);
    });

    test('change-password rejects an incorrect current password and leaves it unchanged', async () => {
        const harness = await createHarness();
        const login = await harness.login('admin');
        const cookie = sessionCookieFrom(login);

        const res = await harness.changePassword('wrong-current', 'new-secure-pw', cookie);
        assert.equal(res.status, 403);

        const stillWorks = await harness.login('admin');
        assert.equal(stillWorks.status, 200);
    });

    test('change-password rejects an empty new password', async () => {
        const harness = await createHarness();
        const login = await harness.login('admin');
        const cookie = sessionCookieFrom(login);

        const res = await harness.changePassword('admin', '', cookie);
        assert.equal(res.status, 400);

        const stillWorks = await harness.login('admin');
        assert.equal(stillWorks.status, 200);
    });

    test('the session that changed the password stays valid', async () => {
        const harness = await createHarness();
        const login = await harness.login('admin');
        const cookie = sessionCookieFrom(login);
        await harness.changePassword('admin', 'new-secure-pw', cookie);

        const res = await harness.logout(cookie);
        assert.equal(res.status, 200);
    });

    test('changing the password revokes every other session', async () => {
        const harness = await createHarness();
        const mine = sessionCookieFrom(await harness.login('admin'));
        const stolen = sessionCookieFrom(await harness.login('admin'));
        assert.equal(
            (await harness.request('POST', '/api/auth/logout', undefined, stolen)).status,
            200,
        );
        const stolen2 = sessionCookieFrom(await harness.login('admin'));

        const res = await harness.changePassword('admin', 'new-secure-pw', mine);
        assert.equal(res.status, 200);

        const stolenUse = await harness.request('POST', '/api/auth/logout', undefined, stolen2);
        assert.equal(stolenUse.status, 401);
        const mineUse = await harness.request('POST', '/api/auth/logout', undefined, mine);
        assert.equal(mineUse.status, 200);
    });

    test('rejects a new password shorter than 12 characters and keeps the old one', async () => {
        const harness = await createHarness();
        const cookie = sessionCookieFrom(await harness.login('admin'));

        const res = await harness.changePassword('admin', 'short-pw', cookie);

        assert.equal(res.status, 400);
        assert.match(res.body.error, /at least 12/);
        assert.equal((await harness.login('admin')).status, 200);
    });

    test('session tokens are stored only as hashes, never the cookie value', async () => {
        const harness = await createHarness();
        const login = await harness.login('admin');
        const token = sessionCookieFrom(login).split('=')[1];

        const stored = harness.db.listSessions();

        assert.equal(stored.length, 1);
        assert.notEqual(stored[0], token);
        assert.match(stored[0], /^[0-9a-f]{64}$/);
    });

    test('marks the cookie Secure only when the request came over TLS', async () => {
        const harness = await createHarness();

        const plain = await harness.login('admin');
        const tls = await harness.login('admin', undefined, { 'x-forwarded-proto': 'https' });

        assert.doesNotMatch(plain.headers['set-cookie'], /Secure/);
        assert.match(tls.headers['set-cookie'], /; Secure/);
    });

    test('IPv6 clients are rate limited per /64, so rotating addresses does not help', async () => {
        const harness = await createHarness();
        for (let i = 1; i <= 5; i++) {
            await harness.login('wrong', `2001:db8:1:2::${i}`);
        }

        const sameNet = await harness.login('admin', '2001:db8:1:2:aaaa:bbbb:cccc:dddd');
        const otherNet = await harness.login('admin', '2001:db8:1:3::1');

        assert.equal(sameNet.status, 429);
        assert.equal(otherNet.status, 200);
    });

    test('two independent logins produce independent sessions; logging out one leaves the other valid', async () => {
        const harness = await createHarness();
        const loginA = await harness.login('admin');
        const loginB = await harness.login('admin');
        const cookieA = sessionCookieFrom(loginA);
        const cookieB = sessionCookieFrom(loginB);
        assert.notEqual(cookieA, cookieB);

        await harness.logout(cookieA);

        const bStillWorks = await harness.logout(cookieB);
        assert.equal(bStillWorks.status, 200);
    });
});

describe('initial dashboard password', () => {
    test('an empty database with no initial password refuses to start', async () => {
        delete require.cache[require.resolve('../../src/api/auth')];
        const { initializePassword, MissingInitialPasswordError } = require('../../src/api/auth');
        for (const none of ['', undefined]) {
            await assert.rejects(initializePassword(makeDb(), none), MissingInitialPasswordError);
        }
    });

    test('a database that already has a password starts without an initial one', async () => {
        const first = await createHarness('existing-db-pw');
        const reopened = await createHarness('', first.db);
        assert.equal((await reopened.login('existing-db-pw')).status, 200);
    });

    test('a configured initial password seeds an empty database', async () => {
        const harness = await createHarness('config-seeded-pw');
        assert.equal((await harness.login('config-seeded-pw')).status, 200);
        assert.equal((await harness.login('admin')).status, 401);
    });

    test('an existing password hash is never overwritten by the configured password', async () => {
        const first = await createHarness('first-config-pw');
        const login = await first.login('first-config-pw');
        const changed = await first.changePassword(
            'first-config-pw',
            'changed-in-dashboard',
            sessionCookieFrom(login),
        );
        assert.equal(changed.status, 200);

        // Simulated restart: same database, different config value.
        const second = await createHarness('other-config-pw', first.db);
        assert.equal((await second.login('changed-in-dashboard')).status, 200);
        assert.equal((await second.login('other-config-pw')).status, 401);
        assert.equal((await second.login('first-config-pw')).status, 401);
    });
});
