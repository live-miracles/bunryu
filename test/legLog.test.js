'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    LEG_LOG_MAX_PER_WINDOW,
    LEG_LOG_WINDOW_MS,
    allowLegLogLine,
    createLegLogState,
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
