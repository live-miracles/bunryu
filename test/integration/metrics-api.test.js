'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

class MockRequest extends Readable {
    constructor(method, url) {
        super();
        this.method = method;
        this.url = url;
        this.headers = {};
        this.socket = { remoteAddress: '127.0.0.1' };
        this.connection = this.socket;
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

function dispatch(app, method, route) {
    return new Promise((resolve, reject) => {
        app.handle(new MockRequest(method, route), new MockResponse(resolve), reject);
    });
}

// A resource usage module that answers from fixed values and records what it was asked.
function fakeResourceUsage() {
    const asked = [];
    const sample = (ts) => ({ ts, cpu: 1, ramUsed: 2, ramTotal: 3, rxBps: 4, txBps: 5 });
    return {
        asked,
        system: () => ({ cpu: { cores: 2, percent: 7 }, uptimeSeconds: 9 }),
        history: (after) => {
            asked.push(after);
            return [sample(1), sample(2)].filter((s) => after === undefined || s.ts > after);
        },
    };
}

function loadApp() {
    const { registerMetricsApi } = require('../../src/api/metrics');
    const resourceUsage = fakeResourceUsage();
    const app = express();
    registerMetricsApi(app, resourceUsage);
    return {
        resourceUsage,
        system: () => dispatch(app, 'GET', '/api/metrics/system'),
        history: (query = '') => dispatch(app, 'GET', `/api/metrics/history${query}`),
    };
}

describe('Metrics API integration', () => {
    test('GET /api/metrics/system answers with the resource usage module’s figures', async () => {
        const { system } = loadApp();
        const res = await system();
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { cpu: { cores: 2, percent: 7 }, uptimeSeconds: 9 });
    });

    test('GET /api/metrics/history gives every sample when no cursor is passed', async () => {
        const { history, resourceUsage } = loadApp();
        const res = await history();
        assert.equal(res.status, 200);
        assert.deepEqual(
            res.body.map((s) => s.ts),
            [1, 2],
        );
        assert.deepEqual(resourceUsage.asked, [undefined]);
    });

    test('GET /api/metrics/history?after= passes the cursor on and returns only newer samples', async () => {
        const { history, resourceUsage } = loadApp();
        const res = await history('?after=1');
        assert.deepEqual(
            res.body.map((s) => s.ts),
            [2],
        );
        assert.deepEqual(resourceUsage.asked, [1]);
        assert.deepEqual((await history('?after=2')).body, []);
    });

    test('a cursor that is not a number gives the full history', async () => {
        const { history, resourceUsage } = loadApp();
        const res = await history('?after=soon');
        assert.equal(res.body.length, 2);
        assert.deepEqual(resourceUsage.asked, [undefined]);
    });
});
