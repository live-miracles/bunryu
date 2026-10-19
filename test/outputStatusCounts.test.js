'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { outputStatusCounts } = require('../public/ts/features/output-badges');

describe('outputStatusCounts (sidebar badges)', () => {
    test('counts each status once', () => {
        const counts = outputStatusCounts(['good', 'good', 'warn', 'error', 'off']);
        assert.deepEqual(counts, { running: 2, warnings: 1, errors: 1 });
    });

    test('warning outputs do not take away from the running count', () => {
        // One healthy output next to six warning ones (a timestamp flood) must
        // still read 1 running, never -5.
        const counts = outputStatusCounts(['good', 'warn', 'warn', 'warn', 'warn', 'warn', 'warn']);
        assert.deepEqual(counts, { running: 1, warnings: 6, errors: 0 });
    });

    test('no outputs gives zeros', () => {
        assert.deepEqual(outputStatusCounts([]), { running: 0, warnings: 0, errors: 0 });
    });
});
