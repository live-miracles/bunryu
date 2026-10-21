const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { srtDetailRow, srtDetailSection } = require('../public/ts/features/srt-bonding-details');
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
