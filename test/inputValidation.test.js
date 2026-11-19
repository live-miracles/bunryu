'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
    parseName,
    parseWatchUrl,
    isCleanUrlText,
    isValidPublicHost,
    MAX_AUDIO_TRACKS,
} = require('../src/utils/inputLimits');
const { validateOutputUrl, validateAudioEncoding } = require('../src/utils/ffmpeg');

describe('parseWatchUrl', () => {
    test('none is an empty link, and a link is trimmed', () => {
        for (const none of [undefined, null, '', '   ']) {
            assert.deepEqual(parseWatchUrl(none), { watchUrl: '' });
        }
        assert.deepEqual(parseWatchUrl(' https://www.youtube.com/watch?v=abc '), {
            watchUrl: 'https://www.youtube.com/watch?v=abc',
        });
        assert.deepEqual(parseWatchUrl('http://example.com/live'), {
            watchUrl: 'http://example.com/live',
        });
    });

    test('only a clean http(s) link is accepted', () => {
        const bad = [
            'javascript:alert(1)',
            'data:text/html,x',
            'rtmp://a/b',
            'youtube.com/watch',
            'https://a b',
            'https://a/"x',
            'https://a/<b>',
            'https://a/\nb',
            `https://example.com/${'x'.repeat(2100)}`,
            42,
            {},
        ];
        for (const value of bad) assert.ok('error' in parseWatchUrl(value), String(value));
    });
});

describe('parseName', () => {
    test('trims and accepts an ordinary name', () => {
        assert.deepEqual(parseName('  Main stage  '), { name: 'Main stage' });
    });

    test('rejects empty, non-string, over-long and control-character names', () => {
        assert.ok('error' in parseName(''));
        assert.ok('error' in parseName('   '));
        assert.ok('error' in parseName(undefined));
        assert.ok('error' in parseName({ trim: () => 'x' }));
        assert.ok('error' in parseName('x'.repeat(81)));
        assert.ok('error' in parseName('line\nbreak'));
        assert.deepEqual(parseName('x'.repeat(80)), { name: 'x'.repeat(80) });
    });

    test('markup is allowed in a name (the dashboard escapes it), but bounded', () => {
        assert.deepEqual(parseName('<b>Q&A</b>'), { name: '<b>Q&A</b>' });
    });
});

describe('destination URL text', () => {
    test('refuses markup, whitespace, control characters and huge URLs', () => {
        for (const url of [
            'rtmp://<svg onload=a()>',
            'rtmp://host/live/"onmouseover=x',
            'rtmp://host/live/a b',
            'rtmp://host/live/a\nb',
            `rtmp://host/${'a'.repeat(2100)}`,
        ]) {
            assert.equal(isCleanUrlText(url), false, url);
            assert.equal(validateOutputUrl(url), false, url);
        }
    });

    test('ordinary destinations still validate', () => {
        for (const url of [
            'rtmp://a.rtmp.youtube.com/live2/abcd-1234',
            'rtmps://live-api-s.facebook.com:443/rtmp/FB-1?s_bl=1&s_sml=3',
            'srt://10.0.0.7:9000?mode=caller&latency=240&streamid=#!::r=live/x,m=publish',
        ]) {
            assert.equal(validateOutputUrl(url), true, url);
        }
    });
});

describe('validateAudioEncoding bounds', () => {
    test('accepts track indexes below the maximum and rejects the rest', () => {
        assert.equal(validateAudioEncoding('0,1,2'), '0,1,2');
        assert.equal(validateAudioEncoding(String(MAX_AUDIO_TRACKS - 1)), '49');
        assert.equal(validateAudioEncoding(String(MAX_AUDIO_TRACKS)), null);
        assert.equal(validateAudioEncoding('99999999999'), null);
    });

    test('a huge comma list cannot become a huge FFmpeg argv', () => {
        const many = Array.from({ length: 200_000 }, () => '0').join(',');
        assert.equal(validateAudioEncoding(many), null);
        const fifty = Array.from({ length: 50 }, (_, i) => String(i)).join(',');
        assert.equal(validateAudioEncoding(fifty), fifty);
    });
});

describe('isValidPublicHost', () => {
    test('accepts hostnames and IPs, rejects markup and over-long values', () => {
        for (const host of ['stream.example.com', '203.0.113.5', '[2001:db8::1]', 'localhost']) {
            assert.equal(isValidPublicHost(host), true, host);
        }
        for (const host of ['<script>', 'a b', 'x'.repeat(300), "a'b", 'a/b']) {
            assert.equal(isValidPublicHost(host), false, host);
        }
    });
});
