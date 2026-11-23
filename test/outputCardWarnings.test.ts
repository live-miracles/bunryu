import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOutputCard } from '../public/ts/features/output-card';
import type { DupRef } from '../public/ts/core/output-advice';
import type { InputHealth, OutputView } from '../public/ts/types';
import { withInputVerdict, withVerdict } from './helpers/verdicts';

const output = (over: Partial<OutputView> = {}): Partial<OutputView> => ({
    id: '1-1',
    name: 'o',
    desiredState: 'running',
    status: 'running',
    videoEncoding: 'copy',
    audioEncoding: 'copy',
    failures: 0,
    nextRetryAtMs: null,
    lastError: null,
    lastErrorAt: null,
    hasErrorHistory: false,
    warningReason: null,
    startedAtMs: null,
    bitrateKbps: 5000,
    url: 'rtmp://a.example/live/key',
    ...over,
});
const rtmpInput = { connected: true, live: true, isSrt: false, audioTracks: [] };
const deps = { pendingOutputs: new Set<string>() };
// The fixtures set only the fields the card reads, so they meet the card's real view
// types here, in one place.
const card = (out: object, input: object, dupUrls: Map<string, DupRef[]>, cardDeps: typeof deps) =>
    renderOutputCard(
        out as unknown as OutputView,
        input as unknown as InputHealth,
        dupUrls,
        cardDeps,
    );
const render = (over: Partial<OutputView>, input = rtmpInput) =>
    card(withVerdict(output(over), input), withInputVerdict(input), new Map(), deps);

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

describe('a yellow status dot always says why', () => {
    // A copy output sending far less than the input: the dot is yellow because of the
    // low bitrate, so the card names it on a line and in the dot's hover text.
    test('a low bitrate is a warning line and the dot has a tooltip with it', () => {
        const html = render({ bitrateKbps: 58 });

        assert.match(
            html,
            /text-xs text-warning[^>]*>Output bitrate is 58 kb\/s, below 200 kb\/s\./,
        );
        assert.match(
            html,
            /<span class="js-tooltip[^"]*"[^>]*><div aria-label="status"[^>]*><\/div><div class="js-tooltip-content hidden">.*Output bitrate is 58 kb\/s, below 200 kb\/s\./,
        );
    });

    test('a warning the output reports itself is listed once', () => {
        const html = render({ warningReason: 'Timestamps are jumping' });

        assert.equal(html.match(/<span class="text-warning shrink-0">/g)?.length, 1); // one card line
        assert.match(
            html,
            /<div aria-label="status"[^>]*><\/div><div class="js-tooltip-content hidden">.*Timestamps are jumping/,
        );
    });

    test('a healthy output has a plain dot and no extra line', () => {
        const html = render({ bitrateKbps: 5000 });

        assert.ok(!/js-tooltip-content/.test(html));
        assert.ok(!/text-warning/.test(html));
    });
});

describe('output stopped after repeated failed attempts', () => {
    const stoppedAfterFailures = (over: Partial<OutputView> = {}) =>
        render({
            desiredState: 'stopped',
            status: 'stopped',
            hasErrorHistory: true,
            lastError: `${Date.now()}\nStopped after 5 failed attempts. Last error: Connection refused`,
            lastErrorAt: Date.now(),
            ...over,
        });

    test('has no error line, retry badge or time: one yellow line says it all', () => {
        const html = stoppedAfterFailures({ failures: 5 });

        const lines = warningLines(html);
        assert.equal(lines.length, 1);
        assert.match(
            lines[0],
            /^Stopped after 5 failed attempts\. Check the link and stream key, update the output, then start it again\. Last error: Connection refused$/,
        );
        assert.ok(!/text-xs text-warning shrink-0|badge-/.test(html), 'no time or retry badge');
        assert.ok(!/text-xs text-error/.test(html), 'no red line');
        assert.match(html, /text-warning[^>]*data-action="error-info"/);
        assert.match(html, /Hint: The destination refused the connection/, 'the cause hint');
        assert.ok(!tinted(html));
    });

    test('a plainly stopped output shows no error line', () => {
        const html = stoppedAfterFailures({ lastError: null, lastErrorAt: null });

        assert.ok(!/Stopped after/.test(html));
        assert.ok(!/text-xs text-error truncate/.test(html));
    });
});

// Every yellow line on a card (a runtime warning, or advice about how the output is
// configured) is a warning icon and the message, with the full text in the title. Only a
// runtime warning tints the card and the dot; advice never does.
const warningLines = (html: string) =>
    [...html.matchAll(/<span class="text-xs text-warning truncate[^"]*" title="([^"]*)">/g)].map(
        (m) => m[1],
    );
const tinted = (html: string) => /data-output-card="[^"]*" style="background:color-mix/.test(html);

