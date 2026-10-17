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

describe('sharedRecipe', () => {
    test('plain copy is not shared', () => {
        assert.equal(sharedRecipe(out('copy', 'copy')), null);
    });

    test('a video preset with source audio is shared', () => {
        assert.deepEqual(sharedRecipe(out('720p', 'copy')), {
            videoEncoding: '720p',
            audioEncoding: 'copy',
            key: '720p_acopy',
        });
    });

    test('a single audio track with copied video is shared', () => {
        assert.deepEqual(sharedRecipe(out('copy', '1')), {
            videoEncoding: 'copy',
            audioEncoding: '1',
            key: 'copy_a1',
        });
    });

    test('track 0 is a real track selection, not the source audio', () => {
        assert.equal(sharedRecipe(out('copy', '0')).key, 'copy_a0');
    });

    test('every preset is shared', () => {
        for (const v of ['720p', '1080p', 'vertical_rotate']) {
            assert.equal(sharedRecipe(out(v, '2')).key, `${v}_a2`);
        }
    });

    test('multi-track selections are never shared', () => {
        assert.equal(sharedRecipe(out('copy', '0,1', 'srt://h:1?mode=caller')), null);
        assert.equal(sharedRecipe(out('720p', '0,1', 'srt://h:1?mode=caller')), null);
    });

    test('translation outputs are never shared', () => {
        assert.equal(sharedRecipe(out('copy', 'translation')), null);
        assert.equal(sharedRecipe(out('720p', 'translation')), null);
    });

    test('a rendition output is never itself shared', () => {
        const url = 'rtmp://127.0.0.1:21935/internal/r12_720p_a1';
        assert.equal(sharedRecipe(out('720p', '1', url)), null);
    });

    test('an unknown video preset behaves as copy and is not shared', () => {
        assert.equal(sharedRecipe(out('bogus', 'copy')), null);
    });
});

describe('rendition naming', () => {
    test('stream name and url use the pipeline id and the recipe key', () => {
        const recipe = sharedRecipe(out('720p', '1'));
        assert.equal(RENDITION_APP, 'internal');
        assert.equal(renditionStreamName(12, recipe), 'r12_720p_a1');
        assert.equal(renditionUrl(12, recipe), 'rtmp://127.0.0.1:21935/internal/r12_720p_a1');
    });

    test('stream names for the documented examples', () => {
        assert.equal(renditionStreamName(3, sharedRecipe(out('copy', '0'))), 'r3_copy_a0');
        assert.equal(renditionStreamName(7, sharedRecipe(out('1080p', 'copy'))), 'r7_1080p_acopy');
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
        assert.equal(renditionName(sharedRecipe(out('720p', '1'))), 'Shared encode 720p · track 1');
        assert.equal(
            renditionName(sharedRecipe(out('copy', '0'))),
            'Shared encode copy video · track 0',
        );
        assert.equal(
            renditionName(sharedRecipe(out('1080p', 'copy'))),
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
    test('agrees with the backend sharedRecipe on every combination', () => {
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
                        sharedRecipe(o)?.key ?? null,
                        JSON.stringify(o),
                    );
                }
            }
        }
    });
});
