'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { formatAgo } = require('../public/ts/core/utils');

describe('formatAgo', () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0);
    const ago = (ms) => formatAgo(now - ms, now);

    test('says how long before now, in the largest unit that fits', () => {
        assert.equal(ago(4_900), 'just now');
        assert.equal(ago(5_000), '5 s ago');
        assert.equal(ago(59_999), '59 s ago');
        assert.equal(ago(60_000), '1 min ago');
        assert.equal(ago(59 * 60_000 + 59_000), '59 min ago');
        assert.equal(ago(3_600_000), '1 h ago');
        assert.equal(ago(23.9 * 3_600_000), '23 h ago');
        assert.equal(ago(24 * 3_600_000), '1 d ago');
        assert.equal(ago(3 * 24 * 3_600_000), '3 d ago');
    });

    test('a time slightly ahead of now (clock skew) is just now, not negative', () => {
        assert.equal(formatAgo(now + 3_000, now), 'just now');
        assert.equal(formatAgo(now + 3_600_000, now), 'just now');
    });
});
