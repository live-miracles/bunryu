'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    RELAY_ERROR_DIAGNOSTICS_INTERVAL_MS,
    RELAY_ERROR_FRESH_MS,
    RELAY_ERROR_MERGE_WINDOW_MS,
    createRelayErrorLog,
    relayErrorSignature,
    relayErrorText,
} = require('../src/utils/relayErrorLog');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = 10_000_000;

const publish = (retryMs, reject = 'Connection setup failure') =>
    `Failed to publish to downstream output: srt_connect target=127.0.0.1:10080 streamid=#!::r=live/key01_secret,m=publish: ${reject}; retrying in ${retryMs} ms`;
const inputError = (port) => `Input error from peer 203.0.113.9:${port}: Connection was broken`;

describe('relay error text', () => {
    test('drops the retry delay and the stream id, which holds the key', () => {
        const text = relayErrorText(publish(4000));
        assert.equal(
            text,
            'Failed to publish to downstream output: srt_connect target=127.0.0.1:10080: Connection setup failure',
        );
        assert.doesNotMatch(text, /secret|retrying/);
    });

    test('the same failure has one signature whatever the delay or peer port', () => {
        assert.equal(relayErrorSignature(publish(1000)), relayErrorSignature(publish(16000)));
        assert.equal(
            relayErrorSignature(inputError(40123)),
            relayErrorSignature(inputError(51888)),
        );
        assert.notEqual(relayErrorSignature(publish(1000)), relayErrorSignature(inputError(40123)));
        assert.notEqual(
            relayErrorSignature(publish(1000, 'Connection setup failure')),
            relayErrorSignature(publish(1000, 'Connection rejected')),
        );
    });
});

describe('relay error log', () => {
    test('records an error once and merges its retries into that line', () => {
        const log = createRelayErrorLog();
        const first = log.observe(1, T0, publish(1000), T0);
        assert.equal(first.kind, 'new');
        assert.equal(first.message.includes('retrying'), false);
        log.setLogId(1, 42);

        // The same poll again: nothing new.
        assert.equal(log.observe(1, T0 + 5 * SECOND, publish(1000), T0), null);

        const second = log.observe(1, T0 + 10 * SECOND, publish(2000), T0 + 3 * SECOND);
        assert.equal(second.kind, 'repeat');
        assert.equal(second.logId, 42);
        assert.equal(second.count, 2);
        assert.match(second.message, /\(seen 2 times over 3 s\)$/);

        const later = log.observe(1, T0 + 5 * MINUTE, publish(16000), T0 + 5 * MINUTE);
        assert.equal(later.count, 3);
        assert.match(later.message, /\(seen 3 times over 5 min\)$/);
    });

    test('a different error is a new line, and the old one is not merged back into', () => {
        const log = createRelayErrorLog();
        log.observe(1, T0, publish(1000), T0);
        log.setLogId(1, 1);
        const other = log.observe(1, T0 + 5 * SECOND, inputError(40123), T0 + 4 * SECOND);
        assert.equal(other.kind, 'new');
        log.setLogId(1, 2);
        // The publish error returns: the open episode is the input error, so a new line.
        assert.equal(log.observe(1, T0 + 10 * SECOND, publish(1000), T0 + 8 * SECOND).kind, 'new');
    });

    test('an error that returns after the merge window is a new line', () => {
        const log = createRelayErrorLog();
        log.observe(1, T0, publish(1000), T0);
        log.setLogId(1, 1);
        const again = log.observe(
            1,
            T0 + RELAY_ERROR_MERGE_WINDOW_MS + MINUTE,
            publish(1000),
            T0 + RELAY_ERROR_MERGE_WINDOW_MS + MINUTE,
        );
        assert.equal(again.kind, 'new');
    });

    test('a retry after the session restarted (error cleared) still merges', () => {
        const log = createRelayErrorLog();
        log.observe(1, T0, inputError(40123), T0);
        log.setLogId(1, 7);
        assert.equal(log.observe(1, T0 + 5 * SECOND, null, null), null);
        const again = log.observe(1, T0 + 30 * SECOND, inputError(40999), T0 + 25 * SECOND);
        assert.equal(again.kind, 'repeat');
        assert.equal(again.logId, 7);
    });

    test('does not log an old error that was already there when the dashboard started', () => {
        const log = createRelayErrorLog();
        const old = T0 - RELAY_ERROR_FRESH_MS - SECOND;
        assert.equal(log.observe(1, T0, publish(1000), old), null);
        assert.equal(
            log.observe(1, T0 + 5 * SECOND, publish(1000), old),
            null,
            'and not on later polls',
        );
        // A fresh one right after is recorded.
        assert.equal(log.observe(1, T0 + 10 * SECOND, publish(2000), T0 + 8 * SECOND).kind, 'new');
        // A fresh error on the first poll is recorded.
        assert.equal(
            createRelayErrorLog().observe(2, T0, publish(1000), T0 - 2 * SECOND).kind,
            'new',
        );
    });

    test('diagnostics get the first occurrence and then one repeat a minute at most', () => {
        const log = createRelayErrorLog();
        assert.equal(log.observe(1, T0, publish(1000), T0).diagnostics, true);
        log.setLogId(1, 1);
        let count = 0;
        for (let t = 16 * SECOND; t <= 3 * MINUTE; t += 16 * SECOND) {
            if (log.observe(1, T0 + t, publish(16000), T0 + t).diagnostics) count++;
        }
        // About 11 repeats a minute... only about one a minute reaches diagnostics.
        assert.ok(count >= 2 && count <= 4, `got ${count}`);
        assert.ok(RELAY_ERROR_DIAGNOSTICS_INTERVAL_MS >= MINUTE);
    });

    test('pipelines are independent and deleted ones are forgotten', () => {
        const log = createRelayErrorLog();
        log.observe(1, T0, publish(1000), T0);
        assert.equal(log.observe(2, T0, publish(1000), T0).kind, 'new');
        log.keepOnly(new Set([2]));
        // Pipeline 1 starts afresh: an old error is not logged as new.
        assert.equal(log.observe(1, T0 + MINUTE, publish(1000), T0), null);
    });
});
