'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
    matchesName,
    affectedOutputCount,
    countLabel,
    searchBoxHtml,
    noMatchRowHtml,
} = require('../public/ts/core/overview-filter');

describe('matchesName (overview search)', () => {
    test('an empty or blank query matches everything', () => {
        assert.equal(matchesName('', 'Studio 07'), true);
        assert.equal(matchesName('   ', 'Studio 07'), true);
    });

    test('matches part of a name, ignoring case and surrounding spaces', () => {
        assert.equal(matchesName('studio', 'Studio 07'), true);
        assert.equal(matchesName('  07 ', 'Studio 07'), true);
        assert.equal(matchesName('hall', 'Studio 07'), false);
    });

    test('matches when any one of the names matches', () => {
        // An output row shows "pipeline · output": either part is searchable.
        assert.equal(matchesName('youtube', 'Studio 07', 'YouTube EN'), true);
        assert.equal(matchesName('studio', 'Studio 07', 'YouTube EN'), true);
        assert.equal(matchesName('twitch', 'Studio 07', 'YouTube EN'), false);
    });

    test('treats the query as plain text, not a pattern', () => {
        assert.equal(matchesName('(', 'Hall (east)'), true);
        assert.equal(matchesName('.*', 'Hall 01'), false);
        assert.equal(matchesName('[', 'Hall 01'), false);
    });
});

describe('affectedOutputCount (offline inputs in the Issues view)', () => {
    test('an offline input counts the outputs that are in trouble because of it', () => {
        assert.equal(affectedOutputCount('off', ['warn', 'warn', 'error', 'off', 'good']), 3);
    });

    test('an offline input with only stopped outputs affects nothing', () => {
        assert.equal(affectedOutputCount('off', ['off', 'off']), 0);
    });

    test('a connected input is judged by its own status, so it adds nothing', () => {
        assert.equal(affectedOutputCount('good', ['warn', 'error']), 0);
        assert.equal(affectedOutputCount('warn', ['warn']), 0);
    });
});

describe('countLabel (table heading badges)', () => {
    test('shows the total when nothing is hidden', () => {
        assert.equal(countLabel(500, 500), '500');
    });

    test('shows how many of the total a filter or search leaves', () => {
        assert.equal(countLabel(20, 500), '20 of 500');
        assert.equal(countLabel(0, 50), '0 of 50');
    });
});

describe('searchBoxHtml and noMatchRowHtml escape what the user typed', () => {
    test('the query cannot break out of the value attribute', () => {
        const html = searchBoxHtml('ov-search-inputs', 'Search inputs by name', '"><img src=x>');
        assert.ok(!html.includes('<img'));
        assert.ok(html.includes('value="&quot;&gt;&lt;img src=x&gt;"'));
        assert.ok(html.includes('id="ov-search-inputs"'));
    });

    test('the empty-table message quotes the query safely', () => {
        const html = noMatchRowHtml(9, 'outputs', '<script>alert(1)</script>');
        assert.ok(!html.includes('<script>'));
        assert.ok(html.includes('colspan="9"'));
        assert.ok(html.includes('No outputs match'));
    });
});
