'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    buildDestinationUrl,
    detectServer,
    isDestinationUrl,
    sanitizedDestinationFor,
} = require('../public/ts/core/destination');

const pipelines = [
    {
        id: 7,
        rtmpPublishUrlLocal: 'rtmp://127.0.0.1/live/key07',
        srtPublishUrlLocal: 'srt://127.0.0.1:10080?streamid=#!::r=live/key07,m=publish',
    },
];

describe('detectServer and buildDestinationUrl', () => {
    test('a stored URL is read back to the preset and value that produce it', () => {
        const cases = [
            ['youtube', 'abcd-efgh'],
            ['instagram', '123?s_bl=1&s_prp=xyz-1&token=t'],
            ['restream-rtmp', '7'],
            ['restream-srt', '7'],
            ['custom-rtmp', 'rtmp://example.net/app/key'],
        ];
        for (const [server, key] of cases) {
            const built = buildDestinationUrl(server, key, pipelines);
            assert.ok('url' in built, `${server} ${key}`);
            assert.deepEqual(detectServer(built.url, pipelines), { server, key });
        }
    });

    test('an unrecognised URL is custom, by its scheme', () => {
        assert.deepEqual(detectServer('srt://h:1?mode=caller', pipelines), {
            server: 'custom-srt',
            key: 'srt://h:1?mode=caller',
        });
        assert.equal(detectServer('rtmps://h/app/k', pipelines).server, 'custom-rtmp');
    });

    test('an empty value, an unknown pipeline or a wrong scheme is an error', () => {
        assert.deepEqual(buildDestinationUrl('youtube', '', pipelines), { error: true });
        assert.deepEqual(buildDestinationUrl('instagram', '', pipelines), { error: true });
        assert.deepEqual(buildDestinationUrl('restream-rtmp', '99', pipelines), { error: true });
        assert.deepEqual(buildDestinationUrl('custom-rtmp', 'http://x/y', pipelines), {
            error: true,
        });
        assert.deepEqual(buildDestinationUrl('custom-rtmp', 'rtmp://x/y', pipelines), {
            url: 'rtmp://x/y',
        });
    });
});

describe('sanitizedDestinationFor', () => {
    test('drops the part that is unique to the stream and keeps the server', () => {
        assert.deepEqual(sanitizedDestinationFor('rtmp://example.net/app/secretkey', pipelines), {
            server: 'custom-rtmp',
            key: 'rtmp://example.net/app/',
        });
        assert.deepEqual(sanitizedDestinationFor('rtmp://example.net', pipelines), {
            server: 'custom-rtmp',
            key: 'rtmp://example.net',
        });
        assert.deepEqual(
            sanitizedDestinationFor(
                'srt://h:9000?mode=caller&passphrase=correct%20horse&streamid=secret',
                pipelines,
            ),
            { server: 'custom-srt', key: 'srt://h:9000?mode=caller&passphrase=correct%20horse' },
        );
        for (const url of [
            'rtmp://a.rtmp.youtube.com/live2/abcd-efgh',
            pipelines[0].rtmpPublishUrlLocal,
        ]) {
            assert.equal(sanitizedDestinationFor(url, pipelines).key, '');
        }
    });
});

describe('isDestinationUrl', () => {
    test('recognises a pasted RTMP, RTMPS or SRT URL only', () => {
        assert.equal(isDestinationUrl('RTMPS://h/app/k'), true);
        assert.equal(isDestinationUrl('srt://h:1'), true);
        assert.equal(isDestinationUrl('https://h'), false);
        assert.equal(isDestinationUrl('abcd-efgh'), false);
    });
});
