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

    test('finds an output by its full destination URL or the stream key inside it', () => {
        const url = 'rtmp://a.rtmp.youtube.com/live2/abcd-1234-efgh';
        assert.equal(matchesName(url, 'Studio 07', 'YouTube EN', url), true);
        assert.equal(matchesName('abcd-1234', 'Studio 07', 'YouTube EN', url), true);
        assert.equal(matchesName('abcd-9999', 'Studio 07', 'YouTube EN', url), false);
    });

    test('an input is found by its stream key or publish URL', () => {
        const names = ['Studio 07', 'key07_ab12', 'rtmp://live.example:1935/live/key07_ab12'];
        assert.equal(matchesName('KEY07_AB12', ...names), true);
        assert.equal(matchesName('live.example:1935/live/key07', ...names), true);
        assert.equal(matchesName('key08', ...names), false);
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

describe('status tally (pipeline row and group header badges)', () => {
    const {
        tallyStatuses,
        worstOfTally,
        isProblem,
        isOffline,
    } = require('../public/ts/core/overview-filter');

    test('counts each status on its own', () => {
        assert.deepEqual(tallyStatuses(['good', 'good', 'warn', 'error', 'off', 'off']), {
            good: 2,
            warn: 1,
            error: 1,
            off: 2,
        });
        assert.deepEqual(tallyStatuses([]), { good: 0, warn: 0, error: 0, off: 0 });
    });

    test('the worst status wins: error, then warning, then good, then off', () => {
        assert.equal(worstOfTally(tallyStatuses(['good', 'warn', 'error'])), 'error');
        assert.equal(worstOfTally(tallyStatuses(['good', 'warn', 'off'])), 'warn');
        assert.equal(worstOfTally(tallyStatuses(['good', 'off'])), 'good');
        assert.equal(worstOfTally(tallyStatuses(['off', 'off'])), 'off');
        assert.equal(worstOfTally(tallyStatuses([])), 'off');
    });

    test('only a warning or an error is a problem, only off is offline', () => {
        assert.deepEqual(['good', 'warn', 'error', 'off'].map(isProblem), [
            false,
            true,
            true,
            false,
        ]);
        assert.deepEqual(['good', 'warn', 'error', 'off'].map(isOffline), [
            false,
            false,
            false,
            true,
        ]);
    });
});
