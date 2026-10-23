'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    RELAY_PEER_WAIT_MS,
    describePublisherSource,
    nextPublisherLog,
} = require('../src/utils/publisherLog');

const idle = { active: false, bonded: false, peer: null };
const plain = { active: true, bonded: false, peer: { ip: '203.0.113.9', port: 40123 } };
const bonded = { active: true, bonded: true, peer: null };

const describe_ = (over) =>
    describePublisherSource({
        protocol: 'rtmp',
        ip: '198.51.100.4',
        loopback: false,
        relay: idle,
        waitedMs: 0,
        ...over,
    });

describe('describePublisherSource', () => {
    test('RTMP and direct SRT use the address SRS reports', () => {
        assert.deepEqual(describe_({}), { line: 'rtmp from 198.51.100.4', wait: false });
        assert.deepEqual(describe_({ protocol: 'srt' }), {
            line: 'srt from 198.51.100.4',
            wait: false,
        });
    });

    test('an RTMP publisher on loopback is logged as it is', () => {
        const r = describe_({ ip: '127.0.0.1', loopback: true, relay: plain });
        assert.equal(r.line, 'rtmp from 127.0.0.1');
    });

    test('SRT through the relay uses the relay peer, not the loopback address', () => {
        const r = describe_({ protocol: 'srt', ip: '127.0.0.1', loopback: true, relay: plain });
        assert.deepEqual(r, { line: 'srt via relay from 203.0.113.9:40123', wait: false });
    });

    test('a bonded group is left to the leg log', () => {
        const r = describe_({ protocol: 'srt', ip: '127.0.0.1', loopback: true, relay: bonded });
        assert.deepEqual(r, { line: null, wait: false });
    });

    test('waits for the relay status, then falls back to the loopback address', () => {
        const loop = { protocol: 'srt', ip: '127.0.0.1', loopback: true, relay: idle };
        assert.deepEqual(describe_({ ...loop, waitedMs: 5000 }), { line: null, wait: true });
        assert.deepEqual(describe_({ ...loop, waitedMs: RELAY_PEER_WAIT_MS }), {
            line: 'srt from 127.0.0.1',
            wait: false,
        });
    });

    test('no address, no line', () => {
        assert.deepEqual(describe_({ ip: null }), { line: null, wait: false });
    });
});

describe('nextPublisherLog', () => {
    const found = (line) => () => ({ line, wait: false });

    test('logs once per publisher id', () => {
        const first = nextPublisherLog(undefined, 'c1', 1000, found('rtmp from a'));
        assert.equal(first.line, 'rtmp from a');
        const again = nextPublisherLog(first.state, 'c1', 6000, found('rtmp from a'));
        assert.equal(again.line, null);
    });

    test('a new publisher id logs again without an offline in between', () => {
        const first = nextPublisherLog(undefined, 'c1', 1000, found('rtmp from a'));
        const next = nextPublisherLog(first.state, 'c2', 6000, found('rtmp from b'));
        assert.equal(next.line, 'rtmp from b');
    });

    test('forgets the publisher when nothing publishes, so a reconnect is logged', () => {
        const first = nextPublisherLog(undefined, 'c1', 1000, found('rtmp from a'));
        const gone = nextPublisherLog(first.state, null, 6000, found('x'));
        assert.equal(gone.state, undefined);
        assert.equal(
            nextPublisherLog(gone.state, 'c1', 11000, found('rtmp from a')).line,
            'rtmp from a',
        );
    });

    test('keeps asking while the source is pending, counting from the first poll', () => {
        const waits = [];
        const source = (waitedMs) => {
            waits.push(waitedMs);
            return waitedMs < 10_000
                ? { line: null, wait: true }
                : { line: 'srt via relay from p', wait: false };
        };
        let r = nextPublisherLog(undefined, 'c1', 1000, source);
        assert.equal(r.line, null);
        r = nextPublisherLog(r.state, 'c1', 6000, source);
        assert.equal(r.line, null);
        r = nextPublisherLog(r.state, 'c1', 11000, source);
        assert.equal(r.line, 'srt via relay from p');
        assert.deepEqual(waits, [0, 5000, 10000]);
    });

    test('a source with nothing to say is not asked again', () => {
        let calls = 0;
        const source = () => {
            calls++;
            return { line: null, wait: false };
        };
        const first = nextPublisherLog(undefined, 'c1', 1000, source);
        nextPublisherLog(first.state, 'c1', 6000, source);
        assert.equal(calls, 1);
    });
});
