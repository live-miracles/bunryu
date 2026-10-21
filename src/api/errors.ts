import type { ErrorRequestHandler } from 'express';

// Express's default handler answers with an HTML page, which the dashboard
// cannot parse and would report as a lost connection. Always answer in JSON;
// the detail stays in the log. A client error (e.g. malformed JSON body) keeps
// its own 4xx status.
export const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) {
        next(err);
        return;
    }
    const status =
        typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[api] unhandled request error:', err);
    res.status(status).json({
        error: status === 500 ? 'Internal server error' : 'Invalid request',
    });
};
