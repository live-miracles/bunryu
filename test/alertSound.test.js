const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    CRASH_EPISODE_MS,
    clampAlertVolume,
    newAttention,
} = require('../public/ts/core/alert-sound');

function out(overrides = {}) {
    return {
        id: 'o1',
        desiredState: 'running',
        lastError: null,
        lastErrorAt: null,
        ...overrides,
    };
}

function pipeline(overrides = {}) {
    return {
        id: 'p1',
        alerts: [],
        input: { live: true },
        outs: [out()],
        ...overrides,
    };
}

function snapshot(overrides = {}) {
    return {
        serverUnreachable: false,
        srsReachable: true,
        relayDown: false,
        pipelines: [pipeline()],
        ...overrides,
    };
}

// Feeds the snapshots in order and returns what each one reported as fresh.
function run(...snapshots) {
    let state = null;
    return snapshots.map((s) => {
        const result = newAttention(state, s);
        state = result.state;
        return result.fresh;
    });
}

describe('newAttention', () => {
    test('the first snapshot only sets the baseline, whatever is wrong in it', () => {
        const broken = snapshot({
            srsReachable: false,
            pipelines: [
                pipeline({
                    alerts: [{ severity: 'error', code: 'input-flapping' }],
                    input: { live: false },
                    outs: [out({ lastError: 'boom', lastErrorAt: 1000 })],
                }),
            ],
        });
        assert.deepEqual(run(broken), [[]]);
    });

    test('a problem beeps once when it starts, not while it lasts', () => {
        const down = snapshot({ srsReachable: false });
        assert.deepEqual(run(snapshot(), down, down, snapshot(), down), [
            [],
            ['srs-unreachable'],
            [],
            [],
            ['srs-unreachable'],
        ]);
    });

    test('server unreachable and relay down are new problems too', () => {
        assert.deepEqual(run(snapshot(), snapshot({ serverUnreachable: true, relayDown: true })), [
            [],
            ['server-unreachable', 'relay-down'],
        ]);
    });

    test('error alerts beep, warning alerts do not', () => {
        const withAlerts = snapshot({
            pipelines: [
                pipeline({
                    alerts: [
                        { severity: 'warning', code: 'srt-packet-loss' },
                        { severity: 'error', code: 'bonded-leg-down' },
                    ],
                }),
            ],
        });
        assert.deepEqual(run(snapshot(), withAlerts), [[], ['alert:p1:bonded-leg-down']]);
    });

    test('an offline input beeps only while its outputs are meant to be running', () => {
        const offline = (desiredState) =>
            snapshot({
                pipelines: [pipeline({ input: { live: false }, outs: [out({ desiredState })] })],
            });
        assert.deepEqual(run(snapshot(), offline('running')), [[], ['input-offline:p1']]);
        assert.deepEqual(run(snapshot(), offline('stopped')), [[], []]);
    });

    test('an output crash beeps once per failing episode', () => {
        const crashedAt = (ts, desiredState = 'running') =>
            snapshot({
                pipelines: [
                    pipeline({ outs: [out({ lastError: 'boom', lastErrorAt: ts, desiredState })] }),
                ],
            });
        assert.deepEqual(
            run(
                snapshot(),
                crashedAt(10_000),
                // The record stays current after the output recovers: no new beep.
                crashedAt(10_000),
                // A retry that fails again within the episode window.
                crashedAt(10_000 + CRASH_EPISODE_MS - 1),
                // The next failure after a minute is a new episode.
                crashedAt(10_000 + 2 * CRASH_EPISODE_MS),
            ),
            [[], ['output-crash:o1'], [], [], ['output-crash:o1']],
        );
    });

    test('a stop after repeated failures that the operator chose is not a crash to beep for', () => {
        const stopped = snapshot({
            pipelines: [
                pipeline({
                    outs: [
                        out({
                            desiredState: 'stopped',
                            lastError: 'Stopped after 5 failed attempts',
                            lastErrorAt: 5000,
                        }),
                    ],
                }),
            ],
        });
        assert.deepEqual(run(snapshot(), stopped), [[], []]);
    });
});

describe('clampAlertVolume', () => {
    test('keeps 0-500 and falls back to 100 for garbage', () => {
        assert.equal(clampAlertVolume(250), 250);
        assert.equal(clampAlertVolume(-5), 0);
        assert.equal(clampAlertVolume(900), 500);
        assert.equal(clampAlertVolume(Number.NaN), 100);
    });
});
