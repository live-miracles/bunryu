'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseOutputsPayload,
    parseSingleOutputPayload,
    pasteResultMessage,
    splitNewOutputs,
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

describe('splitNewOutputs', () => {
    const out = (name, url) => ({ name, videoEncoding: 'copy', url, audioEncoding: 'copy' });

    test('keeps the outputs whose destination the pipeline does not use, in order', () => {
        const pasted = [out('A', 'rtmp://h/a'), out('B', 'rtmp://h/b')];
        assert.deepEqual(splitNewOutputs(['rtmp://h/x'], pasted), { fresh: pasted, skipped: [] });
    });

    test('skips an output whose destination an existing output has', () => {
        const pasted = [out('A', 'rtmp://h/a'), out('B', 'rtmp://h/b')];
        assert.deepEqual(splitNewOutputs(['rtmp://h/a'], pasted), {
            fresh: [pasted[1]],
            skipped: [pasted[0]],
        });
    });

    test('compares destinations without the surrounding whitespace', () => {
        const pasted = [out('A', ' rtmp://h/a ')];
        assert.equal(splitNewOutputs(['rtmp://h/a'], pasted).fresh.length, 0);
        assert.equal(splitNewOutputs([' rtmp://h/a'], [out('A', 'rtmp://h/a')]).fresh.length, 0);
    });

    test('keeps only the first of two pasted outputs with the same destination', () => {
        const pasted = [out('A', 'rtmp://h/a'), out('B', 'rtmp://h/a')];
        assert.deepEqual(splitNewOutputs([], pasted), { fresh: [pasted[0]], skipped: [pasted[1]] });
    });

    test('is exact: a different key or scheme is another destination', () => {
        const pasted = [out('A', 'rtmp://h/app/k2'), out('B', 'rtmps://h/app/k1')];
        assert.equal(splitNewOutputs(['rtmp://h/app/k1'], pasted).fresh.length, 2);
    });
});

describe('pasteResultMessage', () => {
    test('says how many were added and how many skipped', () => {
        assert.equal(pasteResultMessage(1, 0), 'Pasted 1 output.');
        assert.equal(pasteResultMessage(3, 0), 'Pasted 3 outputs.');
        assert.equal(
            pasteResultMessage(3, 2),
            'Pasted 3 outputs, skipped 2 with a destination this pipeline already uses.',
        );
    });

    test('says so when everything was skipped', () => {
        assert.match(pasteResultMessage(0, 1), /^Nothing pasted: the output has/);
        assert.match(pasteResultMessage(0, 4), /^Nothing pasted: all 4 outputs have/);
    });
});
