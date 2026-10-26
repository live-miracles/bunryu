'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePipelines, INPUT_ALERT_CODES } = require('../public/ts/core/pipeline');

const alert = (code) => ({ severity: 'warning', code, message: code, sinceMs: 1 });

function parseWithAlerts(alerts) {
    return parsePipelines(
        {
            pipelines: [{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1, groupId: null }],
            outputs: [],
            layoutOrder: [],
            encodings: ['copy'],
        },
        {
            pipelines: {
                1: {
                    input: {
                        connected: true,
                        live: true,
                        isSrt: false,
                        mediaOk: true,
                        audioTracks: [],
                    },
                    outputs: {},
                    alerts,
                },
            },
        },
    )[0];
}

describe('input-level alerts', () => {
    test('flapping and frame-rate alerts are part of the input', () => {
        const p = parseWithAlerts([
            alert('input-flapping'),
            alert('input-low-framerate'),
            alert('input-high-framerate'),
            alert('srt-packet-loss'),
        ]);
        assert.deepEqual(
            p.input.alerts.map((a) => a.code),
            ['input-flapping', 'input-low-framerate', 'input-high-framerate'],
        );
    });

    test('link-quality alerts stay with the relay views only', () => {
        const p = parseWithAlerts([alert('srt-packet-loss'), alert('relay-forwarding-stalled')]);
        assert.deepEqual(p.input.alerts, []);
        assert.equal(p.alerts.length, 2);
    });

    test('a pipeline with no health yet has no input alerts', () => {
        const [p] = parsePipelines(
            { pipelines: [{ id: 1, name: 'P1', streamKey: 'k', streamKeyId: 1 }], outputs: [] },
            { pipelines: {} },
        );
        assert.deepEqual(p.input.alerts, []);
    });

    test('the code list names exactly the input alerts', () => {
        assert.deepEqual([...INPUT_ALERT_CODES].sort(), [
            'input-flapping',
            'input-high-framerate',
            'input-keyframe-interval',
            'input-low-framerate',
        ]);
    });
});
