'use strict';

// The dashboard (public/ts/core/status.ts) and the server (src/utils/inputStatus.ts) each
// have their own copy of the input status rules, because neither can import the other's
// code. This runs both on the same inputs and asserts they agree.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePipelines, INPUT_ALERT_CODES } = require('../public/ts/core/pipeline');
const dashboard = require('../public/ts/core/status');
const utils = require('../public/ts/core/utils');
const server = require('../src/utils/inputStatus');

const T = 1_700_000_000_000;

const alert = (code, severity) => ({ severity, code, message: `${code} happened`, sinceMs: T });

// What the server's health snapshot holds for one pipeline's input, in the fields that decide
// its status; the rest is what the dashboard's InputHealth needs to be complete.
const inputEntry = (over) => ({
    connected: true,
    live: true,
    isSrt: false,
    mediaOk: true,
    mediaProbeStartedAt: null,
    mediaCheckedAt: null,
    mediaError: null,
    keyframes: null,
    recvBitrateKbps: 4000,
    sendBitrateKbps: null,
    readers: 0,
    uptimeMs: 120_000,
    publisherIp: null,
    publisherType: null,
    video: null,
    audio: null,
    audioTracks: [{}],
    ...over,
});

// Runs one input through both implementations.
function both(input, alerts) {
    const config = { pipelines: [{ id: '1', name: 'Hindi', streamKey: 'k', streamKeyId: 1 }] };
    const health = { pipelines: { 1: { input, outputs: {}, alerts } } };
    const [pipeline] = parsePipelines(config, health);
    return {
        d: dashboard.inputHealth(pipeline.input),
        s: server.inputHealth(input, alerts),
    };
}

function* combinations() {
    const ALERTS = [
        [],
        [alert('input-interlaced', 'warning')],
        [alert('input-flapping', 'error')],
        // About the relay link, not the input: neither side counts it.
        [alert('srt-packets-dropped', 'warning')],
        [alert('input-low-framerate', 'warning'), alert('input-keyframe-interval', 'warning')],
    ];
    for (const connected of [true, false])
        for (const live of [true, false])
            for (const mediaOk of [null, true, false])
                for (const mediaError of [null, 'ffprobe could not read the stream'])
                    for (const recvBitrateKbps of [null, 0, 100, 4000])
                        for (const uptimeMs of [null, 5_000, 120_000])
                            for (const audioTracks of [[], [{}]])
                                for (const audio of [null, { codec: 'aac' }])
                                    for (const alerts of ALERTS)
                                        yield {
                                            input: inputEntry({
                                                connected,
                                                live,
                                                mediaOk,
                                                mediaError,
                                                recvBitrateKbps,
                                                uptimeMs,
                                                audioTracks,
                                                audio,
                                            }),
                                            alerts,
                                        };
}

describe('input status: dashboard and server agree', () => {
    test('the constants are the same', () => {
        for (const code of INPUT_ALERT_CODES) assert.ok(server.INPUT_ALERT_CODES.has(code), code);
        assert.equal(server.INPUT_ALERT_CODES.size, INPUT_ALERT_CODES.size);
        // The server's bitrate floor is not exported; a bitrate just below the dashboard's
        // and one at it must split the same way on both sides.
        const below = both(inputEntry({ recvBitrateKbps: utils.LOW_BITRATE_KBPS - 1 }), []);
        const at = both(inputEntry({ recvBitrateKbps: utils.LOW_BITRATE_KBPS }), []);
        assert.equal(below.d.status, 'warn');
        assert.equal(below.s.status, 'warn');
        assert.equal(at.d.status, 'good');
        assert.equal(at.s.status, 'good');
        // The same for the warm-up: a low bitrate only counts once the input has run 30 s.
        for (const [uptimeMs, status] of [
            [29_999, 'good'],
            [30_000, 'warn'],
        ]) {
            const low = both(inputEntry({ recvBitrateKbps: 100, uptimeMs }), []);
            assert.equal(low.d.status, status, `dashboard at ${uptimeMs} ms`);
            assert.equal(low.s.status, status, `server at ${uptimeMs} ms`);
        }
    });

    test('over every combination of input state', () => {
        let n = 0;
        for (const c of combinations()) {
            const { d, s } = both(c.input, c.alerts);
            const label = JSON.stringify(c);
            assert.equal(s.status, d.status, `${label}: status`);
            assert.deepEqual(
                s.issues.map((i) => [i.severity, i.message]),
                d.issues.map((i) => [i.severity, i.message]),
                `${label}: issues`,
            );
            n++;
        }
        assert.ok(n > 1500);
    });

    test('the reported status follows the mapping, whatever the verdict', () => {
        const expected = { good: 'running', warn: 'warning', error: 'error' };
        for (const c of combinations()) {
            const { d } = both(c.input, c.alerts);
            for (const outputsShouldRun of [true, false]) {
                const reported = server.reportedInputState(c.input, c.alerts, outputsShouldRun);
                const status =
                    d.status === 'off'
                        ? outputsShouldRun
                            ? 'error'
                            : 'stopped'
                        : expected[d.status];
                assert.equal(reported.status, status, JSON.stringify([c, outputsShouldRun]));
                assert.equal(
                    reported.message,
                    d.status === 'off'
                        ? outputsShouldRun
                            ? server.NO_SIGNAL_MESSAGE
                            : ''
                        : d.status === 'good'
                          ? ''
                          : d.issues[0].message,
                );
            }
        }
    });
});
