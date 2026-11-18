'use strict';

// The output status rules (src/utils/outputStatus.ts): what state an output is in and why.
// They run on the server only; the dashboard shows the verdict they produce.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
    currentErrorLine,
    hasCurrentError,
    outputHealth,
    reportedState,
    summarizeOutputError,
} = require('../src/utils/outputStatus');

const T = 1_700_000_000_000;

const output = (over = {}) => ({
    id: '1-1',
    name: 'YouTube',
    url: 'rtmp://dest.example/live/1-1',
    desiredState: 'running',
    videoEncoding: 'copy',
    audioEncoding: 'copy',
    status: 'running',
    failures: 0,
    lastError: null,
    lastErrorAt: null,
    warningReason: null,
    warningSinceMs: null,
    startedAtMs: 1000,
    bitrateKbps: 5000,
    renditionId: null,
    ready: null,
    sharedEncode: null,
    ...over,
});
const liveInput = { live: true };
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
        const input = { live: false };
        assert.equal(verdict({}, input).status, 'warn');
        assert.match(verdict({}, input).issues[0].message, /input is not live/);
        assert.equal(
            verdict({}, input, false).status,
            'good',
            'a shared encode shows it elsewhere',
        );
    });

    test('a warning the output reported is the issue', () => {
        const v = verdict({ warningReason: 'High memory usage: 150MB' });
        assert.equal(v.status, 'warn');
        assert.equal(v.issues[0].message, 'High memory usage: 150MB');
    });

    test('bitrate: below 200 kb/s warns, none yet warns, none after an error is an error', () => {
        assert.match(verdict({ bitrateKbps: 100 }).issues[0].message, /below 200 kb\/s/);
        assert.equal(verdict({ bitrateKbps: 199 }).status, 'warn');
        assert.equal(verdict({ bitrateKbps: 200 }).status, 'good');
        assert.match(verdict({ bitrateKbps: null }).issues[0].message, /no bitrate is reported/);
        const afterError = verdict({ bitrateKbps: null, lastError: 'boom', lastErrorAt: 2000 });
        assert.equal(afterError.status, 'error');
        assert.equal(afterError.issues[0].message, 'boom');
    });

    test('a failed output is an error that counts the errors since the last start', () => {
        const v = verdict({ status: 'failed', failures: 3, lastError: 'a\nConnection refused' });
        assert.equal(v.status, 'error');
        assert.equal(v.issues[0].severity, 'error');
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
            sharedEncode: output({
                name: 'Shared encode 720p',
                ready: false,
                status: 'running',
            }),
        });
        assert.equal(waiting.status, 'warn');
        assert.equal(waiting.issues[0].message, 'Waiting for Shared encode 720p');
        const failed = verdict({
            status: 'stopped',
            sharedEncode: output({ name: 'x', ready: false, status: 'failed', lastError: 'boom' }),
        });
        assert.equal(failed.status, 'warn');
        assert.equal(failed.issues[0].message, 'Shared encode failed: boom');
    });

    // Every state an output can be in, for the checks that hold whatever the state.
    function* states() {
        for (const desiredState of ['running', 'stopped'])
            for (const status of ['running', 'stopped', 'failed'])
                for (const bitrateKbps of [null, 100, 4000])
                    for (const warningReason of [null, 'Timestamps are jumping'])
                        for (const startedAtMs of [null, T])
                            for (const lastError of [null, 'old crash', 'fresh crash\nrefused'])
                                for (const failures of [0, 2])
                                    for (const live of [true, false])
                                        yield {
                                            o: output({
                                                desiredState,
                                                status,
                                                bitrateKbps,
                                                warningReason,
                                                startedAtMs,
                                                lastError,
                                                lastErrorAt: lastError
                                                    ? lastError.startsWith('old')
                                                        ? T - 5000
                                                        : T + 5000
                                                    : null,
                                                failures,
                                            }),
                                            live,
                                        };
    }

    test('whatever the state: a status always comes with the right issues', () => {
        let n = 0;
        for (const { o, live } of states()) {
            const v = outputHealth(o, { live });
            const label = JSON.stringify([o, live]);
            if (o.desiredState === 'stopped') {
                assert.deepEqual(v, { status: 'off', issues: [] }, label);
            } else {
                assert.notEqual(v.status, 'off', label);
            }
            if (v.status === 'good' || v.status === 'off') {
                assert.deepEqual(v.issues, [], label);
            } else {
                assert.equal(v.issues.length, 1, label);
                assert.equal(
                    v.issues[0].severity,
                    v.status === 'error' ? 'error' : 'warning',
                    label,
                );
                assert.ok(v.issues[0].message.length > 0, label);
            }
            if (v.status === 'good') {
                assert.equal(o.status, 'running', label);
                assert.equal(live, true, label);
                assert.equal(o.warningReason, null, label);
                assert.ok(o.bitrateKbps >= 200, label);
            }
            if (v.status === 'error') {
                assert.ok(o.status === 'failed' || hasCurrentError(o), label);
            }
            // Leaving the input out changes the verdict only for a running output whose input is down.
            const without = outputHealth(o, { live }, false);
            const differs = JSON.stringify(without) !== JSON.stringify(v);
            assert.equal(
                differs,
                o.desiredState === 'running' && o.status === 'running' && !live && !o.sharedEncode,
                label,
            );
            n++;
        }
        assert.ok(n > 800);
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

    test('currentErrorLine is the last non-empty line of an error with a time, else nothing', () => {
        assert.equal(currentErrorLine(output({ lastError: 'a\nb\n\n', lastErrorAt: 1 })), 'b');
        assert.equal(currentErrorLine(output({ lastError: 'a', lastErrorAt: null })), '');
        assert.equal(currentErrorLine(output({ lastError: null })), '');
    });

    test('summarizeOutputError keeps one line, at most 160 characters', () => {
        assert.equal(summarizeOutputError(null, 'fallback'), 'fallback');
        assert.equal(summarizeOutputError('  a   b  \n', 'fallback'), 'a b');
        const long = summarizeOutputError('x'.repeat(300), 'fallback');
        assert.equal(long.length, 160);
        assert.ok(long.endsWith('...'));
    });
});

