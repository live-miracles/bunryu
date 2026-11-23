// The values the server's status rules and the dashboard both hold, because neither side can
// import the other's code. The rules themselves are on the server only (outputStatus.test.ts,
// inputStatus.test.ts); these are the few numbers and lists the dashboard repeats for display.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_ALERT_CODES as dashboardAlertCodes } from '../public/ts/core/pipeline';
import { LOW_BITRATE_KBPS } from '../public/ts/core/utils';
import {
    displayInputBitrateKbps,
    summarizeOutputError as dashboardSummarize,
} from '../public/ts/core/status';
import { INPUT_ALERT_CODES, inputHealth } from '../src/utils/inputStatus';
import {
    outputHealth,
    summarizeOutputError,
    type OutputStatusView,
} from '../src/utils/outputStatus';
import type { AudioTrackInfo, InputHealth } from '../public/ts/types';

// A live, probed input that has been up for `uptimeMs`, with one audio track. The dashboard's
// InputHealth also satisfies the server's InputStatusEntry, so both sides judge the same value.
function inputAt(recvBitrateKbps: number, uptimeMs: number): InputHealth {
    const track: AudioTrackInfo = {
        index: 0,
        codec: 'aac',
        sampleRate: 48000,
        channels: 2,
        profile: 'LC',
        language: null,
        title: null,
        pid: null,
    };
    return {
        connected: true,
        live: true,
        isSrt: false,
        mediaOk: true,
        mediaProbeStartedAt: null,
        mediaCheckedAt: null,
        mediaFailingSince: null,
        mediaError: null,
        keyframes: null,
        recvBitrateKbps,
        sendBitrateKbps: null,
        readers: 0,
        uptimeMs,
        publisherIp: null,
        publisherType: null,
        video: null,
        audio: null,
        audioTracks: [track],
    };
}

// A running output that has been up since 1 ms, sending `bitrateKbps`.
function runningOutput(bitrateKbps: number): OutputStatusView {
    return {
        id: '1-1',
        name: 'Out',
        url: 'rtmp://a.example/live/k',
        desiredState: 'running',
        videoEncoding: 'copy',
        audioEncoding: 'copy',
        status: 'running',
        failures: 0,
        lastError: null,
        lastErrorAt: null,
        warningReason: null,
        warningSinceMs: null,
        startedAtMs: 1,
        bitrateKbps,
        renditionId: null,
        ready: null,
        sharedEncode: null,
    };
}

describe('what the dashboard repeats from the server', () => {
    test('the alerts that belong to the input', () => {
        assert.deepEqual([...dashboardAlertCodes].sort(), [...INPUT_ALERT_CODES].sort());
    });

    test('the low bitrate floor: the dashboard flags the same bitrates as the server', () => {
        const input = (recvBitrateKbps: number) => inputAt(recvBitrateKbps, 120_000);
        assert.equal(inputHealth(input(LOW_BITRATE_KBPS - 1)).status, 'warn');
        assert.equal(inputHealth(input(LOW_BITRATE_KBPS)).status, 'good');
        const output = runningOutput;
        assert.equal(outputHealth(output(LOW_BITRATE_KBPS - 1), { live: true }).status, 'warn');
        assert.equal(outputHealth(output(LOW_BITRATE_KBPS), { live: true }).status, 'good');
    });

    test('the 30 s the dashboard hides SRS startup zero bitrate for is the server warm-up', () => {
        const at = (uptimeMs: number) => inputAt(0, uptimeMs);
        const cases: [number, number | null, string][] = [
            [29_999, null, 'good'],
            [30_000, 0, 'warn'],
        ];
        for (const [uptimeMs, shown, status] of cases) {
            assert.equal(displayInputBitrateKbps(at(uptimeMs)), shown, `shown at ${uptimeMs}`);
            assert.equal(inputHealth(at(uptimeMs)).status, status, `judged at ${uptimeMs}`);
        }
    });

    test('an error is cut to one line of at most 160 characters the same way', () => {
        const long = `first\n${'x'.repeat(300)}  \n`;
        const cases: [string | null, string][] = [
            [long, 'f'],
            [null, 'f'],
            ['  a   b  \n', 'f'],
        ];
        for (const [error, fallback] of cases) {
            assert.equal(
                summarizeOutputError(error, fallback),
                dashboardSummarize(error, fallback),
            );
        }
    });
});
