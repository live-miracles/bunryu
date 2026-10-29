'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
    hasCurrentError,
    inputHealth,
    lastErrorLine,
    outputHealth,
    summarizeOutputError,
} = require('../public/ts/core/status');

const output = (over = {}) => ({
    id: '1-1',
    desiredState: 'running',
    status: 'running',
    failures: 0,
    lastError: null,
    lastErrorAt: null,
    warningReason: null,
    startedAtMs: 1000,
    bitrateKbps: 5000,
    sharedEncode: null,
    ...over,
});
const liveInput = { connected: true, live: true };
const verdict = (over, input = liveInput, includeInput) =>
    outputHealth(output(over), input, includeInput);

describe('outputHealth', () => {
    test('a stopped output is off, whatever it last said', () => {
        assert.deepEqual(verdict({ desiredState: 'stopped', status: 'failed' }), {
            status: 'off',
            issues: [],
        });
    });

    test('running with data is good', () => {
        assert.deepEqual(verdict({}), { status: 'good', issues: [] });
    });

    test('running while the input is not live warns, unless the input is left out of the verdict', () => {
        const input = { connected: true, live: false };
        assert.equal(verdict({}, input).status, 'warn');
        assert.match(verdict({}, input).issues[0].message, /input is not live/);
        assert.equal(
            verdict({}, input, false).status,
            'good',
            'a shared encode shows it elsewhere',
        );
    });

    test('a warning the server reported is the issue', () => {
        const v = verdict({ warningReason: 'High memory usage: 150MB' });
        assert.equal(v.status, 'warn');
        assert.equal(v.issues[0].message, 'High memory usage: 150MB');
    });

    test('bitrate: below 200 kb/s warns, none yet warns, none after an error is an error', () => {
        assert.match(verdict({ bitrateKbps: 100 }).issues[0].message, /below 200 kb\/s/);
        assert.match(verdict({ bitrateKbps: null }).issues[0].message, /no bitrate is reported/);
        const afterError = verdict({ bitrateKbps: null, lastError: 'boom', lastErrorAt: 2000 });
        assert.equal(afterError.status, 'error');
        assert.equal(afterError.issues[0].message, 'boom');
    });

    test('a failed output is an error that counts the errors since the last start', () => {
        const v = verdict({ status: 'failed', failures: 3, lastError: 'a\nConnection refused' });
        assert.equal(v.status, 'error');
        assert.equal(v.issues[0].message, '3 errors since last start. Connection refused');
        assert.equal(
            verdict({ status: 'failed', failures: 1 }).issues[0].message,
            '1 error since last start. Output process failed.',
        );
    });

    test('between retries: the error while one is current, waiting otherwise', () => {
        const between = { status: 'stopped', startedAtMs: null };
        assert.equal(
            verdict({ ...between, failures: 2, lastError: 'x', lastErrorAt: 1 }).status,
            'error',
        );
        // A manual start that has not spawned yet must not resurrect an old error.
        const fresh = verdict({ ...between, failures: 0, lastError: 'old', lastErrorAt: 1 });
        assert.equal(fresh.status, 'warn');
        assert.match(fresh.issues[0].message, /waiting to start or retry/);
    });

    test('an output waiting for its shared encode is a warning, not an error', () => {
        const waiting = verdict({
            status: 'stopped',
            sharedEncode: { name: 'Shared encode 720p', ready: false, status: 'running' },
        });
        assert.equal(waiting.status, 'warn');
        assert.equal(waiting.issues[0].message, 'Waiting for Shared encode 720p');
        const failed = verdict({
            status: 'stopped',
            sharedEncode: { name: 'x', ready: false, status: 'failed', lastError: 'boom' },
        });
        assert.equal(failed.status, 'warn');
        assert.match(failed.issues[0].message, /^Shared encode failed: boom$/);
    });
});

