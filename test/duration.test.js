'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatDuration } = require('../src/utils/duration');

test('formatDuration shows seconds, then minutes, then hours', () => {
    assert.equal(formatDuration(12_000), '12s');
    assert.equal(formatDuration(125_000), '2m 5s');
    assert.equal(formatDuration(3_600_000), '1h 0m 0s');
    assert.equal(formatDuration(11_345_000), '3h 9m 5s');
});

test('formatDuration rounds to the nearest second', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(1_499), '1s');
    assert.equal(formatDuration(59_600), '1m 0s');
});
