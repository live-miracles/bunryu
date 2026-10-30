'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    buildSrtOutputUrl,
    isSrtHostRequired,
    parseSrtUrl,
    srtUrlFromForm,
    stripSrtStreamId,
} = require('../public/ts/core/srt');

describe('SRT output form rules', () => {
    test('listener mode allows an empty host and binds the default interfaces', () => {
        assert.equal(isSrtHostRequired('listener'), false);
        assert.equal(
            buildSrtOutputUrl({
                mode: 'listener',
                host: '',
                port: 10000,
                latencyMs: null,
                passphrase: '',
                pbKeyLen: null,
                streamId: '',
            }),
            'srt://:10000?mode=listener',
        );
    });

    test('caller mode still requires a host', () => {
        assert.equal(isSrtHostRequired('caller'), true);
    });
});

// What a saved URL shows in the edit form and what saving it again stores must
// agree, or editing an output would silently change its passphrase or stream ID.
describe('SRT settings round trip', () => {
    const settings = (over = {}) => ({
        mode: 'caller',
        host: 'srt.example.net',
        port: 9000,
        latencyMs: 240,
        passphrase: '',
        pbKeyLen: null,
        streamId: '',
        ...over,
    });

    test('a URL read into the form and built again is the same URL', () => {
        for (const over of [
            {},
            { mode: 'listener', host: '' },
            { passphrase: 'correct horse battery', pbKeyLen: 24 },
            { passphrase: 'p&ss=w+rd %41/?#é', pbKeyLen: 16 },
            { streamId: '#!::r=live/key01,m=publish' },
            { streamId: 'a+b%41' },
            { latencyMs: null },
        ]) {
            const url = buildSrtOutputUrl(settings(over));
            const parsed = parseSrtUrl(url);
            assert.deepEqual(parsed, settings({ pbKeyLen: null, ...over }), url);
            assert.equal(buildSrtOutputUrl(parsed), url);
        }
    });

    test('a URL that is not SRT, or cannot be read, gives the empty form', () => {
        for (const url of ['rtmp://host/app', '', 'srt://']) {
            assert.deepEqual(parseSrtUrl(url), {
                mode: 'caller',
                host: '',
                port: null,
                latencyMs: null,
                passphrase: '',
                pbKeyLen: null,
                streamId: '',
            });
        }
    });

    test('dropping the stream ID keeps every other setting, passphrase included', () => {
        const url = buildSrtOutputUrl(
            settings({ passphrase: 'correct horse battery', pbKeyLen: 32, streamId: 'secret-id' }),
        );
        assert.deepEqual(
            parseSrtUrl(stripSrtStreamId(url)),
            settings({ passphrase: 'correct horse battery', pbKeyLen: 32 }),
        );
        assert.equal(stripSrtStreamId('srt://h:1?mode=caller'), 'srt://h:1?mode=caller');
        assert.equal(stripSrtStreamId('srt://h:1?streamid=x'), 'srt://h:1');
    });
});

describe('srtUrlFromForm', () => {
    const values = (over = {}) => ({
        mode: 'caller',
        host: ' srt.example.net ',
        port: '9000',
        latency: '',
        passphrase: '',
        keyLen: '',
        streamId: '',
        ...over,
    });

    test('builds the URL from trimmed fields', () => {
        assert.deepEqual(srtUrlFromForm(values({ latency: '240', streamId: ' id ' })), {
            url: 'srt://srt.example.net:9000?mode=caller&latency=240000&streamid=id',
        });
    });

    test('names every field that is wrong', () => {
        assert.deepEqual(
            srtUrlFromForm(
                values({ host: '', port: '70000', latency: '0', passphrase: 'short', keyLen: '' }),
            ),
            { invalid: ['host', 'port', 'latency', 'passphrase', 'keyLen'] },
        );
    });

    test('a passphrase needs a key length, and a listener needs no host', () => {
        assert.deepEqual(srtUrlFromForm(values({ passphrase: 'long enough pass' })), {
            invalid: ['keyLen'],
        });
        assert.deepEqual(srtUrlFromForm(values({ mode: 'listener', host: '' })), {
            url: 'srt://:9000?mode=listener',
        });
    });
});
