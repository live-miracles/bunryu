import type { Express, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import type { Db } from '../types.js';

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_PASSWORD_LENGTH = 12;
const SESSION_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

// Failed-login rate limit, per client IP. /api/auth/login is unauthenticated
// and internet-exposed, and each verify costs a scrypt — without a limit a
// password-guessing flood both brute-forces the single dashboard password and
// burns CPU. Successful logins reset the counter.
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 5 * 60 * 1000;
const LOGIN_TRACKER_MAX_ENTRIES = 10_000;

interface LoginFailureState {
    count: number;
    windowStartMs: number;
    blockedUntilMs: number;
}

const loginFailures = new Map<string, LoginFailureState>();

const sessions = new Set<string>();

// scrypt runs on the libuv threadpool instead of the event loop. The sync
// variant would block the whole control plane (health poll, output retries,
// SRS hooks) for tens of ms per call — and login is unauthenticated, so that
// blocking would be attacker-triggerable.
function scryptAsync(password: string, salt: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 32, (err, derivedKey) => {
            if (err) reject(err);
            else resolve(derivedKey);
        });
    });
}

async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt)).toString('hex');
    return `${salt}:${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split(':');
    if (parts.length !== 2) return false;
    const [salt, hash] = parts;
    try {
        const newHash = (await scryptAsync(password, salt)).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(newHash, 'hex'));
    } catch {
        return false;
    }
}

function clientIp(req: Request): string {
    return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

// Session tokens are stored (memory and SQLite) only as SHA-256 hashes, so a
// copy of the database cannot be replayed as a live session cookie.
function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// The rate-limit key. An IPv6 attacker usually controls a whole /64, so keying
// on the full address would let them rotate for free; group by /64 instead.
// IPv4-mapped IPv6 addresses count as the IPv4 address they carry.
export function loginLimiterKey(ip: string): string {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return mapped[1];
    if (!ip.includes(':')) return ip;
    const [head, tail = ''] = ip.split('%')[0].toLowerCase().split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = ip.includes('::') && tail ? tail.split(':') : [];
    const groups = ip.includes('::')
        ? [
              ...headGroups,
              ...Array(8 - headGroups.length - tailGroups.length).fill('0'),
              ...tailGroups,
          ]
        : headGroups;
    return `${groups
        .slice(0, 4)
        .map((g) => g.replace(/^0+(?=.)/, ''))
        .join(':')}::/64`;
}

// Returns how many seconds the caller must still wait, or 0 if allowed.
function loginBlockedForSeconds(ip: string): number {
    const state = loginFailures.get(ip);
    if (!state) return 0;
    const remainingMs = state.blockedUntilMs - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

function noteLoginFailure(ip: string): void {
    // Opportunistic cleanup so the tracker cannot grow without bound under a
    // spoofed-source flood.
    if (loginFailures.size >= LOGIN_TRACKER_MAX_ENTRIES) {
        const now = Date.now();
        for (const [key, state] of loginFailures) {
            if (now - state.windowStartMs > LOGIN_WINDOW_MS && state.blockedUntilMs <= now) {
                loginFailures.delete(key);
            }
        }
    }

    const now = Date.now();
    const state = loginFailures.get(ip);
    if (!state || now - state.windowStartMs > LOGIN_WINDOW_MS) {
        loginFailures.set(ip, { count: 1, windowStartMs: now, blockedUntilMs: 0 });
        return;
    }
    state.count++;
    if (state.count >= LOGIN_MAX_FAILURES) {
        state.blockedUntilMs = now + LOGIN_BLOCK_MS;
    }
}

function getSessionToken(req: Request): string | null {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k.trim() === 'session') return v.join('=');
    }
    return null;
}

export function checkIsAuthenticated(req: Request): boolean {
    const token = getSessionToken(req);
    return token !== null && sessions.has(hashToken(token));
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (checkIsAuthenticated(req)) {
        next();
        return;
    }
    res.status(401).json({ error: 'Unauthorized' });
}

function pruneSessions(db: Db): void {
    db.pruneExpiredSessions(SESSION_MAX_AGE_MS);
    const alive = new Set(db.listSessions());
    for (const token of sessions) {
        if (!alive.has(token)) sessions.delete(token);
    }
}

// initialPassword (bunryu.json's dashboard_password) only seeds a database
// that has no password hash yet; an existing hash is never overwritten.
export async function initializePassword(db: Db, initialPassword = 'admin'): Promise<void> {
    if (!db.getSetting('dashboardPasswordHash')) {
        db.setSetting('dashboardPasswordHash', await hashPassword(initialPassword));
    }
    pruneSessions(db);
    for (const token of db.listSessions()) {
        sessions.add(token);
    }
    // The 30-day session expiry was previously only enforced at boot, so on a
    // long-running server old session tokens stayed valid indefinitely.
    setInterval(() => pruneSessions(db), SESSION_PRUNE_INTERVAL_MS).unref();
}

export function registerAuthApi(app: Express, db: Db): void {
    // Secure is added when the request arrived over TLS (directly, or via a proxy
    // that says so); the app itself never terminates TLS, and a plain-HTTP dev
    // setup must keep working.
    const sessionCookie = (req: Request, token: string, extra = ''): string => {
        const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        return `session=${token}; HttpOnly; Path=/; SameSite=Strict${secure ? '; Secure' : ''}${extra}`;
    };

    app.post('/api/auth/login', async (req, res) => {
        const ip = clientIp(req);
        const limiterKey = loginLimiterKey(ip);
        const retryAfterSec = loginBlockedForSeconds(limiterKey);
        if (retryAfterSec > 0) {
            res.setHeader('Retry-After', String(retryAfterSec));
            return res
                .status(429)
                .json({ error: `Too many failed logins. Try again in ${retryAfterSec}s.` });
        }

        const password = (req.body?.password as string | undefined) ?? '';
        const hash = db.getSetting('dashboardPasswordHash');
        if (!hash || !(await verifyPassword(password, hash))) {
            // IP first, before anything attacker-influenced, so auth failures
            // stay easy to scan in logs.
            console.warn(`[auth] client_ip=${ip} rejected login: incorrect password`);
            noteLoginFailure(limiterKey);
            return res.status(401).json({ error: 'Incorrect password' });
        }
        loginFailures.delete(limiterKey);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.add(hashToken(token));
        db.createSession(hashToken(token));
        console.log(`[auth] client_ip=${ip} login ok`);
        res.setHeader('Set-Cookie', sessionCookie(req, token));
        return res.json({ ok: true });
    });

    app.post('/api/auth/logout', requireAuth, (req, res) => {
        const token = getSessionToken(req);
        if (token) {
            sessions.delete(hashToken(token));
            db.deleteSession(hashToken(token));
            console.log(`[auth] client_ip=${clientIp(req)} logout`);
        }
        res.setHeader('Set-Cookie', sessionCookie(req, '', '; Max-Age=0'));
        return res.json({ ok: true });
    });

    app.post('/api/auth/change-password', requireAuth, async (req, res) => {
        const currentPassword = (req.body?.currentPassword as string | undefined) ?? '';
        const newPassword = (req.body?.newPassword as string | undefined) ?? '';
        if (!newPassword) {
            return res.status(400).json({ error: 'New password cannot be empty' });
        }
        if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
            return res
                .status(400)
                .json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }
        const hash = db.getSetting('dashboardPasswordHash');
        if (!hash || !(await verifyPassword(currentPassword, hash))) {
            return res.status(403).json({ error: 'Current password is incorrect' });
        }
        db.setSetting('dashboardPasswordHash', await hashPassword(newPassword));
        // A password change is the usual response to a suspected compromise, so
        // every other session (including a stolen one) must stop working. The
        // session that made the change stays.
        const keep = hashToken(getSessionToken(req) ?? '');
        let revoked = 0;
        for (const hashed of db.listSessions()) {
            if (hashed === keep) continue;
            sessions.delete(hashed);
            db.deleteSession(hashed);
            revoked++;
        }
        console.log(
            `[auth] client_ip=${clientIp(req)} password changed, ${revoked} other session(s) revoked`,
        );
        return res.json({ ok: true });
    });
}
