'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-renditions-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
fs.writeFileSync(
    path.join(tempDir, 'bunryu.json'),
    JSON.stringify({
        port: 8080,
        database_path: './db.sqlite',
        srs_config_path: './srs.conf',
        ffmpeg_path: 'ffmpeg',
        ffprobe_path: 'ffprobe',
    }),
    'utf8',
);
fs.writeFileSync(
    path.join(tempDir, 'srs.conf'),
    'listen 21935;\nhttp_api {\n    enabled on;\n    listen 1985;\n}\nsrt_server {\n    enabled on;\n    listen 10080;\n}\n',
    'utf8',
);

const {
    RENDITION_APP,
    encodeRecipe,
    sharedRecipe,
    renditionStreamName,
    renditionUrl,
    isRenditionUrl,
    isRenditionOutput,
    renditionName,
    recipeOfRendition,
} = require('../src/utils/renditions');
const {
    isRenditionUrl: isRenditionUrlFrontend,
    sharedRecipeKey: sharedRecipeKeyFrontend,
} = require('../public/ts/core/renditions');
const { ENCODINGS } = require('../src/utils/ffmpeg');

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const out = (videoEncoding, audioEncoding, url = 'rtmp://example.com/live/x') => ({
    pipelineId: 12,
    videoEncoding,
    audioEncoding,
    url,
});

describe('encodeRecipe', () => {
    test('plain copy needs no encode', () => {
        assert.equal(encodeRecipe(out('copy', 'copy')), null);
    });

    test('a video preset with source audio needs an encode', () => {
        assert.deepEqual(encodeRecipe(out('720p', 'copy')), {
            videoEncoding: '720p',
            audioEncoding: 'copy',
            key: '720p_acopy',
        });
    });

    test('a single audio track with copied video needs an encode', () => {
        assert.deepEqual(encodeRecipe(out('copy', '1')), {
            videoEncoding: 'copy',
            audioEncoding: '1',
            key: 'copy_a1',
        });
    });

    test('track 0 is a real track selection, not the source audio', () => {
        assert.equal(encodeRecipe(out('copy', '0')).key, 'copy_a0');
    });

    test('every preset needs an encode', () => {
        for (const v of ['720p', '1080p', 'vertical_rotate']) {
            assert.equal(encodeRecipe(out(v, '2')).key, `${v}_a2`);
        }
    });

    test('multi-track selections never go through an encode', () => {
        assert.equal(encodeRecipe(out('copy', '0,1', 'srt://h:1?mode=caller')), null);
        assert.equal(encodeRecipe(out('720p', '0,1', 'srt://h:1?mode=caller')), null);
    });

    test('translation outputs never go through an encode', () => {
        assert.equal(encodeRecipe(out('copy', 'translation')), null);
        assert.equal(encodeRecipe(out('720p', 'translation')), null);
    });

    test('a rendition output is not itself a recipe', () => {
        const url = 'rtmp://127.0.0.1:21935/internal/r12_720p_a1';
        assert.equal(encodeRecipe(out('720p', '1', url)), null);
    });

    test('an unknown video preset behaves as copy and is not shared', () => {
        assert.equal(encodeRecipe(out('bogus', 'copy')), null);
    });
});

describe('sharedRecipe (needs two configured outputs with the recipe)', () => {
    const u = (video, audio, n) => ({
        ...out(video, audio, `rtmp://example.com/live/${n}`),
        id: `12-${n}`,
    });

    test('a single output with a recipe stays direct', () => {
        const a = u('720p', '1', 1);
        assert.equal(sharedRecipe(a, [a]), null);
        assert.equal(sharedRecipe(a, [a, u('copy', 'copy', 2), u('1080p', '1', 3)]), null);
    });

    test('two configured outputs with the same recipe share, whatever their desired state', () => {
        const a = { ...u('720p', '1', 1), desiredState: 'running' };
        const b = { ...u('720p', '1', 2), desiredState: 'stopped' };
        assert.equal(sharedRecipe(a, [a, b]).key, '720p_a1');
        assert.equal(sharedRecipe(b, [a, b]).key, '720p_a1');
    });

    test('the recipe must be identical: video and audio both', () => {
        const a = u('720p', '1', 1);
        assert.equal(sharedRecipe(a, [a, u('720p', '0', 2)]), null);
        assert.equal(sharedRecipe(a, [a, u('1080p', '1', 2)]), null);
        assert.equal(sharedRecipe(a, [a, u('720p', 'copy', 2)]), null);
    });

    test('outputs that never share are not counted: plain copy, multi-track, translation, renditions', () => {
        const a = u('copy', '1', 1);
        const others = [
            u('copy', 'copy', 2),
            u('copy', '0,1', 3),
            u('copy', 'translation', 4),
            out('copy', '1', 'rtmp://127.0.0.1:21935/internal/r12_copy_a1'),
        ];
        assert.equal(sharedRecipe(a, [a, ...others]), null);
        assert.equal(sharedRecipe(others[0], [a, ...others]), null);
    });

    test('adding or removing the second output flips the answer for the first', () => {
        const a = u('720p', '1', 1);
        const b = u('720p', '1', 2);
        assert.equal(sharedRecipe(a, [a]), null);
        assert.equal(sharedRecipe(a, [a, b]).key, '720p_a1');
        assert.equal(sharedRecipe(a, [a]), null);
    });
});

