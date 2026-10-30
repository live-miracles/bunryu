'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { videoSpec, audioSpecLines, keyframeSpec } = require('../public/ts/core/media-spec');
const { renderInputStats } = require('../public/ts/features/input-stats-view');

const video = {
    codec: 'h264',
    width: 1920,
    height: 1080,
    fps: 50,
    fieldOrder: 'progressive',
    profile: 'High',
    level: '4.2',
};
const track = (over) => ({
    index: 0,
    codec: 'aac',
    sampleRate: 48000,
    channels: 2,
    profile: 'LC',
    language: null,
    title: null,
    pid: null,
    ...over,
});

describe('videoSpec', () => {
    test('reads as one line with scan+rate and an L-prefixed level', () => {
        assert.equal(videoSpec(video), 'h264 1920x1080p50 High L4.2');
    });

    test('marks interlaced field order', () => {
        assert.equal(
            videoSpec({ ...video, fps: 25, fieldOrder: 'tt' }),
            'h264 1920x1080i25tff High L4.2',
        );
    });

    test('is null until the size is known', () => {
        assert.equal(videoSpec({ ...video, width: 0 }), null);
        assert.equal(videoSpec(null), null);
    });
});

describe('keyframeSpec', () => {
    const kf = (over) => ({
        windowSec: 12,
        spanSec: 11.96,
        keyframes: 6,
        meanGapSec: 2,
        maxGapSec: 2,
        ...over,
    });

    test('a steady interval reads as "every N s"', () => {
        assert.equal(keyframeSpec(kf({})), 'every 2.0 s');
    });

    test('an uneven interval gives the mean and the longest gap', () => {
        assert.equal(
            keyframeSpec(kf({ meanGapSec: 2.4, maxGapSec: 3.5 })),
            'every 2.4 s on average, up to 3.5 s',
        );
    });

    test('too few keyframes in the window say so', () => {
        assert.equal(
            keyframeSpec(kf({ keyframes: 1, meanGapSec: null, maxGapSec: 11.9 })),
            '1 in 12 s',
        );
        assert.equal(
            keyframeSpec(kf({ keyframes: 0, meanGapSec: null, maxGapSec: 11.9 })),
            '0 in 12 s',
        );
    });
});

describe('audioSpecLines', () => {
    test('one line per track, with the label escaped', () => {
        const lines = audioSpecLines(
            [track({}), track({ index: 1, language: 'hin', title: '<b>' })],
            null,
        );
        assert.equal(lines[0], 'Track 1: aac LC 2ch 48kHz');
        assert.equal(
            lines[1],
            'Track 2: aac LC 2ch 48kHz <span class="text-muted">hin &lt;b&gt;</span>',
        );
    });

    test('includes the PID when a multi-track input reports one (MPEG-TS over SRT)', () => {
        const lines = audioSpecLines([track({ pid: 257 }), track({ index: 1, pid: null })], null);
        assert.equal(lines[0], 'Track 1 (PID 257): aac LC 2ch 48kHz');
        assert.equal(lines[1], 'Track 2: aac LC 2ch 48kHz');
    });

    test('leaves the PID out for a single track', () => {
        assert.deepEqual(audioSpecLines([track({ pid: 257 })], null), [
            'Track 1: aac LC 2ch 48kHz',
        ]);
    });

    test('falls back to the single SRS audio when there are no tracks', () => {
        const fallback = { codec: 'aac', profile: 'LC', channel: 1, sample_rate: 44100 };
        assert.deepEqual(audioSpecLines([], fallback), ['Track 1: aac LC 1ch 44.1kHz']);
    });
});

describe('renderInputStats', () => {
    const input = (over) => ({
        connected: true,
        live: true,
        mediaOk: true,
        mediaError: null,
        mediaCheckedAt: Date.now() - 125_000,
        publisherIp: '198.51.100.7',
        recvBitrateKbps: 5200,
        video,
        audio: null,
        audioTracks: [track({})],
        ...over,
    });

    test('shows source, video and audio as labelled lines with the probe time', () => {
        const html = renderInputStats(input({}), {});
        assert.match(html, /Source/);
        assert.match(html, /198\.51\.100\.7 · <span class="">5\.2 Mbps<\/span>/);
        assert.match(html, /h264 1920x1080p50 High L4\.2/);
        assert.match(html, /Track 1: aac LC 2ch 48kHz/);
        assert.match(html, /probed 2 min ago/);
        assert.match(html, /title="When ffprobe last read the input: \d/);
    });

    test('shows the measured keyframe interval, in warning colour when it raised the alert', () => {
        const keyframes = {
            windowSec: 12,
            spanSec: 11.96,
            keyframes: 2,
            meanGapSec: 6,
            maxGapSec: 6,
            checkedAt: 1,
        };
        const ok = renderInputStats(
            input({ keyframes: { ...keyframes, meanGapSec: 2, maxGapSec: 2 } }),
            {},
        );
        assert.match(ok, /Keyframes/);
        assert.match(ok, /every 2\.0 s/);
        assert.ok(!/text-warning[^>]*>every/.test(ok));
        const bad = renderInputStats(
            input({ keyframes, alerts: [{ code: 'input-keyframe-interval' }] }),
            {},
        );
        assert.match(bad, /text-warning[^>]*>every 6\.0 s/);
        assert.ok(!/Keyframes/.test(renderInputStats(input({ keyframes: null }), {})));
    });

    test('marks a starved input bitrate as a warning', () => {
        assert.match(
            renderInputStats(input({ recvBitrateKbps: 150 }), {}),
            /class="text-warning"[^>]*>150 kbps/,
        );
        assert.ok(!/text-warning/.test(renderInputStats(input({ recvBitrateKbps: 900 }), {})));
    });

    test('prefers the relay-reported source IP', () => {
        const html = renderInputStats(input({ publisherIp: '127.0.0.1', recvBitrateKbps: 900 }), {
            sourceIp: '203.0.113.9',
        });
        assert.match(html, /203\.0\.113\.9/);
        assert.ok(!/127\.0\.0\.1/.test(html));
    });

    test('tells a direct SRT input that it has no loss stats, naming the relay port', () => {
        const html = renderInputStats(input({}), {
            directSrt: true,
            relayPort: 10081,
        });
        assert.match(html, /Sent straight to SRS: no packet loss or retransmit stats/);
        assert.match(html, /SRT relay input \(port 10081\)/);
    });

    test('shows no direct-SRT hint otherwise', () => {
        assert.ok(!/straight to SRS/.test(renderInputStats(input({ recvBitrateKbps: 900 }), {})));
        assert.ok(
            !/straight to SRS/.test(
                renderInputStats(input({}), { directSrt: false, relayPort: 10081 }),
            ),
        );
    });

    test('still shows the probe notice instead of stats while ffprobe has not finished', () => {
        const html = renderInputStats(input({ mediaOk: null }), {});
        assert.match(html, /Waiting for ffprobe/);
        assert.ok(!/Source/.test(html));
    });
});
