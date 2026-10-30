'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractStreamResource } = require('../src/utils/srs');

test('extractStreamResource reads the r= resource of an SRT stream id', () => {
    assert.equal(extractStreamResource('#!::r=live/key01,m=publish'), 'live/key01');
    assert.equal(extractStreamResource('r=/live/key01'), 'live/key01');
    assert.equal(
        extractStreamResource('srt://h:1?mode=caller&streamid=#!::r=live/key01'),
        'live/key01',
    );
});

test('extractStreamResource also reads a percent-encoded stream id', () => {
    assert.equal(extractStreamResource('%23%21%3A%3Ar%3Dlive%2Fkey01%2Cm%3Dpublish'), 'live/key01');
});

test('extractStreamResource gives null when there is no resource', () => {
    assert.equal(extractStreamResource(''), null);
    assert.equal(extractStreamResource('m=publish'), null);
    assert.equal(extractStreamResource('%E0%A4%A'), null);
});
