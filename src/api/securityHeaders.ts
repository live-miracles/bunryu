import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Baseline hardening for the dashboard port: framing, sniffing, referrers, device features
// and cross-origin embedding are closed off, and the Content-Security-Policy runs only the
// dashboard's own script files (the pages have no inline script or event handlers).
//
// - `/api/*` answers carry stream keys, the SRT passphrase and logs, so no browser or
//   proxy may keep a copy (`no-store`). Matched without case, as Express routes.
// - HSTS is sent only when the request came over TLS, which the app never terminates
//   itself: directly, or through a proxy that says so. Without `includeSubDomains`, so
//   it never reaches other sites on the same parent domain.
//
// The Content-Security-Policy:
// - Scripts, styles, API calls and HLS playlists come only from this origin.
// - Style attributes stay allowed (`style-src-attr`): the markup sets a few, and a style
//   cannot run script. Stylesheets themselves are this origin's only.
// - `data:` images: the select arrow in the stylesheet is an inline SVG.
// - `blob:` media and workers: hls.js plays through a MediaSource object URL and runs its
//   transmuxer in a worker made from a blob.
export const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    'worker-src blob:',
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');

export const securityHeaders: RequestHandler = (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    if (req.path.toLowerCase().startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
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
