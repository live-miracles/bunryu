'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogThrottle } = require('../src/utils/logThrottle');

describe('log throttle', () => {
    test('logs the first attempt, holds back the rest of the interval and counts them', () => {
        const throttle = createLogThrottle({ intervalMs: 1000 });
        assert.deepEqual(throttle.note('a', 0), { shouldLog: true, suppressed: 0 });
        assert.deepEqual(throttle.note('a', 100), { shouldLog: false, suppressed: 1 });
        assert.deepEqual(throttle.note('a', 999), { shouldLog: false, suppressed: 2 });
        // The next interval's line carries the count, then starts from zero.
        assert.deepEqual(throttle.note('a', 1000), { shouldLog: true, suppressed: 2 });
        assert.deepEqual(throttle.note('a', 1100), { shouldLog: false, suppressed: 1 });
    });

    test('keys are throttled independently', () => {
        const throttle = createLogThrottle({ intervalMs: 1000 });
        throttle.note('a', 0);
        assert.equal(throttle.note('b', 10).shouldLog, true);
        assert.equal(throttle.note('a', 20).shouldLog, false);
    });

    test('flush reports counts nobody logged, once, after the interval ends', () => {
        const throttle = createLogThrottle({ intervalMs: 1000, retentionMs: 5000 });
        throttle.note('a', 0);
        throttle.note('a', 10);
        throttle.note('a', 20);
        throttle.note('quiet', 0);
        assert.deepEqual(throttle.flush(500), []); // still inside the interval
        assert.deepEqual(throttle.flush(1000), [{ key: 'a', suppressed: 2 }]);
        assert.deepEqual(throttle.flush(1001), []); // reported once
        // Reported counts do not come back on the next line.
        assert.deepEqual(throttle.note('a', 1100), { shouldLog: true, suppressed: 0 });
    });

    test('a key idle past the retention is forgotten', () => {
        const throttle = createLogThrottle({ intervalMs: 1000, retentionMs: 5000 });
        throttle.note('a', 0);
        throttle.note('a', 1);
        throttle.flush(5001);
        assert.deepEqual(throttle.note('a', 5002), { shouldLog: true, suppressed: 0 });
    });

    test('retention defaults to one interval', () => {
        const throttle = createLogThrottle({ intervalMs: 1000 });
        throttle.note('a', 0);
        throttle.note('a', 1);
        assert.deepEqual(throttle.flush(1001), [{ key: 'a', suppressed: 1 }]);
        assert.deepEqual(throttle.note('a', 1002), { shouldLog: true, suppressed: 0 });
    });

    test('a new key past maxKeys forgets all the others first', () => {
        const throttle = createLogThrottle({ intervalMs: 1000, maxKeys: 2 });
        throttle.note('a', 0);
        throttle.note('b', 0);
        assert.equal(throttle.note('a', 1).shouldLog, false); // known key: no eviction
        assert.equal(throttle.note('c', 2).shouldLog, true); // evicts a and b
        assert.equal(throttle.note('a', 3).shouldLog, true); // a was forgotten
    });
});
