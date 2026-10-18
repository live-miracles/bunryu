'use strict';

// Every other translation-mixer test either checks buildTranslationMixerArgs'
// argument *shape* (utils.test.js) or drives the mixer service against a
// mocked child_process.spawn (translationMixer.test.js). Neither would catch
// a bug inside the actual filter_complex string itself — a wrong track index,
// a broken amix/adelay expression, or an accidentally-muted leg. These tests
// run the real production filter graph through a real ffmpeg process against
// synthetic audio and check the resulting file's actual signal, so a filter
// graph that silently drops one leg of the mix fails here even though every
// other test still passes.

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildTranslationMixerArgs } = require('../src/utils/ffmpeg');

const ffmpegProbe = spawnSync('ffmpeg', ['-version']);
const ffmpegAvailable = !ffmpegProbe.error && ffmpegProbe.status === 0;
const skip = ffmpegAvailable ? false : 'ffmpeg is not available on PATH';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-mixer-audio-'));
after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// Renders a short synthetic clip via a real ffmpeg lavfi source: either a
// steady tone (a stand-in for "there is audio here") or true digital silence.
function renderClip(name, kind, durationSeconds = 1) {
    const outPath = path.join(tempDir, name);
    const source =
        kind === 'silence'
            ? `anullsrc=r=48000:cl=stereo:d=${durationSeconds}`
            : `sine=frequency=440:duration=${durationSeconds}:sample_rate=48000`;
    const result = spawnSync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        source,
        outPath,
    ]);
    assert.equal(result.status, 0, `failed to render ${name}: ${result.stderr}`);
    return outPath;
}

// A clip that speaks for the first second, then goes truly silent for the
// rest — used to check that the meter reflects the silence afterwards
// instead of getting stuck at the earlier peak.
function renderSpeakThenSilentClip(name, silentSeconds) {
    const outPath = path.join(tempDir, name);
    const graph =
        `sine=frequency=440:duration=1:sample_rate=48000[a];` +
        `anullsrc=r=48000:cl=mono:d=${silentSeconds}[b];` +
        `[a][b]concat=n=2:v=0:a=1`;
    const result = spawnSync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        graph,
        outPath,
    ]);
    assert.equal(result.status, 0, `failed to render ${name}: ${result.stderr}`);
    return outPath;
}

// Runs the real translation-mixer filter graph (the same function the mixer
// service calls) through a real ffmpeg process, with the same stdio shape
// production uses. fd 3 carries the astats/ametadata "translator meter" line
// the real mixer parses (see METER_VOICE_PATTERN in translationMixer.ts —
// duplicated here rather than imported, since it's an internal format detail);
// draining and parsing it here mirrors production and lets tests assert on
// the same live-voice-detection signal the mixer's duck/restore logic uses.
async function runMixer(sourcePath, translatorPath, outName) {
    const outPath = path.join(tempDir, outName);
    const controlPort = await getFreePort();
    const args = buildTranslationMixerArgs(sourcePath, translatorPath, outPath, {
        videoEncoding: 'copy',
        translationDelayMs: 0,
        voiceThresholdDb: -20,
        controlPort,
        duckVolumeDb: -24,
        duckDurationMs: 900,
        restoreSilenceMs: 2000,
        restoreVolumeDb: -6,
        restoreDurationMs: 5000,
    });
    const meterSamples = [];
    await new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        let meterBuffer = '';
        child.stdio[3].on('data', (chunk) => {
            meterBuffer += chunk.toString('utf8');
            const lines = meterBuffer.split(/\r?\n/);
            meterBuffer = lines.pop() ?? '';
            for (const line of lines) {
                const match = line.match(
                    /lavfi\.astats\.Overall\.Peak_level=(-?\d+(?:\.\d+)?|-inf)/,
                );
                if (match) meterSamples.push(match[1] === '-inf' ? -Infinity : Number(match[1]));
            }
        });
        child.stdout.on('data', () => {});
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`mixer ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
        });
    });
    return { outPath, meterSamples };
}

// True digital silence prints "-inf" for every RMS/Peak line; any real signal
// prints a finite dB value instead — a clean binary marker, unlike
// volumedetect's noisy noise-floor readings.
function hasAudioSignal(filePath) {
    const result = spawnSync('ffmpeg', [
        '-hide_banner',
        '-i',
        filePath,
        '-vn',
        '-af',
        'astats=metadata=0',
        '-f',
        'null',
        '-',
    ]);
    return /RMS level dB:\s*-?\d/.test(result.stderr.toString());
}

test('translator speech reaches the output even when the source is silent', { skip }, async () => {
    const source = renderClip('silent-source.wav', 'silence');
    const translator = renderClip('speaking-translator.wav', 'tone');
    const { outPath } = await runMixer(source, translator, 'translator-through.flv');
    assert.equal(hasAudioSignal(outPath), true, 'expected translator audio in the mixed output');
});

test(
    'the output stays audible when the translator is silent but the source is not',
    { skip },
    async () => {
        const source = renderClip('speaking-source.wav', 'tone');
        const translator = renderClip('silent-translator.wav', 'silence');
        const { outPath } = await runMixer(source, translator, 'source-through.flv');
        assert.equal(hasAudioSignal(outPath), true, 'expected source audio in the mixed output');
    },
);

// Regression test for a real production bug: astats' `reset` option is a
// frame count, not seconds. A value that rounds/truncates to 0 disables
// periodic reset, making Overall.Peak_level a cumulative high-water mark for
// the whole ffmpeg process instead of a live reading — once the translator
// has ever spoken, the reported peak never comes back down on its own, so
// the mixer keeps thinking it's still speaking and the source stays
// ducked/low through real silence (only a restart of the output "fixes" it,
// until the translator speaks and goes quiet again). See buildTranslationMixerArgs'
// astats reset comment for the fix.
test(
    'the translator meter reflects real silence after speech, not a stuck historical peak',
    { skip },
    async () => {
        const source = renderClip('meter-check-source.wav', 'silence', 3);
        const translator = renderSpeakThenSilentClip('meter-check-translator.wav', 2);
        const { meterSamples } = await runMixer(source, translator, 'meter-check.flv');

        assert.ok(meterSamples.length > 10, 'expected multiple meter samples over the 3s clip');
        const third = Math.floor(meterSamples.length / 3);
        const early = meterSamples.slice(0, third);
        const late = meterSamples.slice(-third);

        // Checked as finite-vs-true-silence rather than against
        // voiceThresholdDb: the exact measured level depends on filter-graph
        // details (resampling, channel handling) unrelated to what this test
        // is about. What a stuck cumulative peak gets wrong is specifically
        // that it never reports true digital silence (-Infinity) again once
        // it has seen a real signal — that's the one thing this checks.
        assert.ok(
            early.some((db) => Number.isFinite(db)),
            'expected a real (non-silent) reading while the translator is speaking',
        );
        assert.ok(
            late.every((db) => db === -Infinity),
            'meter must decay to true silence once the translator goes silent, not stay stuck at the earlier peak',
        );
    },
);
