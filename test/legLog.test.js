'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    LEG_LOG_MAX_PER_WINDOW,
    LEG_LOG_WINDOW_MS,
    LEG_RECOVERY_HOLD_MS,
    allowLegLogLine,
    createLegLogState,
    legHealthMessage,
    noteLegHealth,
    describeLegChange,
    suppressedLegLinesMessage,
    takeSuppressedLegLines,
} = require('../src/utils/legLog');

const A = '203.0.113.10:10081';
const B = '198.51.100.7:49152';
const C = '192.0.2.44:50000';

describe('describeLegChange', () => {
    test('reports the starting set when the input has just come up', () => {
        const change = describeLegChange(null, [A, B]);
        assert.equal(change.from, 0);
        assert.equal(change.to, 2);
        assert.deepEqual(change.joined, [A, B]);
        assert.equal(change.message, `Bonded input connected with 2 legs: ${A}, ${B}`);
        assert.equal(
            describeLegChange(null, [A]).message,
            `Bonded input connected with 1 leg: ${A}`,
        );
    });

    test('says nothing while the same legs are connected, in any order', () => {
        assert.equal(describeLegChange([A, B], [A, B]), null);
        assert.equal(describeLegChange([A, B], [B, A]), null);
        assert.equal(describeLegChange([], []), null);
    });

    test('names the leg that was lost and the legs that remain', () => {
        const change = describeLegChange([A, B], [A]);
        assert.deepEqual([change.from, change.to], [2, 1]);
        assert.deepEqual(change.left, [B]);
        assert.deepEqual(change.joined, []);
        assert.equal(change.message, `Bonded legs went from 2 to 1: lost ${B} (now: ${A})`);
    });

    test('names the leg that joined', () => {
        const change = describeLegChange([A], [A, C]);
        assert.deepEqual(change.joined, [C]);
        assert.equal(change.message, `Bonded legs went from 1 to 2: joined ${C} (now: ${A}, ${C})`);
    });

    test('a leg that comes back from a new port is one lost and one joined', () => {
        const back = '198.51.100.7:50001';
        const change = describeLegChange([A, B], [A, back]);
        assert.deepEqual(change.left, [B]);
        assert.deepEqual(change.joined, [back]);
        assert.equal(
            change.message,
            `Bonded legs changed (still 2): lost ${B}; joined ${back} (now: ${A}, ${back})`,
        );
    });

    test('handles every leg gone and every leg replaced', () => {
        assert.equal(
            describeLegChange([A, B], []).message,
            `Bonded legs went from 2 to 0: lost ${A}, ${B} (now: none)`,
        );
        const change = describeLegChange([A], [B, C]);
        assert.deepEqual([change.left, change.joined], [[A], [B, C]]);
    });
});

describe('the pipeline log limit', () => {
    test('shows a few lines per window and counts the rest', () => {
        const state = createLegLogState([A], 1_000);
        const shown = [];
        for (let i = 0; i < LEG_LOG_MAX_PER_WINDOW + 3; i++) {
            shown.push(allowLegLogLine(state, 1_000 + i * 5_000));
        }
        assert.deepEqual(shown, [...Array(LEG_LOG_MAX_PER_WINDOW).fill(true), false, false, false]);
        assert.equal(state.suppressed, 3);
    });

    test('reports the hidden count once, only after the window has ended', () => {
        const state = createLegLogState([A], 1_000);
        for (let i = 0; i < LEG_LOG_MAX_PER_WINDOW + 2; i++) allowLegLogLine(state, 1_000 + i);
        assert.equal(takeSuppressedLegLines(state, 1_000 + LEG_LOG_WINDOW_MS - 1), 0);
        assert.equal(takeSuppressedLegLines(state, 1_000 + LEG_LOG_WINDOW_MS), 2);
        assert.equal(takeSuppressedLegLines(state, 1_000 + LEG_LOG_WINDOW_MS + 1), 0);
    });

    test('lets lines through again in the next window', () => {
        const state = createLegLogState([A], 0);
        for (let i = 0; i < LEG_LOG_MAX_PER_WINDOW; i++) allowLegLogLine(state, i);
        assert.equal(allowLegLogLine(state, 10), false);
        assert.equal(allowLegLogLine(state, LEG_LOG_WINDOW_MS + 1), true);
    });

    test('survives the clock stepping back', () => {
        const state = createLegLogState([A], 100_000);
        for (let i = 0; i < LEG_LOG_MAX_PER_WINDOW; i++) allowLegLogLine(state, 100_000 + i);
        assert.equal(allowLegLogLine(state, 50_000), true);
    });

    test('words the summary for one and for several', () => {
        assert.match(suppressedLegLinesMessage(1), /^1 more bonded leg change in the last minute/);
        assert.match(suppressedLegLinesMessage(5), /^5 more bonded leg changes in the last minute/);
    });
});

describe('noteLegHealth', () => {
    const fresh = () => ({ health: 'ok', betterSinceMs: null });

    test('a worsening is a change at once, the same level is not', () => {
        const logged = fresh();
        assert.equal(noteLegHealth(logged, 'ok', 0), null);
        assert.deepEqual(noteLegHealth(logged, 'warn', 1000), {
            from: 'ok',
            to: 'warn',
            event: 'leg_degraded',
        });
        assert.equal(noteLegHealth(logged, 'warn', 2000), null);
        assert.deepEqual(noteLegHealth(logged, 'error', 3000), {
            from: 'warn',
            to: 'error',
            event: 'leg_failed',
        });
    });

    test('an improvement counts only once held, and any setback starts the wait again', () => {
        const logged = { health: 'error', betterSinceMs: null };
        assert.equal(noteLegHealth(logged, 'warn', 0), null);
        assert.equal(noteLegHealth(logged, 'warn', LEG_RECOVERY_HOLD_MS - 1), null);
        // Back to the logged level: the wait is over, nothing was said.
        assert.equal(noteLegHealth(logged, 'error', LEG_RECOVERY_HOLD_MS), null);
        assert.equal(noteLegHealth(logged, 'warn', LEG_RECOVERY_HOLD_MS + 1000), null);
        assert.deepEqual(noteLegHealth(logged, 'ok', LEG_RECOVERY_HOLD_MS * 2 + 1000), {
            from: 'error',
            to: 'ok',
            event: 'leg_recovered',
        });
        assert.equal(logged.health, 'ok');
    });

    test('says what happened to which link', () => {
        const prefix = 'Bonded leg 10.0.0.1:4000';
        assert.equal(
            legHealthMessage(
                prefix,
                { from: 'ok', to: 'warn', event: 'leg_degraded' },
                'Leg is slow.',
            ),
            'Bonded leg 10.0.0.1:4000: Leg is slow.',
        );
        assert.equal(
            legHealthMessage(prefix, { from: 'error', to: 'ok', event: 'leg_recovered' }, null),
            'Bonded leg 10.0.0.1:4000: back to normal (was failing)',
        );
    });
});
