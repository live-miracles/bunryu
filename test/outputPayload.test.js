'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseOutputsPayload,
    parseSingleOutputPayload,
} = require('../public/ts/core/output-payload');
const { ansiLineToHtml } = require('../public/ts/core/ansi');

const item = {
    name: ' Main ',
    videoEncoding: 'copy',
    url: 'rtmp://h/app/k',
    audioEncoding: 'copy',
};

describe('parseOutputsPayload', () => {
    test('reads an array and trims the name', () => {
        assert.deepEqual(parseOutputsPayload(JSON.stringify([item])), {
            outputs: [{ ...item, name: 'Main' }],
        });
    });

    test('says why a clipboard is refused', () => {
        const cases = [
            ['nope', 'Clipboard content is not valid JSON.'],
            [JSON.stringify(item), 'Expected a JSON array of outputs.'],
            ['[]', 'No outputs found in clipboard.'],
            ['[null]', 'Invalid output format in clipboard.'],
            [JSON.stringify([{ ...item, name: '  ' }]), 'Each output must have a non-empty name.'],
            [
                JSON.stringify([{ ...item, videoEncoding: 1 }]),
                'Each output must have a videoEncoding.',
            ],
            [JSON.stringify([{ ...item, url: '' }]), 'Each output must have a non-empty url.'],
            [
                JSON.stringify([{ ...item, audioEncoding: undefined }]),
                'Each output must have an audioEncoding.',
            ],
        ];
        for (const [text, error] of cases) {
            assert.deepEqual(parseOutputsPayload(text), { error }, text);
        }
    });

    test('one bad output refuses the whole list', () => {
        const text = JSON.stringify([item, { ...item, url: '' }]);
        assert.deepEqual(parseOutputsPayload(text), {
            error: 'Each output must have a non-empty url.',
        });
    });
});

describe('parseSingleOutputPayload', () => {
    test('a bare destination URL is shorthand for {url}', () => {
        assert.deepEqual(parseSingleOutputPayload(' rtmp://h/app/k\n'), {
            output: {
                name: undefined,
                videoEncoding: undefined,
                url: 'rtmp://h/app/k',
                audioEncoding: undefined,
            },
        });
    });

    test('name and encodings are optional, and blank ones are left out', () => {
        const only = parseSingleOutputPayload('{"url":"srt://h:1","name":" ","audioEncoding":""}');
        assert.deepEqual(only, {
            output: {
                name: undefined,
                videoEncoding: undefined,
                url: 'srt://h:1',
                audioEncoding: undefined,
            },
        });
        assert.deepEqual(parseSingleOutputPayload(JSON.stringify(item)).output, {
            name: 'Main',
            videoEncoding: 'copy',
            url: 'rtmp://h/app/k',
            audioEncoding: 'copy',
        });
    });

    test('says why a clipboard is refused', () => {
        const cases = [
            ['nope', 'Clipboard content is not valid JSON.'],
            ['[]', 'Expected a single output object, not a list.'],
            ['null', 'Expected a single output object, not a list.'],
            ['{"name":"x"}', 'Clipboard JSON must include a non-empty url.'],
        ];
        for (const [text, error] of cases) {
            assert.deepEqual(parseSingleOutputPayload(text), { error }, text);
        }
    });
});

describe('ansiLineToHtml', () => {
    test('colours a coloured stretch and closes it', () => {
        assert.equal(
            ansiLineToHtml('a \x1b[31mERROR\x1b[0m b'),
            'a <span class="text-error">ERROR</span> b',
        );
    });

    test('closes a span still open at the end of the line', () => {
        assert.equal(ansiLineToHtml('\x1b[33mwarn'), '<span class="text-warning">warn</span>');
    });

    test('escapes the text and ignores codes it has no colour for', () => {
        assert.equal(ansiLineToHtml('\x1b[1m<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
    });

    test('a line with no codes is only escaped, and repeated calls agree', () => {
        assert.equal(ansiLineToHtml('plain <x>'), 'plain &lt;x&gt;');
        assert.equal(ansiLineToHtml('\x1b[32mok\x1b[0m'), ansiLineToHtml('\x1b[32mok\x1b[0m'));
    });
});