describe('reportedState: the status Key Vault gets', () => {
    test('a healthy running output is running, with nothing to say', () => {
        assert.deepEqual(reportedState(output(), liveInput), {
            status: 'running',
            message: '',
            stoppedAfterFailures: false,
        });
    });

    test('a warning is a warning with its text, an error an error', () => {
        assert.deepEqual(reportedState(output({ warningReason: 'Falling behind' }), liveInput), {
            status: 'warning',
            message: 'Falling behind',
            stoppedAfterFailures: false,
        });
        const failed = reportedState(output({ status: 'failed', lastError: 'boom' }), liveInput);
        assert.equal(failed.status, 'error');
        assert.equal(failed.message, 'boom');
    });

    test('a running output with an unresolved crash is an error even when the dot is not', () => {
        const state = reportedState(
            output({ lastError: 'crashed\nbroken pipe', lastErrorAt: 5000, startedAtMs: 1000 }),
            liveInput,
        );
        assert.equal(state.status, 'error');
        assert.equal(state.message, 'broken pipe');
    });

    test('a stopped output is stopped, unless it was stopped after repeated failures', () => {
        assert.deepEqual(reportedState(output({ desiredState: 'stopped' }), liveInput), {
            status: 'stopped',
            message: '',
            stoppedAfterFailures: false,
        });
        const afterFailures = reportedState(
            output({
                desiredState: 'stopped',
                status: 'stopped',
                startedAtMs: null,
                lastError: 'Stopped after 5 failed attempts\nrefused',
                lastErrorAt: 5000,
            }),
            liveInput,
        );
        assert.equal(afterFailures.status, 'error');
        assert.equal(afterFailures.stoppedAfterFailures, true);
        assert.equal(afterFailures.message, 'refused');
    });

    test('advice about the configuration is not a warning to Key Vault', () => {
        // Nothing in the status rules is advice: the output's own state decides.
        assert.equal(reportedState(output({ videoEncoding: '720p' }), liveInput).status, 'running');
    });
});
