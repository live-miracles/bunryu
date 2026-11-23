import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    issueLinesHtml,
    renderStatusTooltip,
    splitDotGradient,
} from '../public/ts/features/status-tooltip';

const half = (over = {}) => ({
    label: 'Input',
    issues: [],
    active: true,
    ok: 'Input is live.',
    off: 'No input.',
    ...over,
});

describe('status dot tooltip', () => {
    test('shows both halves under their headings, in order', () => {
        const html = renderStatusTooltip(half(), half({ label: 'Outputs', ok: 'Running.' }));
        assert.ok(html.indexOf('>Input<') < html.indexOf('>Outputs<'));
        assert.match(html, /Input is live\./);
        assert.match(html, /Running\./);
    });

    test('a half with problems lists them and not its ok line', () => {
        const html = renderStatusTooltip(
            half({ issues: [{ severity: 'error', message: 'No publisher', sinceMs: 0 }] }),
            half({ label: 'Outputs', ok: 'Running.' }),
        );
        assert.match(html, /text-error[^>]*>No publisher</);
        assert.doesNotMatch(html, /Input is live\./);
        assert.match(html, />Outputs</);
    });

    test('an inactive half without problems says why it is off', () => {
        const html = renderStatusTooltip(
            half({ active: false }),
            half({ label: 'Outputs', ok: 'Running.' }),
        );
        assert.match(html, /No input\./);
        assert.doesNotMatch(html, /Input is live\./);
    });

    test('idle replaces the halves with one line', () => {
        const html = renderStatusTooltip(
            half(),
            half({ label: 'Outputs' }),
            'Idle: nothing uses it.',
        );
        assert.match(html, /Idle: nothing uses it\./);
        assert.doesNotMatch(html, />Input<|>Outputs</);
    });

    test('escapes text, and a status dot’s hover text has no hint', () => {
        const html = issueLinesHtml([
            { severity: 'warning', message: '<b>x</b>', hint: 'try <this>' },
        ]);
        assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
        assert.doesNotMatch(html, /Hint|try/);
    });

    test('a card puts the hint behind an info icon', () => {
        const html = issueLinesHtml(
            [{ severity: 'warning', message: 'm', hint: 'try <this>' }],
            'icon',
        );
        assert.match(html, /js-tooltip[^]*Hint: try &lt;this&gt;/);
        assert.equal(
            issueLinesHtml([{ severity: 'warning', message: 'm' }], 'icon').includes('js-tooltip'),
            false,
        );
    });

    test('the Overview shows the hint as a muted line', () => {
        const html = issueLinesHtml([{ severity: 'error', message: 'm', hint: 'h' }], 'inline');
        assert.match(html, /text-muted">Hint: h</);
        assert.doesNotMatch(html, /js-tooltip/);
    });
});

describe('split dot gradient', () => {
    test('left colour, a divider, then the right colour', () => {
        assert.equal(
            splitDotGradient('#111', '#222'),
            'linear-gradient(90deg, #111 0 45%, transparent 45% 55%, #222 55% 100%)',
        );
    });
});
