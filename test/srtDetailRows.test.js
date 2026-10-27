const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    srtDetailRow,
    srtDetailSection,
    chartValueRange,
} = require('../public/ts/features/srt-bonding-details');
const { fmtMs, fmtMbpsValue } = require('../public/ts/core/utils');

describe('SRT detailed statistics', () => {
    test('a statistic the relay did not report has no row', () => {
        assert.equal(srtDetailRow('RTT', fmtMs(null)), '');
        assert.equal(srtDetailRow('Bandwidth', fmtMbpsValue(undefined)), '');
        assert.equal(srtDetailRow('Health issue', ''), '');
    });

    test('a reported zero still has a row', () => {
        assert.match(srtDetailRow('Recv Drop Total', '0'), /Recv Drop Total/);
        assert.match(srtDetailRow('RTT', fmtMs(0)), /0 ms/);
    });

    test('a section with no rows is left out with its title', () => {
        assert.equal(srtDetailSection('Output', ''), '');
        const html = srtDetailSection('Output', srtDetailRow('RTT', fmtMs(12)));
        assert.match(html, /Output/);
        assert.match(html, /RTT/);
    });

    test('a section whose rows were all unreported is left out', () => {
        const rows = [srtDetailRow('RTT', fmtMs(null)), srtDetailRow('Latency', fmtMs(null))];
        assert.equal(srtDetailSection('Output', rows.join('')), '');
    });
});

describe('loss / drop chart axis', () => {
    test('spans the window, not zero up, so a step after hours of drops is visible', () => {
        assert.deepEqual(chartValueRange([10_140, 10_141, 10_144]), { min: 10_140, max: 10_144 });
    });
    test('has a whole middle label: an odd span rounds up to even', () => {
        assert.deepEqual(chartValueRange([100, 103]), { min: 100, max: 104 });
    });
    test('a flat line still gets an axis, and a count from zero starts at zero', () => {
        assert.deepEqual(chartValueRange([500, 500]), { min: 500, max: 502 });
        assert.deepEqual(chartValueRange([0, 0, 1]), { min: 0, max: 2 });
        assert.deepEqual(chartValueRange([]), { min: 0, max: 2 });
    });
});
