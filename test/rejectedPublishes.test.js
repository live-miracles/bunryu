'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createRejectedPublishes } = require('../src/services/rejectedPublishes');

function clockedStore() {
    let t = 1_000_000;
    const store = createRejectedPublishes(() => t);
    return {
        store,
        advance: (ms) => {
            t += ms;
        },
    };
}

describe('rejected publishes store', () => {
    test('keeps one entry per key label and counts attempts', () => {
        const { store, advance } = clockedStore();
        store.record('key01_a', 'unassigned', 'srt', '127.0.0.1');
        advance(1000);
        store.record('key01_a', 'unassigned', 'srt', '127.0.0.1');
        store.record('key02_b', 'unknown', 'rtmp', '203.0.113.1');

        const list = store.list();
        assert.equal(list.length, 2);
        const k1 = list.find((e) => e.label === 'key01');
        assert.equal(k1.attempts, 2);
        assert.equal(k1.reason, 'unassigned');
        assert.equal(list.find((e) => e.label === 'key02').reason, 'unknown');
    });

    test('lists the most recent attempt first with its age', () => {
        const { store, advance } = clockedStore();
        store.record('key01_a', 'unassigned', 'rtmp', null);
        advance(5000);
        store.record('key02_b', 'unassigned', 'rtmp', null);
        advance(2000);

        const list = store.list();
        assert.deepEqual(
            list.map((e) => [e.label, e.lastAttemptAgoMs]),
            [
                ['key02', 2000],
                ['key01', 7000],
            ],
        );
    });

    test('drops entries that have not retried within the retention window', () => {
        const { store, advance } = clockedStore();
        store.record('key01_a', 'unassigned', 'rtmp', null);
        advance(5 * 60_000 + 1);
        assert.deepEqual(store.list(), []);
    });

    test('throttles repeated log lines per label and reports the suppressed count', () => {
        const { store, advance } = clockedStore();
        const first = store.record('key01_a', 'unassigned', 'srt', null);
        assert.equal(first.shouldLog, true);
        for (let i = 0; i < 5; i++) {
            advance(1000);
            assert.equal(store.record('key01_a', 'unassigned', 'srt', null).shouldLog, false);
        }
        // A different key still logs immediately.
        assert.equal(store.record('key02_a', 'unassigned', 'srt', null).shouldLog, true);
        advance(60_000);
        const again = store.record('key01_a', 'unassigned', 'srt', null);
        assert.equal(again.shouldLog, true);
        assert.equal(again.suppressed, 5);
    });

    test('folds all non-key names into one aggregate entry per protocol, without the name', () => {
        const { store } = clockedStore();
        const first = store.record('whatever', 'unknown', 'rtmp', '203.0.113.9');
        assert.equal(first.shouldLog, true);
        assert.equal(store.record('another', 'unknown', 'rtmp', null).shouldLog, false);
        store.record('', 'unknown', 'srt', '127.0.0.1');
        for (let i = 0; i < 500; i++) store.record(`junk-${i}`, 'unknown', 'rtmp', null);

        const list = store.list();
        assert.equal(list.length, 2);
        const rtmp = list.find((e) => e.protocol === 'rtmp');
        assert.equal(rtmp.reason, 'unrecognized');
        assert.equal(rtmp.label, '');
        assert.equal(rtmp.attempts, 502);
        assert.equal(rtmp.streams, 100);
        assert.equal(rtmp.streamsCapped, true);
        assert.equal(list.find((e) => e.protocol === 'srt').streams, 1);
        assert.ok(!JSON.stringify(list).includes('whatever'));
        assert.ok(!JSON.stringify(list).includes('junk'));
    });

    test('counts distinct unrecognized names, not attempts, and ages them out', () => {
        const { store, advance } = clockedStore();
        for (let i = 0; i < 20; i++) {
            store.record('typo-a', 'unknown', 'srt', null);
            store.record('typo-b', 'unknown', 'srt', null);
            advance(1000);
        }
        let [entry] = store.list();
        assert.equal(entry.attempts, 40);
        assert.equal(entry.streams, 2);
        assert.equal(entry.streamsCapped, false);

        // typo-b stops retrying; typo-a keeps going, so only it stays counted.
        for (let i = 0; i < 6 * 60; i++) {
            store.record('typo-a', 'unknown', 'srt', null);
            advance(1000);
        }
        [entry] = store.list();
        assert.equal(entry.streams, 1);
    });

    test('a key label always counts as one stream', () => {
        const { store } = clockedStore();
        store.record('key01_a', 'unassigned', 'srt', null);
        store.record('key01_b', 'unknown', 'srt', null);
        const [entry] = store.list();
        assert.equal(entry.streams, 1);
        assert.equal(entry.streamsCapped, false);
    });

    test('keeps play and publish rejections of the same key as separate entries', () => {
        const { store } = clockedStore();
        store.record('key01_a', 'unassigned', 'srt', null);
        const play = store.record('key01_a', 'assigned', 'srt', '203.0.113.7', 'play');
        assert.equal(play.shouldLog, true);

        const list = store.list();
        assert.equal(list.length, 2);
        assert.equal(list.find((e) => e.kind === 'publish').reason, 'unassigned');
        const playEntry = list.find((e) => e.kind === 'play');
        assert.equal(playEntry.reason, 'assigned');
        assert.equal(playEntry.label, 'key01');
    });

    test('aggregates unrecognized play names separately from publish names', () => {
        const { store } = clockedStore();
        store.record('abc', 'unknown', 'srt', null, 'play');
        store.record('abd', 'unknown', 'srt', null, 'play');
        store.record('abe', 'unknown', 'srt', null);

        const list = store.list();
        assert.equal(list.length, 2);
        const play = list.find((e) => e.kind === 'play');
        assert.equal(play.reason, 'unrecognized');
        assert.equal(play.streams, 2);
        assert.equal(list.find((e) => e.kind === 'publish').streams, 1);
    });

    test('stays bounded under a flood of distinct key labels', () => {
        const { store } = clockedStore();
        for (let i = 0; i < 1000; i++) store.record(`key${i % 1000}_x`, 'unknown', 'rtmp', null);
        assert.ok(store.list().length <= 200);
    });
});

describe('rejected publishes suppressed-count flush', () => {
    test('reports the suppressed count once the window ends even if the attempts stop', () => {
        let t = 1_000_000;
        const lines = [];
        const store = createRejectedPublishes(
            () => t,
            (line) => lines.push(line),
        );
        assert.equal(store.record('key01_a', 'unknown', 'srt', '127.0.0.1').shouldLog, true);
        for (let i = 0; i < 3; i += 1) {
            t += 1000;
            store.record('key01_a', 'unknown', 'srt', '127.0.0.1');
        }
        // The attempts stop; the dashboard's next list() runs the prune.
        t += 61_000;
        store.list();
        assert.equal(lines.length, 1);
        assert.match(lines[0], /3 more rejected publish attempts for key01/);
        // Flushed once, not again on the next prune.
        t += 61_000;
        store.list();
        assert.equal(lines.length, 1);
    });
});