describe('rendition naming', () => {
    test('stream name and url use the pipeline id and the recipe key', () => {
        const recipe = encodeRecipe(out('720p', '1'));
        assert.equal(RENDITION_APP, 'internal');
        assert.equal(renditionStreamName(12, recipe), 'r12_720p_a1');
        assert.equal(renditionUrl(12, recipe), 'rtmp://127.0.0.1:21935/internal/r12_720p_a1');
    });

    test('stream names for the documented examples', () => {
        assert.equal(renditionStreamName(3, encodeRecipe(out('copy', '0'))), 'r3_copy_a0');
        assert.equal(renditionStreamName(7, encodeRecipe(out('1080p', 'copy'))), 'r7_1080p_acopy');
    });

    test('renditionStreamName throws for a recipe that would not match the pattern', () => {
        assert.throws(() =>
            renditionStreamName(1, { videoEncoding: 'a/b', audioEncoding: '1', key: 'a/b_a1' }),
        );
        assert.throws(() =>
            renditionStreamName(1, { videoEncoding: 'copy', audioEncoding: 'X', key: 'copy_aX' }),
        );
    });

    test('display names', () => {
        assert.equal(renditionName(encodeRecipe(out('720p', '1'))), 'Shared encode 720p · track 1');
        assert.equal(
            renditionName(encodeRecipe(out('copy', '0'))),
            'Shared encode copy video · track 0',
        );
        assert.equal(
            renditionName(encodeRecipe(out('1080p', 'copy'))),
            'Shared encode 1080p · source audio',
        );
    });
});

describe('rendition recognition', () => {
    const accepted = [
        'rtmp://127.0.0.1:21935/internal/r12_720p_a1',
        'rtmp://127.0.0.1:1935/internal/r3_copy_a0',
        'rtmp://127.0.0.1:1935/internal/r7_vertical_rotate_acopy',
    ];
    const rejected = [
        'rtmp://127.0.0.1:1935/live/key01_0123456789abcdef0123456789abcdef',
        'rtmp://127.0.0.1/internal/r12_720p_a1',
        'rtmp://localhost:1935/internal/r12_720p_a1',
        'rtmp://127.0.0.1:1935/internal/r12_720p_a1?x=1',
        'rtmp://127.0.0.1:1935/internal/r12_720p_a1/extra',
        'rtmp://127.0.0.1:1935/internal/R12_720p_a1',
        'rtmp://127.0.0.1:1935/internal/x12_720p_a1',
        'rtmps://127.0.0.1:1935/internal/r12_720p_a1',
        'rtmp://127.0.0.1:1935/live/r12_720p_a1',
        'rtmp://example.com:1935/internal/r12_720p_a1',
        'srt://127.0.0.1:1935/internal/r12_720p_a1',
        '',
    ];

    test('isRenditionUrl accepts exactly the rendition shape', () => {
        for (const u of accepted) assert.equal(isRenditionUrl(u), true, u);
        for (const u of rejected) assert.equal(isRenditionUrl(u), false, u);
    });

    test('the frontend twin agrees with the backend on every url', () => {
        for (const u of [...accepted, ...rejected]) {
            assert.equal(isRenditionUrlFrontend(u), isRenditionUrl(u), u);
        }
    });

    test('isRenditionOutput looks at the url only', () => {
        assert.equal(isRenditionOutput({ url: accepted[0] }), true);
        assert.equal(isRenditionOutput({ url: rejected[0] }), false);
    });

    test('recipeOfRendition rebuilds the recipe from the row fields', () => {
        const r = recipeOfRendition({
            url: accepted[0],
            videoEncoding: '720p',
            audioEncoding: '1',
        });
        assert.deepEqual(r, { videoEncoding: '720p', audioEncoding: '1', key: '720p_a1' });
        assert.equal(renditionUrl(12, r), 'rtmp://127.0.0.1:21935/internal/r12_720p_a1');
    });
});

describe('frontend sharedRecipeKey twin', () => {
    test('agrees with the backend encodeRecipe on every combination', () => {
        const videos = [...Object.keys(ENCODINGS), 'bogus'];
        const audios = ['copy', '0', '1', '12', '0,1', 'translation', '', 'x'];
        const urls = [
            'rtmp://example.com/live/x',
            'srt://h:1?mode=caller',
            'rtmp://127.0.0.1:21935/internal/r12_720p_a1',
        ];
        for (const videoEncoding of videos) {
            for (const audioEncoding of audios) {
                for (const url of urls) {
                    const o = { url, videoEncoding, audioEncoding };
                    assert.equal(
                        sharedRecipeKeyFrontend(o, Object.keys(ENCODINGS)),
                        encodeRecipe(o)?.key ?? null,
                        JSON.stringify(o),
                    );
                }
            }
        }
    });
});
