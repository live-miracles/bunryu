import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { NextFunction, Request, Response } from 'express';

import { jsonErrorHandler } from '../src/api/errors';

// The part of an Express response the error handler uses; the one cast to Response
// is in `asResponse`.
interface FakeRes {
    headersSent: boolean;
    statusCode: number;
    body: unknown;
    status(code: number): FakeRes;
    json(body: unknown): FakeRes;
}

const asResponse = (res: FakeRes) => res as unknown as Response;
const req = {} as Request;

function makeRes(headersSent = false): FakeRes {
    const res: FakeRes = {
        headersSent,
        statusCode: 200,
        body: undefined,
        status(code) {
            res.statusCode = code;
            return res;
        },
        json(body) {
            res.body = body;
            return res;
        },
    };
    return res;
}

describe('jsonErrorHandler', () => {
    const quiet = (fn: () => void) => {
        const original = console.error;
        console.error = () => {};
        try {
            fn();
        } finally {
            console.error = original;
        }
    };

    test('answers an unexpected error with a JSON 500 that hides the detail', () => {
        const res = makeRes();
        quiet(() => jsonErrorHandler(new Error('secret /path'), req, asResponse(res), () => {}));
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Internal server error' });
    });

    test('keeps the status of a client error such as malformed JSON', () => {
        const res = makeRes();
        const err = Object.assign(new SyntaxError('bad json'), { status: 400 });
        quiet(() => jsonErrorHandler(err, req, asResponse(res), () => {}));
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { error: 'Invalid request' });
    });

    test('hands over to the default handler once the response has started', () => {
        const res = makeRes(true);
        const seen: unknown[] = [];
        const err = new Error('late');
        quiet(() =>
            jsonErrorHandler(err, req, asResponse(res), ((e?: unknown) =>
                seen.push(e)) as NextFunction),
        );
        assert.deepEqual(seen, [err]);
        assert.equal(res.body, undefined);
    });
});