describe('duplicate destination', () => {
    const url = 'rtmp://a.example/live/key';
    const dups = new Map([
        [url, [{ pipelineName: 'Other', outputName: 'YT' }, { pipelineName: 'Main' }]],
    ]);

    test('is a yellow line naming the other outputs, and does not tint the card', () => {
        const html = card(
            withVerdict(output({ url }), rtmpInput),
            withInputVerdict(rtmpInput),
            dups,
            deps,
        );
        assert.deepEqual(warningLines(html), ['Same destination as Other → YT, Main']);
        assert.ok(!tinted(html));
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
        const html = card(
            withVerdict(output({ url }), rtmpInput),
            withInputVerdict(rtmpInput),
            self,
            deps,
        );
        assert.deepEqual(warningLines(html), ['Same destination as Other → YT']);
    });

    test('no longer marks the URL itself', () => {
        const html = card(
            withVerdict(output({ url }), rtmpInput),
            withInputVerdict(rtmpInput),
            dups,
            deps,
        );
        assert.ok(!/Duplicate/.test(html));
        assert.ok(!/<code class="[^"]*text-warning/.test(html));
    });
});

describe('warnings and advice share one style', () => {
    test('a runtime warning is a warning line and tints the card', () => {
        const html = render({ warningReason: 'High memory usage' });
        assert.deepEqual(warningLines(html), ['High memory usage']);
        assert.ok(tinted(html));
    });

    test('runtime, then duplicate destination, then audio advice, each on its own line', () => {
        const url = 'rtmp://a.example/live/key';
        const dups = new Map([[url, [{ pipelineName: 'Other', outputName: 'YT' }]]]);
        const html = card(
            withVerdict(
                output({ url, warningReason: 'High memory usage', audioEncoding: '1' }),
                rtmpInput,
            ),
            withInputVerdict(rtmpInput),
            dups,
            deps,
        );
        const lines = warningLines(html);
        assert.equal(lines.length, 3);
        assert.equal(lines[0], 'High memory usage');
        assert.equal(lines[1], 'Same destination as Other → YT');
        assert.match(lines[2], /only has one audio track/);
    });

    test('advice is a yellow line that never tints the card', () => {
        for (const audioEncoding of ['0', '1']) {
            const html = render({ audioEncoding });
            assert.equal(warningLines(html).length, 1, audioEncoding);
            assert.ok(!tinted(html), audioEncoding);
        }
        // With a runtime warning too, both show and the warning is what tints.
        const both = render({ audioEncoding: '0', warningReason: 'High memory usage' });
        assert.equal(warningLines(both).length, 2);
        assert.ok(tinted(both));
    });

    test('the status dot has no text for advice, only for warnings', () => {
        const dotText = (html: string) =>
            html.match(
                /aria-label="status"[\s\S]*?js-tooltip-content hidden">([\s\S]*?)<\/div><\/span>/,
            )?.[1];
        assert.equal(dotText(render({ audioEncoding: '0' })), undefined);
        assert.equal(dotText(render({ audioEncoding: '1' })), undefined);
        assert.match(dotText(render({ warningReason: 'High memory usage' })) ?? '', /High memory/);
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

describe('card buttons', () => {
    test('History, Edit and Delete take no room until the card is hovered or focused, but stay on a touch screen', () => {
        const html = render({});
        const tools =
            /<div class="([^"]*)">\s*(?:<button[^>]*error-info[^>]*>[^]*?<\/button>\s*)?<button[^>]*data-action="edit"/.exec(
                html,
            );
        assert.ok(tools, 'the tools container is found');
        assert.match(tools[1], /\[@media\(hover:hover\)\]:hidden/);
        assert.match(tools[1], /group-hover\/out:flex/);
        assert.match(tools[1], /group-focus-within\/out:flex/);
        assert.match(html, /class="[^"]*\bgroup\/out\b[^"]*" draggable="true" data-output-card=/);
    });
});

describe('narrow screens', () => {
    test('a long output name truncates inside the card instead of overflowing it', () => {
        const html = render({ name: 'Long_Name_For_A_Very_Long_Destination_Output' });
        assert.match(html, /<span class="min-w-0 truncate" title="Long_Name/);
        // The whole card drags, not just its name.
        assert.match(html, /draggable="true" data-output-card="/);
        assert.match(
            html,
            /<div class="flex items-center gap-2 min-w-0 max-w-full font-semibold">/,
        );
    });

    test('warning lines wrap on a phone, where there is no hover to read the full text', () => {
        const html = render({ warningReason: 'High memory usage' });
        assert.match(html, /text-warning truncate max-lg:whitespace-normal/);
    });
});

describe('error line', () => {
    const message =
        'Stopped after 22 failed attempts. Last error: Error opening output files: Input/output error';
    // A crash being retried: red (a stopped output's error is yellow).
    const errored = () =>
        render({ status: 'failed', failures: 2, lastError: message, lastErrorAt: 1 });

    test('carries the full text in its title, since the line is truncated', () => {
        assert.match(
            errored(),
            /<span class="text-xs text-error truncate[^"]*" title="Stopped after 22 failed attempts\. Last error: Error opening output files: Input\/output error">/,
        );
    });

    test('wraps on a phone, where there is no hover to read the title', () => {
        assert.match(errored(), /text-error truncate max-lg:whitespace-normal/);
    });

    test('escapes markup in the title', () => {
        const html = render({ lastError: 'bad "quote" <b>', lastErrorAt: 1 });
        assert.match(html, /title="bad &quot;quote&quot; &lt;b&gt;"/);
    });
});

describe('card tint follows the most severe problem', () => {
    const tintOf = (html: string) => {
        const dot =
            /data-output-card="[^"]*" style="background:color-mix\(in oklab, var\(--dot-(bad|warn)\)/.exec(
                html,
            )?.[1];
        return dot === 'bad' ? 'error' : dot === 'warn' ? 'warning' : null;
    };
    const erroredCard = (over = {}) =>
        render({
            status: 'failed',
            failures: 2,
            lastError: 'ffmpeg exited with code 1',
            lastErrorAt: 1,
            ...over,
        });
    const stoppedAfterFailures = (over = {}) =>
        render({
            desiredState: 'stopped',
            status: 'stopped',
            lastError: 'Stopped after 5 failed attempts. Last error: Connection refused',
            lastErrorAt: 1,
            ...over,
        });

    test('a current error tints the card red', () => {
        assert.equal(tintOf(erroredCard()), 'error');
    });

    test('a stop after repeated failures does not tint it', () => {
        assert.equal(tintOf(stoppedAfterFailures()), null);
        // With a warning of its own, that is what tints it, in yellow.
        assert.equal(
            tintOf(stoppedAfterFailures({ warningReason: 'High memory usage' })),
            'warning',
        );
    });
    test('a crash being retried tints it red', () => {
        const html = render({
            lastError: 'ffmpeg exited with code 1',
            lastErrorAt: 1,
            failures: 2,
        });
        assert.equal(tintOf(html), 'error');
    });

    test('an error status with no error text still tints it red', () => {
        const html = render({ status: 'failed' });
        assert.equal(tintOf(html), 'error');
    });

    test('red wins over warnings, which stay visible inside the card', () => {
        const html = erroredCard({ audioEncoding: '1' });
        assert.equal(tintOf(html), 'error');
        assert.match(warningLines(html).join('\n'), /only has one audio track/);
    });

    test('warnings alone tint it yellow', () => {
        assert.equal(tintOf(render({ warningReason: 'High memory usage' })), 'warning');
    });

    test('a plainly stopped or healthy output is not tinted', () => {
        assert.equal(tintOf(render({})), null);
        assert.equal(
            tintOf(render({ desiredState: 'stopped', status: 'stopped', lastError: null })),
            null,
        );
    });
});

describe('hints on the output card', () => {
    test('a known last error gets a hint line under it', () => {
        const html = render({
            status: 'failed',
            lastError: '1700000000000\nrtmp://a.example/live/key: Connection refused',
            lastErrorAt: 1700000000000,
        });
        assert.match(html, /Connection refused/);
        assert.match(html, /refused the connection/i);
        // The advice is in the info tooltip on the error line, not a line of its own.
        assert.match(html, /js-tooltip-content[^]*Hint:[^]*refused the connection/i);
    });

    test('an unknown last error gets no hint', () => {
        const html = render({
            status: 'failed',
            lastError: '1700000000000\nsomething entirely different',
            lastErrorAt: 1700000000000,
        });
        assert.doesNotMatch(html, /Hint:/);
    });

    test('a falling-behind warning gets a hint', () => {
        const html = render({
            warningReason:
                'Output is running at 0.62x realtime and falling behind live (slow encode or destination, or the input is delivering slowly).',
        });
        assert.match(html, /Hint:/);
    });

    test('the hint is in the info icon only, not in the status dot’s hover text', () => {
        const html = render({
            warningReason:
                'Output is running at 0.62x realtime and falling behind live (slow encode or destination, or the input is delivering slowly).',
        });
        assert.equal(html.match(/>Hint: /g)?.length, 1);
    });
});

describe('when a warning started', () => {
    const startedAt = Date.now() - 185_000;

    test('the card shows "since 3 min ago" next to the warning, with the exact time on hover', () => {
        const html = render({
            warningReason: 'Output is running at 0.62x realtime and falling behind live.',
            warningSinceMs: startedAt,
        });
        assert.match(html, /since 3 min ago/);
        assert.match(html, /title="[^"]*\d[^"]*">since/);
    });

    test('a warning without a start time shows none', () => {
        const html = render({
            warningReason: 'Output is running at 0.62x realtime and falling behind live.',
            warningSinceMs: null,
        });
        assert.doesNotMatch(html, /since \d/);
    });

    test('other warnings on the card get no time', () => {
        const html = render({ warningSinceMs: startedAt, warningReason: null, audioEncoding: '0' });
        assert.doesNotMatch(html, /since \d/);
    });
});
