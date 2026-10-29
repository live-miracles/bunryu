'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { renderOutputCard } = require('../public/ts/features/output-card');
const { state } = require('../public/ts/core/state');

const output = (url) => ({
    id: '1-1',
    name: 'o',
    desiredState: 'running',
    status: 'running',
    videoEncoding: 'copy',
    audioEncoding: 'copy',
    failures: 0,
    lastError: null,
    lastErrorAt: null,
    hasErrorHistory: false,
    warningReason: null,
    startedAtMs: null,
    url,
});
const input = { connected: false, isSrt: false, audioTracks: [] };
const deps = { outStatus: () => 'good', pendingOutputs: new Set(), formatUptime: () => '' };
const render = (url) => renderOutputCard(output(url), input, new Map(), deps);

describe('output card escaping', () => {
    test('a destination URL containing markup is shown as text', () => {
        const html = render('rtmp://<svg onload=a()>');

        assert.ok(!html.includes('<svg onload'), html);
        assert.ok(html.includes('&lt;svg onload=a()&gt;'));
    });

    test('a pipeline name shown as a restream sink label is shown as text', () => {
        state.config = {
            pipelines: [
                {
                    name: '<img src=x onerror=alert(1)>',
                    rtmpPublishUrlLocal: 'rtmp://localhost:21935/live/key01_x',
                    srtPublishUrlLocal: 'srt://localhost:10080?x',
                },
            ],
        };

        const html = render('rtmp://localhost:21935/live/key01_x');

        assert.ok(!html.includes('<img'), html);
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
        state.config = {};
    });

    test('an output name containing markup is shown as text', () => {
        const html = renderOutputCard(
            { ...output('rtmp://h/live/k'), name: '"><script>x()</script>' },
            input,
            new Map(),
            deps,
        );

        assert.ok(!html.includes('<script>'), html);
    });
});

describe('output card history button', () => {
    const history = (over) =>
        renderOutputCard(
            { ...output('rtmp://x/y'), hasErrorHistory: true, ...over },
            input,
            new Map(),
            deps,
        );
    const button = (html) => html.match(/<button[^>]*data-action="error-info"[^>]*>/)[0];

    test('is red while the latest record is a crash', () => {
        const html = history({ lastError: `${Date.now()}\nexit=1`, lastErrorAt: Date.now() });
        assert.match(button(html), /text-error/);
    });

    test('keeps the normal color when the history has no current crash, e.g. after a stop', () => {
        const html = history({ lastError: null, lastErrorAt: null });
        assert.ok(button(html).includes('data-action="error-info"'));
        assert.ok(!/text-error/.test(button(html)));
    });
});
