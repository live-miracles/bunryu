'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    checkFfmpeg,
    missingFeatures,
    parseNames,
    parseProtocols,
} = require('../src/utils/ffmpegCheck');
const { ffmpegEnv } = require('../src/utils/ffmpeg');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-ffmpeg-check-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

// Excerpts of the pinned ffmpeg 7.1 listings.
const PROTOCOLS = `Supported file protocols:
Input:
  file
  rtmp
  rtmps
  srt
Output:
  file
  rtmp
  rtmps
  srt
`;
const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`;
const FILTERS = `Filters:
  T.. = Timeline support
  A = Audio input/output
 ..C amix              N->A       Audio mixing.
 ... azmq              A->A       Receive commands through ZMQ and broker them to filters.
`;

// A stand-in ffmpeg that prints the given listings, like the real one does.
function fakeFfmpeg(name, { protocols = PROTOCOLS, encoders = ENCODERS, filters = FILTERS } = {}) {
    const file = path.join(tempDir, name);
    const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(
        file,
        `#!/bin/sh
case "$2" in
  -version) echo 'ffmpeg version n7.1.4 Copyright (c) 2000-2026 the FFmpeg developers' ;;
  -protocols) printf '%s' ${quote(protocols)} ;;
  -encoders) printf '%s' ${quote(encoders)} ;;
  -filters) printf '%s' ${quote(filters)} ;;
esac
`,
        { mode: 0o755 },
    );
    return file;
}

describe('ffmpeg listing parsers', () => {
    test('protocols are split into input and output', () => {
        const { input, output } = parseProtocols('Input:\n  rtmp\n  srt\nOutput:\n  rtmp\n');
        assert.deepEqual([...input], ['rtmp', 'srt']);
        assert.deepEqual([...output], ['rtmp']);
    });

    test('encoder and filter names come from the second column, not the legend', () => {
        assert.deepEqual([...parseNames(ENCODERS)], ['libx264', 'aac']);
        assert.deepEqual([...parseNames(FILTERS)], ['amix', 'azmq']);
    });

    test('a complete build is missing nothing', () => {
        assert.deepEqual(
            missingFeatures({ protocols: PROTOCOLS, encoders: ENCODERS, filters: FILTERS }),
            [],
        );
    });

    test('names each missing protocol direction, encoder and filter', () => {
        const missing = missingFeatures({
            protocols: 'Input:\n  rtmp\n  rtmps\nOutput:\n  rtmp\n  rtmps\n  srt\n',
            encoders: ENCODERS.replace(/.*libx264.*\n/, ''),
            filters: FILTERS.replace(/.*azmq.*\n/, ''),
        });
        assert.deepEqual(missing, ['srt input protocol', 'libx264 encoder', 'azmq filter']);
    });
});

describe('checkFfmpeg', () => {
    test('passes a complete build with a working ffprobe', async () => {
        const ffmpeg = fakeFfmpeg('ffmpeg-ok');
        const result = await checkFfmpeg(ffmpeg, ffmpeg);
        assert.deepEqual(result, { ok: true, version: 'n7.1.4', missing: [], error: null });
    });

    test('reports what an incomplete build lacks', async () => {
        const ffmpeg = fakeFfmpeg('ffmpeg-no-srt', { protocols: 'Input:\n  rtmp\n  rtmps\n' });
        const result = await checkFfmpeg(ffmpeg, ffmpeg);
        assert.equal(result.ok, false);
        assert.deepEqual(result.missing, [
            'rtmp output protocol',
            'rtmps output protocol',
            'srt input protocol',
            'srt output protocol',
        ]);
    });

    test('reports a missing ffprobe', async () => {
        const ffmpeg = fakeFfmpeg('ffmpeg-no-probe');
        const result = await checkFfmpeg(ffmpeg, path.join(tempDir, 'no-such-ffprobe'));
        assert.equal(result.ok, false);
        assert.deepEqual(result.missing, ['ffprobe']);
    });

    test('a binary that does not run is a result, not a throw', async () => {
        const missing = path.join(tempDir, 'no-such-ffmpeg');
        const result = await checkFfmpeg(missing, missing);
        assert.equal(result.ok, false);
        assert.match(result.error, /no-such-ffmpeg\) did not run/);
    });
});

describe('ffmpegEnv', () => {
    test('keeps only the variables ffmpeg can use', () => {
        const env = ffmpegEnv({
            PATH: '/usr/bin',
            LANG: 'C.UTF-8',
            SSL_CERT_FILE: '/etc/ssl/cert.pem',
            BUNRYU_DASHBOARD_PASSWORD: 'secret',
            BUNRYU_CONFIG: '/etc/bunryu/bunryu.json',
            NODE_ENV: 'production',
        });
        assert.deepEqual(env, {
            PATH: '/usr/bin',
            LANG: 'C.UTF-8',
            SSL_CERT_FILE: '/etc/ssl/cert.pem',
        });
    });
});
