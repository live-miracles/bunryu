import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Baseline hardening for the dashboard port. A script CSP is not possible yet (the
// dashboard still uses inline event handlers); framing, sniffing, referrers, device
// features and cross-origin embedding are closed off.
//
// - `/api/*` answers carry stream keys, the SRT passphrase and logs, so no browser or
//   proxy may keep a copy (`no-store`).
// - HSTS is sent only when the request came over TLS, which the app never terminates
//   itself: directly, or through a proxy that says so. Without `includeSubDomains`, so
//   it never reaches other sites on the same parent domain.
export const securityHeaders: RequestHandler = (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The session cookie is SameSite=Strict, which keeps other sites out. This adds the
// browser's own word on top: a state-changing request that a browser says came from
// anywhere but this origin is refused. Requests with no Sec-Fetch-Site header (curl,
// scripts, older browsers) are not affected; the dashboard always calls its own origin.
export function rejectCrossSiteWrites(req: Request, res: Response, next: NextFunction): void {
    const site = req.headers['sec-fetch-site'];
    if (
        !SAFE_METHODS.has(req.method) &&
        site !== undefined &&
        site !== 'same-origin' &&
        site !== 'none'
    ) {
        res.status(403).json({ error: 'Cross-site request refused' });
        return;
    }
    next();
}
