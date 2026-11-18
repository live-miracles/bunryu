'use strict';

// The values the server's status rules and the dashboard both hold, because neither side can
// import the other's code. The rules themselves are on the server only (outputStatus.test.js,
// inputStatus.test.js); these are the few numbers and lists the dashboard repeats for display.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { INPUT_ALERT_CODES: dashboardAlertCodes } = require('../public/ts/core/pipeline');
const { LOW_BITRATE_KBPS } = require('../public/ts/core/utils');
const {
    displayInputBitrateKbps,
    summarizeOutputError: dashboardSummarize,
} = require('../public/ts/core/status');
const { INPUT_ALERT_CODES, inputHealth } = require('../src/utils/inputStatus');
const { outputHealth, summarizeOutputError } = require('../src/utils/outputStatus');

describe('what the dashboard repeats from the server', () => {
    test('the alerts that belong to the input', () => {
        assert.deepEqual([...dashboardAlertCodes].sort(), [...INPUT_ALERT_CODES].sort());
    });

    test('the low bitrate floor: the dashboard flags the same bitrates as the server', () => {
        const input = (recvBitrateKbps) => ({
            connected: true,
            live: true,
            mediaOk: true,
            mediaError: null,
            uptimeMs: 120_000,
            recvBitrateKbps,
            audioTracks: [{}],
            audio: null,
        });
        assert.equal(inputHealth(input(LOW_BITRATE_KBPS - 1)).status, 'warn');
        assert.equal(inputHealth(input(LOW_BITRATE_KBPS)).status, 'good');
        const output = (bitrateKbps) => ({
            desiredState: 'running',
            status: 'running',
            failures: 0,
            lastError: null,
            lastErrorAt: null,
            warningReason: null,
            startedAtMs: 1,
            bitrateKbps,
            sharedEncode: null,
        });
        assert.equal(outputHealth(output(LOW_BITRATE_KBPS - 1), { live: true }).status, 'warn');
        assert.equal(outputHealth(output(LOW_BITRATE_KBPS), { live: true }).status, 'good');
    });

    test('the 30 s the dashboard hides SRS startup zero bitrate for is the server warm-up', () => {
        const at = (uptimeMs) => ({
            connected: true,
            live: true,
            mediaOk: true,
            mediaError: null,
            uptimeMs,
            recvBitrateKbps: 0,
            audioTracks: [{}],
            audio: null,
        });
        for (const [uptimeMs, shown, status] of [
            [29_999, null, 'good'],
            [30_000, 0, 'warn'],
        ]) {
            assert.equal(displayInputBitrateKbps(at(uptimeMs)), shown, `shown at ${uptimeMs}`);
            assert.equal(inputHealth(at(uptimeMs)).status, status, `judged at ${uptimeMs}`);
        }
    });

    test('an error is cut to one line of at most 160 characters the same way', () => {
        const long = `first\n${'x'.repeat(300)}  \n`;
        for (const [error, fallback] of [
            [long, 'f'],
            [null, 'f'],
            ['  a   b  \n', 'f'],
        ]) {
            assert.equal(
                summarizeOutputError(error, fallback),
                dashboardSummarize(error, fallback),
            );
        }
    });
});
