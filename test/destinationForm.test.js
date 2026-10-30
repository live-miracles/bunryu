'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    CUSTOM_RTMP_IDX,
    CUSTOM_SRT_IDX,
    INSTAGRAM_RTMP_IDX,
    RESTREAM_RTMP_IDX,
    RESTREAM_SRT_IDX,
    SERVERS,
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

const YT = SERVERS.findIndex((s) => s.label === 'YT RTMP');

describe('detectServer and buildDestinationUrl', () => {
    test('a stored URL is read back to the preset and value that produce it', () => {
        const cases = [
            [YT, 'abcd-efgh'],
            [INSTAGRAM_RTMP_IDX, '123?s_bl=1&s_prp=xyz-1&token=t'],
            [RESTREAM_RTMP_IDX, '7'],
            [RESTREAM_SRT_IDX, '7'],
            [CUSTOM_RTMP_IDX, 'rtmp://example.net/app/key'],
        ];
        for (const [idx, key] of cases) {
            const built = buildDestinationUrl(idx, key, pipelines);
            assert.ok('url' in built, `${idx} ${key}`);
            assert.deepEqual(detectServer(built.url, pipelines), { idx, key });
        }
    });

    test('an unrecognised URL is custom, by its scheme', () => {
        assert.deepEqual(detectServer('srt://h:1?mode=caller', pipelines), {
            idx: CUSTOM_SRT_IDX,
            key: 'srt://h:1?mode=caller',
        });
        assert.equal(detectServer('rtmps://h/app/k', pipelines).idx, CUSTOM_RTMP_IDX);
    });

    test('an empty value, an unknown pipeline or a wrong scheme is an error', () => {
        assert.deepEqual(buildDestinationUrl(YT, '', pipelines), { error: true });
        assert.deepEqual(buildDestinationUrl(INSTAGRAM_RTMP_IDX, '', pipelines), { error: true });
        assert.deepEqual(buildDestinationUrl(RESTREAM_RTMP_IDX, '99', pipelines), { error: true });
        assert.deepEqual(buildDestinationUrl(CUSTOM_RTMP_IDX, 'http://x/y', pipelines), {
            error: true,
        });
        assert.deepEqual(buildDestinationUrl(CUSTOM_RTMP_IDX, 'rtmp://x/y', pipelines), {
            url: 'rtmp://x/y',
        });
    });
});

describe('sanitizedDestinationFor', () => {
    test('drops the part that is unique to the stream and keeps the server', () => {
        assert.deepEqual(sanitizedDestinationFor('rtmp://example.net/app/secretkey', pipelines), {
            idx: CUSTOM_RTMP_IDX,
            key: 'rtmp://example.net/app/',
        });
        assert.deepEqual(sanitizedDestinationFor('rtmp://example.net', pipelines), {
            idx: CUSTOM_RTMP_IDX,
            key: 'rtmp://example.net',
        });
        assert.deepEqual(
            sanitizedDestinationFor(
                'srt://h:9000?mode=caller&passphrase=correct%20horse&streamid=secret',
                pipelines,
            ),
            { idx: CUSTOM_SRT_IDX, key: 'srt://h:9000?mode=caller&passphrase=correct%20horse' },
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