describe('the error helpers', () => {
    test('an error is current in its own run, or while waiting to retry after a failure', () => {
        assert.equal(hasCurrentError(output({ lastError: 'x', lastErrorAt: 2000 })), true);
        assert.equal(
            hasCurrentError(output({ lastError: 'x', lastErrorAt: 500 })),
            false,
            'earlier run',
        );
        assert.equal(
            hasCurrentError(output({ lastError: 'x', lastErrorAt: 1, startedAtMs: null })),
            false,
        );
        assert.equal(
            hasCurrentError(
                output({ lastError: 'x', lastErrorAt: 1, startedAtMs: null, failures: 1 }),
            ),
            true,
        );
        assert.equal(hasCurrentError(output({ lastError: null })), false);
    });

    test('lastErrorLine is the last non-empty line', () => {
        assert.equal(lastErrorLine({ lastError: 'a\nb\n\n' }), 'b');
        assert.equal(lastErrorLine({ lastError: null }), '');
    });

    test('summarizeOutputError keeps one line, at most 160 characters', () => {
        assert.equal(summarizeOutputError(null, 'fallback'), 'fallback');
        assert.equal(summarizeOutputError('  a   b  \n', 'fallback'), 'a b');
        const long = summarizeOutputError('x'.repeat(300), 'fallback');
        assert.equal(long.length, 160);
        assert.ok(long.endsWith('...'));
    });
});

describe('inputHealth', () => {
    const input = (over = {}) => ({
        connected: true,
        live: true,
        mediaOk: true,
        mediaError: null,
        uptimeMs: 120_000,
        recvBitrateKbps: 6000,
        audioTracks: [{ index: 0 }],
        audio: null,
        alerts: [],
        ...over,
    });

    test('not connected is off', () => {
        assert.deepEqual(inputHealth(input({ connected: false })), { status: 'off', issues: [] });
    });

    test('a failed probe is an error and outranks the pending state', () => {
        const v = inputHealth(input({ mediaOk: false, mediaError: '10:00:00 ffprobe failed' }));
        assert.equal(v.status, 'error');
        assert.equal(v.issues[0].message, '10:00:00 ffprobe failed');
        assert.equal(inputHealth(input({ mediaOk: null, mediaError: 'boom' })).status, 'error');
    });

    test('waiting for the first probe, or for media, warns', () => {
        assert.match(
            inputHealth(input({ mediaOk: null })).issues[0].message,
            /Waiting for ffprobe/,
        );
        assert.match(
            inputHealth(input({ live: false })).issues[0].message,
            /waiting for valid media/,
        );
    });

    test('a healthy input is good', () => {
        assert.deepEqual(inputHealth(input()), { status: 'good', issues: [] });
    });

    test('low bitrate warns only once SRS has real statistics (not the startup zero)', () => {
        assert.equal(inputHealth(input({ recvBitrateKbps: 0, uptimeMs: 10_000 })).status, 'good');
        const low = inputHealth(input({ recvBitrateKbps: 0, uptimeMs: 40_000 }));
        assert.equal(low.status, 'warn');
        assert.match(low.issues[0].message, /Input bitrate is below 200 kb\/s/);
    });

    test('no audio track warns', () => {
        const v = inputHealth(input({ audioTracks: [], audio: null }));
        assert.equal(v.status, 'warn');
        assert.equal(v.issues[0].message, 'No audio track detected in input.');
        assert.equal(
            inputHealth(input({ audioTracks: [], audio: { codec: 'aac' } })).status,
            'good',
        );
    });

    test('server alerts are listed with their severity, and an error alert makes it an error', () => {
        const alerts = [{ code: 'x', severity: 'warning', message: 'Late packets', sinceMs: 5 }];
        const warn = inputHealth(input({ alerts }));
        assert.equal(warn.status, 'warn');
        assert.equal(warn.issues[0].message, 'Late packets');
        assert.equal(warn.issues[0].sinceMs, 5);
        const error = inputHealth(
            input({ alerts: [...alerts, { code: 'y', severity: 'error', message: 'Down' }] }),
        );
        assert.equal(error.status, 'error');
    });
});
