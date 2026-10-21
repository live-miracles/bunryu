'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { jsonErrorHandler } = require('../src/api/errors');

function makeRes(headersSent = false) {
    const res = {
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
    const quiet = (fn) => {
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
        quiet(() => jsonErrorHandler(new Error('secret /path'), {}, res, () => {}));
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Internal server error' });
    });

    test('keeps the status of a client error such as malformed JSON', () => {
        const res = makeRes();
        const err = Object.assign(new SyntaxError('bad json'), { status: 400 });
        quiet(() => jsonErrorHandler(err, {}, res, () => {}));
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { error: 'Invalid request' });
    });

    test('hands over to the default handler once the response has started', () => {
        const res = makeRes(true);
        const seen = [];
        const err = new Error('late');
        quiet(() => jsonErrorHandler(err, {}, res, (e) => seen.push(e)));
        assert.deepEqual(seen, [err]);
        assert.equal(res.body, undefined);
    });
});
