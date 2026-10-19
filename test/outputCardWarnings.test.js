'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { renderOutputCard } = require('../public/ts/features/output-card');

const output = (over) => ({
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
    translation: null,
    url: 'rtmp://a.example/live/key',
    ...over,
});
const rtmpInput = { connected: true, isSrt: false, audioTracks: [] };
const deps = { outStatus: () => 'good', pendingOutputs: new Set(), formatUptime: () => '' };
const render = (over, input = rtmpInput) => renderOutputCard(output(over), input, new Map(), deps);

describe('RTMP input with Track 1 audio on an RTMP output', () => {
    test('warns that the audio is re-encoded and copy is cheaper', () => {
        const html = render({ audioEncoding: '0' });

        assert.match(html, /re-encodes the audio/);
        assert.match(html, /use copy/);
    });

    test('copy audio has no such warning', () => {
        assert.ok(!/re-encodes the audio/.test(render({ audioEncoding: 'copy' })));
    });

    test('an SRT input is not affected (it needs the track selection)', () => {
        const html = render({ audioEncoding: '0' }, { ...rtmpInput, isSrt: true });

        assert.ok(!/re-encodes the audio/.test(html));
    });

    test('an SRT destination is not affected', () => {
        const html = render({ audioEncoding: '0', url: 'srt://b.example:9000?mode=caller' });

        assert.ok(!/re-encodes the audio/.test(html));
    });

    test('no warning while the input is not connected', () => {
        const html = render({ audioEncoding: '0' }, { ...rtmpInput, connected: false });

        assert.ok(!/re-encodes the audio/.test(html));
    });
});

describe('output stopped after repeated failed attempts', () => {
    const stoppedAfterFailures = (over) =>
        render({
            desiredState: 'stopped',
            status: 'stopped',
            hasErrorHistory: true,
            lastError: `${Date.now()}\nStopped after 5 failed attempts. Last error: Connection refused`,
            lastErrorAt: Date.now(),
            ...over,
        });

    test('keeps the error line, in red, while the output stays stopped', () => {
        const html = stoppedAfterFailures();

        assert.match(
            html,
            /<span class="text-xs text-error truncate">Stopped after 5 failed attempts\. Last error: Connection refused<\/span>/,
        );
        assert.match(html, /text-error[^>]*data-action="error-info"/);
    });

    test('a plainly stopped output shows no error line', () => {
        const html = stoppedAfterFailures({ lastError: null, lastErrorAt: null });

        assert.ok(!/Stopped after/.test(html));
        assert.ok(!/text-xs text-error truncate/.test(html));
    });
});

describe('duplicate destination', () => {
    test('is labelled on the card, not only in the hover tooltip', () => {
        const url = 'rtmp://a.example/live/key';
        const dups = new Map([[url, [{ pipelineName: 'Other', outputName: 'YT' }]]]);
        const html = renderOutputCard(output({ url }), rtmpInput, dups, deps);
        const visible = html.replace(/<div class="js-tooltip-content[\s\S]*?<\/div><\/span>/g, '');

        assert.match(visible, /Duplicate/);
    });
});
