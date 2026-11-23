// The input status rules (src/utils/inputStatus.ts): the state of a pipeline's input and why.
// They run on the server only; the dashboard shows the verdict they produce.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    INPUT_ALERT_CODES,
    NO_SIGNAL_MESSAGE,
    inputHealth,
    reportedInputState,
    toInputStatusEntry,
} from '../src/utils/inputStatus';
import type { InputStatusEntry } from '../src/utils/inputStatus';
import type { PipelineAlert } from '../src/utils/srtLinkAlerts';

const T = 1_700_000_000_000;

const input = (over: Partial<InputStatusEntry> = {}): InputStatusEntry => ({
    connected: true,
    live: true,
    mediaOk: true,
    mediaError: null,
    uptimeMs: 120_000,
    recvBitrateKbps: 6000,
    audioTracks: [{ index: 0 }],
    audio: null,
    ...over,
});
const alert = (
    code: string,
    severity: PipelineAlert['severity'],
    over: Partial<PipelineAlert> = {},
): PipelineAlert => ({
    code,
    severity,
    message: `${code} happened`,
    sinceMs: T,
    ...over,
});

describe('inputHealth', () => {
    test('not connected is off', () => {
        assert.deepEqual(inputHealth(input({ connected: false })), { status: 'off', issues: [] });
    });

    test('a failed probe is an error and outranks the pending state', () => {
        const v = inputHealth(input({ mediaOk: false, mediaError: '10:00:00 ffprobe failed' }));
        assert.equal(v.status, 'error');
        assert.equal(v.issues[0].message, '10:00:00 ffprobe failed');
        assert.equal(inputHealth(input({ mediaOk: null, mediaError: 'boom' })).status, 'error');
        assert.equal(
            inputHealth(input({ mediaOk: false })).issues[0].message,
            'Input connected, waiting for valid media.',
        );
    });

    test('a failed probe says since when, for the dashboard to show in the viewer time', () => {
        const v = inputHealth(
            input({ mediaOk: false, mediaError: 'ffprobe failed', mediaFailingSince: 5000 }),
        );
        assert.equal(v.issues[0].sinceMs, 5000);
        assert.equal(
            inputHealth(input({ mediaOk: false, mediaError: 'x' })).issues[0].sinceMs,
            undefined,
        );
    });

    test('waiting for the first probe, or for media, warns', () => {
        assert.match(
            inputHealth(input({ mediaOk: null })).issues[0].message,
            /Waiting for ffprobe/,
        );
        assert.match(
            inputHealth(input({ live: false })).issues[0].message,
            /waiting for valid media/,
        );
    });

    test('a healthy input is good', () => {
        assert.deepEqual(inputHealth(input()), { status: 'good', issues: [] });
    });

    test('low bitrate warns below 200 kb/s, and only once SRS has real statistics (30 s)', () => {
        assert.equal(inputHealth(input({ recvBitrateKbps: 199 })).status, 'warn');
        assert.equal(inputHealth(input({ recvBitrateKbps: 200 })).status, 'good');
        assert.equal(inputHealth(input({ recvBitrateKbps: 0, uptimeMs: 29_999 })).status, 'good');
        const low = inputHealth(input({ recvBitrateKbps: 0, uptimeMs: 30_000 }));
        assert.equal(low.status, 'warn');
        assert.match(low.issues[0].message, /Input bitrate is below 200 kb\/s/);
    });

    test('no audio track warns', () => {
        const v = inputHealth(input({ audioTracks: [], audio: null }));
        assert.equal(v.status, 'warn');
        assert.equal(v.issues[0].message, 'No audio track detected in input.');
        assert.equal(v.issues[0].code, 'input-no-audio');
        assert.equal(
            inputHealth(input({ audioTracks: [], audio: { codec: 'aac' } })).status,
            'good',
        );
    });

    test('an alert about the input is listed with its code, severity and start', () => {
        const v = inputHealth(input(), [alert('input-interlaced', 'warning')]);
        assert.equal(v.status, 'warn');
        assert.deepEqual(v.issues, [
            {
                severity: 'warning',
                message: 'input-interlaced happened',
                code: 'input-interlaced',
                sinceMs: T,
            },
        ]);
        const error = inputHealth(input(), [
            alert('input-interlaced', 'warning'),
            alert('input-flapping', 'error'),
        ]);
        assert.equal(error.status, 'error');
        assert.equal(error.issues.length, 2);
    });

    test('an alert about the relay link is not part of the input status', () => {
        assert.deepEqual(inputHealth(input(), [alert('srt-packets-dropped', 'error')]), {
            status: 'good',
            issues: [],
        });
    });

    test('alerts are only looked at once the input is live with good media', () => {
        const flapping = [alert('input-flapping', 'error')];
        assert.equal(inputHealth(input({ live: false }), flapping).status, 'warn');
        assert.equal(inputHealth(input({ connected: false }), flapping).status, 'off');
    });

    // Every state an input can be in, for the checks that hold whatever the state.
    function* states() {
        const ALERTS = [
            [],
            [alert('input-interlaced', 'warning')],
            [alert('input-flapping', 'error')],
            [alert('srt-packets-dropped', 'warning')],
        ];
        for (const connected of [true, false])
            for (const live of [true, false])
                for (const mediaOk of [null, true, false])
                    for (const mediaError of [null, 'ffprobe could not read the stream'])
                        for (const recvBitrateKbps of [null, 0, 100, 4000])
                            for (const uptimeMs of [null, 5_000, 120_000])
                                for (const audioTracks of [[], [{}]])
                                    for (const alerts of ALERTS)
                                        yield {
                                            i: input({
                                                connected,
                                                live,
                                                mediaOk,
                                                mediaError,
                                                recvBitrateKbps,
                                                uptimeMs,
                                                audioTracks,
                                            }),
                                            alerts,
                                        };
    }

    test('whatever the state: a status always comes with the right issues', () => {
        let n = 0;
        for (const { i, alerts } of states()) {
            const v = inputHealth(i, alerts);
            const label = JSON.stringify([i, alerts]);
            assert.equal(v.status === 'off', !i.connected, label);
            if (v.status === 'good' || v.status === 'off') {
                assert.deepEqual(v.issues, [], label);
            } else {
                assert.ok(v.issues.length >= 1, label);
                const errors = v.issues.filter((x) => x.severity === 'error');
                assert.equal(errors.length > 0, v.status === 'error', label);
            }
            if (v.status === 'good') {
                assert.equal(i.live && i.mediaOk && !i.mediaError, true, label);
            }
            if (i.connected && (i.mediaError || i.mediaOk === false)) {
                assert.equal(v.status, 'error', label);
            }
            n++;
        }
        assert.ok(n > 1500);
    });
});

