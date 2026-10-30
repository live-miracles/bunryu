'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    issueLinesHtml,
    renderStatusTooltip,
    splitDotGradient,
} = require('../public/ts/features/status-tooltip');

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

    test('escapes text and shows a hint', () => {
        const html = issueLinesHtml([
            { severity: 'warning', message: '<b>x</b>', hint: 'try <this>' },
        ]);
        assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
        assert.match(html, /Hint: try &lt;this&gt;/);
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
