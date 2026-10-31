'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    EVENT_SUMMARY_MAX,
    eventsForDisplay,
    summarizeEventMessage,
} = require('../public/ts/core/events');

describe('summarizeEventMessage', () => {
    test('a short single line is shown as it is', () => {
        assert.deepEqual(summarizeEventMessage('Input disconnected'), {
            summary: 'Input disconnected',
            expandable: false,
        });
    });

    test('an empty message has nothing to show or expand', () => {
        assert.deepEqual(summarizeEventMessage(''), { summary: '', expandable: false });
        assert.deepEqual(summarizeEventMessage('  \n \n'), { summary: '', expandable: false });
    });

    test('a multi-line message shows its first line and can be expanded', () => {
        const message =
            'Shared encode T1 failed: exit=224\n[h264 @ 0x1] decode_slice_header error\n[h264 @ 0x1] no frame!';
        assert.deepEqual(summarizeEventMessage(message), {
            summary: 'Shared encode T1 failed: exit=224',
            expandable: true,
        });
    });

    test('blank lines before the first line are skipped', () => {
        assert.equal(summarizeEventMessage('\n\n  first\nsecond').summary, 'first');
    });

    test('runs of spaces in the line are collapsed', () => {
        assert.equal(summarizeEventMessage('a   b \t c').summary, 'a b c');
    });

    test('a long first line is cut with an ellipsis and can be expanded', () => {
        const line = 'x'.repeat(EVENT_SUMMARY_MAX + 40);
        const { summary, expandable } = summarizeEventMessage(line);
        assert.equal(summary.length, EVENT_SUMMARY_MAX);
        assert.ok(summary.endsWith('...'));
        assert.equal(expandable, true);
    });

    test('a first line of exactly the limit is not cut', () => {
        const line = 'y'.repeat(EVENT_SUMMARY_MAX);
        assert.deepEqual(summarizeEventMessage(line), { summary: line, expandable: false });
    });
});

describe('eventsForDisplay', () => {
    const ev = (ts, source, pipelineId) => ({
        ts,
        source,
        severity: 'info',
        pipelineId,
        pipelineName: pipelineId === null ? null : `P${pipelineId}`,
        outputName: null,
        label: 'x',
        message: '',
    });
    // The API order: newest first.
    const events = [
        ev(4, 'input', 2),
        ev(3, 'server', null),
        ev(2, 'output', 1),
        ev(1, 'input', 1),
    ];

    test('lists the oldest first', () => {
        assert.deepEqual(
            eventsForDisplay(events, 'all').map((e) => e.ts),
            [1, 2, 3, 4],
        );
    });

    test('server only keeps the server events', () => {
        assert.deepEqual(
            eventsForDisplay(events, 'server').map((e) => e.ts),
            [3],
        );
    });

    test('a pipeline filter keeps that pipeline, oldest first', () => {
        assert.deepEqual(
            eventsForDisplay(events, 'p:1').map((e) => e.ts),
            [1, 2],
        );
    });

    test('a pipeline with no events gives an empty list', () => {
        assert.deepEqual(eventsForDisplay(events, 'p:9'), []);
    });

    test('does not reorder the list it is given', () => {
        eventsForDisplay(events, 'all');
        assert.deepEqual(
            events.map((e) => e.ts),
            [4, 3, 2, 1],
        );
    });
});
