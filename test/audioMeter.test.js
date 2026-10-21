const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    CLIP_DB,
    METER_FLOOR_DB,
    METER_RELEASE_DB_PER_SECOND,
    peakDb,
    releaseLevel,
} = require('../public/ts/core/audio-meter');

describe('peakDb', () => {
    test('reads the highest absolute sample in dBFS, whatever its sign', () => {
        assert.ok(Math.abs(peakDb(new Float32Array([0.1, -0.5, 0.2])) - -6.02) < 0.01);
        assert.ok(Math.abs(peakDb(new Float32Array([0.25])) - -12.04) < 0.01);
    });

    test('full scale is the clipping threshold', () => {
        assert.ok(peakDb(new Float32Array([0, 1, -0.3])) >= CLIP_DB);
        assert.ok(peakDb(new Float32Array([0.99])) < CLIP_DB);
    });

    test('silence and an empty read sit far below the meter floor', () => {
        assert.ok(peakDb(new Float32Array(64)) < METER_FLOOR_DB);
        assert.ok(peakDb(new Float32Array(0)) < METER_FLOOR_DB);
    });

    test('a dense signal is not read hotter than its peak (unlike RMS x2)', () => {
        const square = new Float32Array(1024).fill(0.5);
        assert.ok(Math.abs(peakDb(square) - -6.02) < 0.01);
    });
});

describe('releaseLevel', () => {
    test('falls at the release rate', () => {
        assert.equal(releaseLevel(-10, -90, 200), -10 - METER_RELEASE_DB_PER_SECOND * 0.2);
    });

    test('never falls below the latest reading', () => {
        assert.equal(releaseLevel(-10, -12, 1000), -12);
    });

    test('a stalled frame falls at most 250 ms worth', () => {
        assert.equal(releaseLevel(-10, -90, 60_000), -10 - METER_RELEASE_DB_PER_SECOND * 0.25);
    });

    test('stays put while the reading is at the shown level', () => {
        assert.equal(releaseLevel(-20, -20, 33), -20);
    });
});
