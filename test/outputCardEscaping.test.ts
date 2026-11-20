import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOutputCard } from '../public/ts/features/output-card';
import { state } from '../public/ts/core/state';
import { withInputVerdict, withVerdict } from './helpers/verdicts';
import type { InputHealth, OutputView, Pipeline } from '../public/ts/types';

type OutputFixture = Partial<OutputView> & { url: string };

const output = (url: string): OutputFixture => ({
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
const input: { connected: boolean; isSrt: boolean; audioTracks: never[]; live?: boolean } = {
    connected: false,
    isSrt: false,
    audioTracks: [],
};
const deps = { pendingOutputs: new Set<string>() };
// The card reads many more fields than these fixtures set, so the partial view and input
// are cast to the real types here, once.
const inputView = () => withInputVerdict(input) as unknown as InputHealth;
const card = (view: OutputFixture) =>
    renderOutputCard(
        withVerdict(view, input) as unknown as OutputView,
        inputView(),
        new Map(),
        deps,
    );
const render = (url: string) => card(output(url));

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
                } as Pipeline,
            ],
        };

        const html = render('rtmp://localhost:21935/live/key01_x');

        assert.ok(!html.includes('<img'), html);
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
        state.config = {};
    });

    test('an output name containing markup is shown as text', () => {
        const html = card({
            ...output('rtmp://h/live/k'),
            name: '"><script>x()</script>',
        });

        assert.ok(!html.includes('<script>'), html);
    });
});

describe('output card history button', () => {
    const history = (over: Partial<OutputView>) =>
        card({ ...output('rtmp://x/y'), hasErrorHistory: true, ...over } as Partial<OutputView> & {
            url: string;
        });
    const button = (html: string) => {
        const found = html.match(/<button[^>]*data-action="error-info"[^>]*>/);
        assert.ok(found, 'no error-info button');
        return found[0];
    };

    test('is red while the latest record is a crash', () => {
        const html = history({ lastError: `${Date.now()}\nexit=1`, lastErrorAt: Date.now() });
        assert.match(button(html), /text-error/);
    });

    test('keeps the normal color when the history has no current crash, e.g. after a stop', () => {
        const html = history({ lastError: null, lastErrorAt: null });
        assert.ok(button(html).includes('data-action="error-info"'));
        assert.ok(!/text-error/.test(button(html)));
    });

    describe('watch link', () => {
        const renderWatch = (watchUrl: string | undefined) =>
            card({ ...output('rtmp://h/live/k'), watchUrl } as Partial<OutputView> & {
                url: string;
            });

        test('an http(s) link is a new-tab link with the URL shown as text', () => {
            const html = renderWatch('https://www.youtube.com/watch?v=a&b="x"');

            assert.ok(
                html.includes('href="https://www.youtube.com/watch?v=a&amp;b=&quot;x&quot;"'),
            );
            assert.ok(html.includes('target="_blank"'));
            assert.ok(html.includes('rel="noopener noreferrer"'));
        });

        test('no link, or one that is not http(s), shows no link', () => {
            for (const watchUrl of [undefined, '', 'javascript:alert(1)', 'data:text/html,x']) {
                assert.ok(!renderWatch(watchUrl).includes('target="_blank"'), String(watchUrl));
            }
        });
    });
});
