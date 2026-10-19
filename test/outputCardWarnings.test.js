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

// Every output warning (runtime, duplicate destination, encoding advice) is the
// same kind of line: a warning icon and the message, with the full text in the
// title, and any of them tints the card.
const warningLines = (html) =>
    [...html.matchAll(/<span class="text-xs text-warning truncate" title="([^"]*)">/g)].map(
        (m) => m[1],
    );
const tinted = (html) => /data-output-card="[^"]*" style="background:color-mix/.test(html);

describe('duplicate destination', () => {
    const url = 'rtmp://a.example/live/key';
    const dups = new Map([
        [
            url,
            [
                { pipelineName: 'Other', outputName: 'YT' },
                { pipelineName: 'Main', outputName: null },
            ],
        ],
    ]);

    test('is a warning line naming the other outputs, with the card tinted', () => {
        const html = renderOutputCard(output({ url }), rtmpInput, dups, deps);
        assert.deepEqual(warningLines(html), ['Same destination as Other → YT, Main']);
        assert.ok(tinted(html));
    });

    test('leaves the output itself out of the list', () => {
        const self = new Map([
            [
                url,
                [
                    { pipelineName: 'Main', outputName: 'o', outputId: '1-1' },
                    { pipelineName: 'Other', outputName: 'YT', outputId: '2-1' },
                ],
            ],
        ]);
        const html = renderOutputCard(output({ url }), rtmpInput, self, deps);
        assert.deepEqual(warningLines(html), ['Same destination as Other → YT']);
    });

    test('no longer marks the URL itself', () => {
        const html = renderOutputCard(output({ url }), rtmpInput, dups, deps);
        assert.ok(!/Duplicate/.test(html));
        assert.ok(!/<code class="[^"]*text-warning/.test(html));
    });
});

describe('all output warnings share one style', () => {
    test('a runtime warning is a warning line and tints the card', () => {
        const html = render({ warningReason: 'High memory usage' });
        assert.deepEqual(warningLines(html), ['High memory usage']);
        assert.ok(tinted(html));
    });

    test('runtime, then duplicate, then encoding warnings, each on its own line', () => {
        const url = 'rtmp://a.example/live/key';
        const dups = new Map([[url, [{ pipelineName: 'Other', outputName: 'YT' }]]]);
        const html = renderOutputCard(
            output({ url, warningReason: 'High memory usage', audioEncoding: '0' }),
            rtmpInput,
            dups,
            deps,
        );
        const lines = warningLines(html);
        assert.equal(lines.length, 3);
        assert.equal(lines[0], 'High memory usage');
        assert.equal(lines[1], 'Same destination as Other → YT');
        assert.match(lines[2], /re-encodes the audio/);
    });

    test('an output with no warnings is not tinted', () => {
        assert.ok(!tinted(render({})));
    });
});

describe('card layout and controls', () => {
    test('the destination URL shrinks and truncates so the action icons stay on its row', () => {
        const html = render({});
        assert.match(html, /<code class="[^"]*\bmin-w-0\b[^"]*\bflex-1\b[^"]*\btruncate\b/);
    });

    test('icon-only edit and delete buttons say what they do', () => {
        const html = render({});
        assert.match(html, /data-action="edit"[^>]*title="Edit output" aria-label="Edit output"/);
        assert.match(
            html,
            /data-action="delete"[^>]*title="Delete output" aria-label="Delete output"/,
        );
    });
});
