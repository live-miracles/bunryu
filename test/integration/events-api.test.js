'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable } = require('node:stream');

const { createDb } = require('../../src/db/index');
const { registerEventsApi } = require('../../src/api/events');

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
            this.resolve({ status: this.statusCode, body: text ? JSON.parse(text) : undefined });
            if (callback) callback();
            return this;
        };
    }

    _write(chunk, _encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }
}

function get(app, route) {
    return new Promise((resolve, reject) => {
        app.handle(new MockRequest('GET', route), new MockResponse(resolve), reject);
    });
}

function setup(serverEvents = []) {
    const db = createDb(':memory:');
    const app = express();
    registerEventsApi(app, db, () => serverEvents);
    return { db, app };
}

describe('GET /api/events', () => {
    test('is an empty list on a fresh install', async () => {
        const { app } = setup();
        const res = await get(app, '/api/events');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, []);
    });

    test('merges pipeline lines, output History and Server events', async () => {
        const { db, app } = setup([
            {
                ts: Date.now() + 10_000,
                source: 'host',
                type: 'problem',
                message: 'Disk almost full',
            },
        ]);
        const pipeline = db.createPipeline();
        const output = db.createOutput({
            pipelineId: pipeline.id,
            name: 'YT',
            url: 'rtmp://192.0.2.1/live/x',
        });
        db.appendPipelineLog(pipeline.id, 'offline', 'Input disconnected');
        db.setOutputLastError(output.id, 'Connection refused', 'crash');

        const res = await get(app, '/api/events');
        assert.equal(res.status, 200);
        assert.deepEqual(
            res.body.map((e) => [e.source, e.pipelineName, e.outputName, e.label, e.severity]),
            [
                ['server', null, null, 'Host', 'error'],
                ['output', pipeline.name, 'YT', 'crash', 'error'],
                ['input', pipeline.name, null, 'offline', 'warning'],
            ],
        );
    });

    test('limit returns only the newest events', async () => {
        const { db, app } = setup();
        const pipeline = db.createPipeline();
        for (let i = 0; i < 10; i++) db.appendPipelineLog(pipeline.id, 'online', `line ${i}`);

        const res = await get(app, '/api/events?limit=3');
        assert.deepEqual(
            res.body.map((e) => e.message),
            ['line 9', 'line 8', 'line 7'],
        );
    });

    test('a bad limit gives the default instead of an error', async () => {
        const { db, app } = setup();
        const pipeline = db.createPipeline();
        for (let i = 0; i < 60; i++) db.appendPipelineLog(pipeline.id, 'online', `line ${i}`);

        // The last one makes Express parse `limit` as an array.
        for (const q of ['limit=abc', 'limit=-1', 'limit=0', 'limit=1&limit=2']) {
            const res = await get(app, `/api/events?${q}`);
            assert.equal(res.status, 200, q);
            assert.equal(res.body.length, 50, q);
        }
    });

    test('a deleted pipeline leaves no events', async () => {
        const { db, app } = setup();
        const pipeline = db.createPipeline();
        db.appendPipelineLog(pipeline.id, 'online', 'x');
        db.deletePipeline(pipeline.id);

        const res = await get(app, '/api/events');
        assert.deepEqual(res.body, []);
    });
});
