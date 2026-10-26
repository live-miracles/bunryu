'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { alertHint, errorHint } = require('../public/ts/core/hints');

describe('errorHint', () => {
    const cases = [
        ['rtmp://a.example/live/key: Connection refused', /refused the connection/i],
        ['tcp://a.example:1935: Operation timed out', /did not answer/i],
        ['Failed to resolve hostname a.example: Name or service not known', /host name/i],
        ['rtmp://a.example/live/key: Input/output error', /stream key/i],
        // A write that stayed blocked until ffmpeg gave up (see OUTPUT_IO_TIMEOUT_US)
        // is not a rejected key, even though RTMPS words it as an I/O error.
        [
            '[out#0/flv @ 0x5d2058edfac0] Error closing file: Input/output error',
            /stopped accepting data/i,
        ],
        [
            '[out#0/flv @ 0x648c4b905580] Error closing file: Connection timed out',
            /stopped accepting data/i,
        ],
        ['Error writing trailer: Broken pipe', /stream key/i],
        ['Server returned 403 Forbidden', /rejected the login/i],
        ['srt://a.example:9000: Connection setup failure: connection rejected', /passphrase/i],
        [
            'Stopped after 5 failed attempts. Last error: Connection refused',
            /refused the connection/i,
        ],
        [
            'Output is running at 0.62x realtime and falling behind live (slow encode)',
            /falling behind|keep up/i,
        ],
    ];
    for (const [message, expected] of cases) {
        test(`explains "${message.slice(0, 40)}"`, () => {
            assert.match(errorHint(message), expected);
        });
    }

    test('is null for text it has no advice for', () => {
        assert.equal(errorHint('something entirely different'), null);
        assert.equal(errorHint(''), null);
        assert.equal(errorHint(null), null);
    });

    test('matches case-insensitively and across a multi-line stderr tail', () => {
        assert.match(errorHint('exit=1\nlibrtmp\nCONNECTION REFUSED'), /refused/i);
    });
});

describe('alertHint', () => {
    test('has advice for every link-quality alert code', () => {
        for (const code of [
            'srt-packets-dropped',
            'srt-packet-loss',
            'srt-retransmissions',
            'srt-belated-packets',
            'srt-latency-spike',
            'input-bitrate-collapse',
            'input-low-framerate',
            'input-keyframe-interval',
            'input-flapping',
            'relay-forwarding-stalled',
        ]) {
            assert.ok(alertHint(code), `no hint for ${code}`);
        }
    });

    test('is null for codes whose message already says what to do', () => {
        assert.equal(alertHint('publisher-reconnected'), null);
        assert.equal(alertHint('no-such-code'), null);
    });
});
