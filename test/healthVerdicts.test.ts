// The verdicts the server works out for /api/health (src/utils/healthVerdicts.ts): one for every
// saved input and output, from the saved rows and the last poll. The rules behind them are
// tested in outputStatus.test.js and inputStatus.test.js; this is how they are applied.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthVerdicts, UNKNOWN_VERDICT } from '../src/utils/healthVerdicts';

const T = 1_700_000_000_000;
const RENDITION_URL = 'rtmp://127.0.0.1:21935/internal/r1_720p_acopy';

const pipelines = [{ id: 1, name: 'Hindi', streamKey: 'k', streamKeyId: 1, groupId: null }];

const row = (id, overrides = {}) => ({
    id,
    pipelineId: 1,
    seq: Number(id.split('-')[1]),
    name: `out ${id}`,
    desiredState: 'running',
    videoEncoding: 'copy',
    url: `rtmp://dest.example/live/${id}`,
    audioEncoding: 'copy',
    lastError: null,
    hasErrorHistory: false,
    ...overrides,
});

const entry = (overrides = {}) => ({
    status: 'running',
    pid: 1,
    bitrateKbps: 4000,
    startedAtMs: T,
    failures: 0,
    nextRetryAtMs: null,
    warningReason: null,
    warningSinceMs: null,
    lastError: null,
    hasErrorHistory: false,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    cpuPercent: null,
    speed: null,
    role: 'output',
    renditionId: null,
    ready: null,
    readers: null,
    ...overrides,
});

const alert = (code, severity) => ({ severity, code, message: `${code} happened`, sinceMs: T });

const inputEntry = (over = {}) => ({
    connected: true,
    live: true,
    isSrt: false,
    mediaOk: true,
    mediaProbeStartedAt: null,
    mediaCheckedAt: null,
    mediaError: null,
    keyframes: null,
    recvBitrateKbps: 4000,
    sendBitrateKbps: null,
    readers: 0,
    uptimeMs: 120_000,
    publisherIp: null,
    publisherType: null,
    video: null,
    audio: null,
    audioTracks: [{}],
    ...over,
});

// The verdicts for one pipeline: `health` is its health entry, or undefined before a poll has
// seen it.
const verdictsFor = (rows, health) =>
    buildHealthVerdicts({ pipelines, outputs: rows, health: health ? { 1: health } : {} });