describe('toInputStatusEntry', () => {
    test('nothing seen yet is an input that is not connected', () => {
        assert.deepEqual(toInputStatusEntry(undefined), {
            connected: false,
            live: false,
            mediaOk: null,
            mediaError: null,
            recvBitrateKbps: null,
            uptimeMs: null,
            audioTracks: [],
            audio: null,
        });
    });

    test('what is known overrides the defaults', () => {
        const entry = toInputStatusEntry({ live: true, connected: true, uptimeMs: 5 });
        assert.equal(entry.live, true);
        assert.equal(entry.uptimeMs, 5);
        assert.equal(entry.mediaOk, null);
    });
});

describe('reportedInputState: the status Key Vault gets', () => {
    const reported = (i: InputStatusEntry, alerts: PipelineAlert[] = [], outputsShouldRun = true) =>
        reportedInputState(i, alerts, outputsShouldRun);

    test('good is running, warn is warning with the first problem, error is error', () => {
        assert.deepEqual(reported(input()), { status: 'running', message: '' });
        assert.deepEqual(reported(input({ audioTracks: [] })), {
            status: 'warning',
            message: 'No audio track detected in input.',
        });
        assert.deepEqual(reported(input({ mediaError: 'bad stream' })), {
            status: 'error',
            message: 'bad stream',
        });
    });

    test('no signal is an error while an output should run, and idle when none should', () => {
        const off = input({ connected: false, live: false });
        assert.deepEqual(reported(off, [], true), { status: 'error', message: NO_SIGNAL_MESSAGE });
        assert.deepEqual(reported(off, [], false), { status: 'stopped', message: '' });
    });
});

describe('INPUT_ALERT_CODES', () => {
    test('is the alerts about the input itself', () => {
        assert.deepEqual([...INPUT_ALERT_CODES].sort(), [
            'input-flapping',
            'input-high-framerate',
            'input-interlaced',
            'input-keyframe-interval',
            'input-low-framerate',
        ]);
    });
});