describe('health verdicts', () => {
    test('an output has the verdict of its state', () => {
        const health = (over, live = true) => ({
            input: inputEntry({ live }),
            outputs: { '1-1': entry(over) },
            alerts: [],
        });
        const verdict = (over, live, desiredState = 'running') =>
            verdictsFor([row('1-1', { desiredState })], health(over, live)).outputs['1-1'];

        assert.deepEqual(verdict({}), { status: 'good', issues: [] });
        assert.deepEqual(verdict({ status: 'failed' }, true, 'stopped'), {
            status: 'off',
            issues: [],
        });
        assert.equal(verdict({ status: 'failed', failures: 2 }).status, 'error');
        assert.equal(
            verdict({ warningReason: 'Falling behind' }).issues[0].message,
            'Falling behind',
        );
        assert.match(verdict({}, false).issues[0].message, /input is not live/);
        assert.equal(verdict({}).withoutInput, undefined, 'only a shared encode has one');
    });

    test('an input has the verdict of its state, its alerts with their code and age', () => {
        const input = (over, alerts = []) =>
            verdictsFor([], { input: inputEntry(over), outputs: {}, alerts }).inputs[1];

        assert.deepEqual(input({}), { status: 'good', issues: [] });
        assert.deepEqual(input({ connected: false, live: false }), { status: 'off', issues: [] });
        assert.equal(input({ mediaError: 'ffprobe failed' }).status, 'error');
        assert.deepEqual(input({}, [alert('input-interlaced', 'warning')]), {
            status: 'warn',
            issues: [
                {
                    severity: 'warning',
                    message: 'input-interlaced happened',
                    code: 'input-interlaced',
                    sinceMs: T,
                },
            ],
        });
        // An alert about the relay link is not part of the input's verdict.
        assert.equal(input({}, [alert('srt-packets-dropped', 'error')]).status, 'good');
    });

    test('a shared encode also has its verdict without the input; its outputs wait for it', () => {
        const rows = (renditionDesired = 'running') => [
            row('1-1', { videoEncoding: '720p' }),
            row('1-2', { videoEncoding: '720p' }),
            row('1-9', {
                videoEncoding: '720p',
                url: RENDITION_URL,
                name: 'Shared encode 720p',
                desiredState: renditionDesired,
            }),
        ];
        const health = (live, encode) => ({
            input: inputEntry({ live }),
            outputs: {
                '1-1': entry({ status: 'stopped', startedAtMs: null }),
                '1-2': entry({ status: 'running', startedAtMs: T, renditionId: '1-9' }),
                '1-9': entry({ role: 'rendition', ready: true, ...encode }),
            },
            alerts: [],
        });

        // The input is down: the encode's verdict says so, its own state does not.
        const down = verdictsFor(rows(), health(false, {})).outputs;
        assert.equal(down['1-9'].status, 'warn');
        assert.match(down['1-9'].issues[0].message, /input is not live/);
        assert.deepEqual(down['1-9'].withoutInput, { status: 'good', issues: [] });
        assert.equal(down['1-1'].withoutInput, undefined);

        // The encode is not ready yet: the output that will read it is waiting, not failed.
        const notReady = verdictsFor(rows(), health(true, { ready: false })).outputs;
        assert.equal(notReady['1-1'].status, 'warn');
        assert.equal(notReady['1-1'].issues[0].message, 'Waiting for Shared encode 720p');
        // The one already reading it is fine.
        assert.equal(notReady['1-2'].status, 'good');
    });

    test('before a poll has seen the pipeline, or an output', () => {
        const rows = [row('1-1'), row('1-2', { desiredState: 'stopped' })];
        const unseen = verdictsFor(rows, undefined);
        assert.deepEqual(unseen.inputs[1], { status: 'off', issues: [] });
        assert.equal(unseen.outputs['1-1'].status, 'warn');
        assert.match(unseen.outputs['1-1'].issues[0].message, /waiting to start or retry/);
        assert.deepEqual(unseen.outputs['1-2'], { status: 'off', issues: [] });

        // The pipeline is known, one output is not: the same for that output.
        const half = verdictsFor(rows, { input: inputEntry(), outputs: {}, alerts: [] });
        assert.equal(half.inputs[1].status, 'good');
        assert.equal(half.outputs['1-1'].status, 'warn');
    });

    test('there is a verdict for every saved pipeline and output, and for nothing else', () => {
        const verdicts = buildHealthVerdicts({
            pipelines: [
                ...pipelines,
                { id: 2, name: 'Tamil', streamKey: 'k2', streamKeyId: 2, groupId: null },
            ],
            outputs: [row('1-1'), row('1-2'), row('2-1', { pipelineId: 2 })],
            // A pipeline that was deleted still has an entry in the last poll.
            health: {
                1: { input: inputEntry(), outputs: { '1-1': entry() }, alerts: [] },
                9: undefined,
            },
        });
        assert.deepEqual(Object.keys(verdicts.inputs).sort(), ['1', '2']);
        assert.deepEqual(Object.keys(verdicts.outputs).sort(), ['1-1', '1-2', '2-1']);
    });
});

describe('health verdicts: one that cannot be worked out', () => {
    test('is unknown and reported, and the rest are not affected', () => {
        const poisoned = entry();
        Object.defineProperty(poisoned, 'status', {
            get() {
                throw new Error('bad data');
            },
        });
        const reported = [];
        const verdicts = buildHealthVerdicts(
            {
                pipelines: [
                    ...pipelines,
                    { id: 2, name: 'Tamil', streamKey: 'k2', streamKeyId: 2, groupId: null },
                ],
                outputs: [row('1-1'), row('1-2'), row('2-1', { pipelineId: 2 })],
                health: {
                    1: { input: inputEntry(), outputs: { '1-1': poisoned }, alerts: [] },
                    2: {
                        input: inputEntry(),
                        outputs: { '2-1': entry() },
                        alerts: [],
                    },
                },
            },
            (what, id, err) => reported.push([what, id, err.message]),
        );

        // The pipeline's outputs cannot be read together, so each is unknown...
        assert.deepEqual(verdicts.outputs['1-1'], UNKNOWN_VERDICT);
        assert.deepEqual(verdicts.outputs['1-2'], UNKNOWN_VERDICT);
        assert.deepEqual(reported, [
            ['output', '1-1', 'bad data'],
            ['output', '1-2', 'bad data'],
        ]);
        // ...and that pipeline's input and the other pipeline are as usual.
        assert.equal(verdicts.inputs[1].status, 'good');
        assert.equal(verdicts.outputs['2-1'].status, 'good');
        assert.equal(verdicts.inputs[2].status, 'good');
    });

    test('an input that cannot be read is unknown; its outputs are still worked out', () => {
        const reported = [];
        const verdicts = buildHealthVerdicts(
            {
                pipelines,
                outputs: [row('1-1')],
                health: {
                    1: {
                        input: inputEntry(),
                        outputs: { '1-1': entry() },
                        alerts: [null],
                    },
                },
            },
            (what, id) => reported.push([what, id]),
        );
        assert.deepEqual(verdicts.inputs[1], UNKNOWN_VERDICT);
        assert.deepEqual(reported, [['input', '1']]);
        assert.equal(verdicts.outputs['1-1'].status, 'good');
    });
});
