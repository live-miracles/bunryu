import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_MESSAGE_LENGTH,
    buildPayload,
    createSinceTracker,
    hashDestination,
    normalizeDestinationUrl,
    payloadSignature,
    redactMessage,
    type PayloadSource,
} from '../src/utils/keyVaultPayload';
import type { PipelineStatusHealth } from '../src/utils/healthVerdicts';
import type { InputStatusEntry } from '../src/utils/inputStatus';
import type { OutputHealthEntry } from '../src/utils/outputStatus';
import type { Output, Pipeline } from '../src/types';

// The JSON fixture is read with require: the test tsconfig has no resolveJsonModule.
const vectors = require('./fixtures/key-vault-hash-vectors.json') as {
    secret: string;
    vectors: { description: string; url: string; normalized: string; hash: string }[];
};

describe('destination hash', () => {
    test('matches every shared test vector, which Key Vault must reproduce', () => {
        assert.ok(vectors.vectors.length >= 4);
        for (const v of vectors.vectors) {
            assert.equal(normalizeDestinationUrl(v.url), v.normalized, v.description);
            assert.equal(hashDestination(vectors.secret, v.url), v.hash, v.description);
        }
    });

    test('the vectors cover the destinations Key Vault builds', () => {
        const urls = vectors.vectors.map((v) => v.url).join('\n');
        assert.match(urls, /rtmp:\/\/a\.rtmp\.youtube\.com\/live2\//);
        assert.match(urls, /rtmp:\/\/b\.rtmp\.youtube\.com\/live2\?backup=1\//);
        assert.match(urls, /rtmps:\/\//);
        assert.match(urls, /srt:\/\//);
    });

    test('a hash is 32 lowercase hex characters and depends on the secret', () => {
        const url = 'rtmp://a.example/live/key';
        const hash = hashDestination('first-secret-0123456789', url);
        assert.match(hash, /^[0-9a-f]{32}$/);
        assert.notEqual(hashDestination('other-secret-0123456789', url), hash);
    });

    test('normalising lowers the scheme and host only, and drops trailing slashes and spaces', () => {
        assert.equal(
            normalizeDestinationUrl('  RTMPS://Live.Example.COM:443/App/KeyAbC//  '),
            'rtmps://live.example.com:443/App/KeyAbC',
        );
        assert.equal(normalizeDestinationUrl('rtmp://HOST/'), 'rtmp://host');
        assert.equal(normalizeDestinationUrl('rtmp://HOST'), 'rtmp://host');
        assert.equal(
            normalizeDestinationUrl('srt://Host:9000?streamid=AbC&Mode=caller'),
            'srt://host:9000?streamid=AbC&Mode=caller',
        );
        assert.equal(
            normalizeDestinationUrl('rtmp://User:Pw@Host.Example/live'),
            'rtmp://User:Pw@host.example/live',
        );
        assert.equal(normalizeDestinationUrl('not a url/'), 'not a url');
    });

    test('URLs that differ only in what is normalised away hash the same', () => {
        const secret = 'a-secret-of-some-length';
        assert.equal(
            hashDestination(secret, 'RTMP://A.example/live/key/'),
            hashDestination(secret, ' rtmp://a.example/live/key '),
        );
        assert.notEqual(
            hashDestination(secret, 'rtmp://a.example/live/KEY'),
            hashDestination(secret, 'rtmp://a.example/live/key'),
        );
    });
});

describe('redactMessage', () => {
    test('leaves an ordinary message alone', () => {
        assert.equal(
            redactMessage('Output is running but no bitrate is reported yet.'),
            'Output is running but no bitrate is reported yet.',
        );
        assert.equal(redactMessage(''), '');
        assert.equal(
            redactMessage('Non-monotonic DTS in output stream 0:1; discontinuity 3 times'),
            'Non-monotonic DTS in output stream 0:1; discontinuity 3 times',
        );
    });

    test('removes rtmp, rtmps, srt and other URLs with the stream key in them', () => {
        const out = redactMessage(
            'Failed to open rtmp://a.rtmp.youtube.com/live2/abcd-1234-efgh-5678-ijkl, then rtmps://live-api-s.facebook.com:443/rtmp/FB-123-0-Secret and srt://203.0.113.9:9000?mode=caller; http://x.example/p?token=abc',
        );
        assert.doesNotMatch(out, /youtube|facebook|203\.0\.113|abcd|Secret|x\.example|abc/);
        assert.equal(out, 'Failed to open <url>, then <url> and <url>; <url>');
    });

    test('removes streamid, passphrase and key values, quoted or not', () => {
        const out = redactMessage(
            'bad streamid=#!::r=live/key01_AbCd,m=publish passphrase=hunter2hunter2 key=s3cr3t stream_key="two words" x-token=q',
        );
        assert.doesNotMatch(out, /key01_|hunter2|s3cr3t|two words|=q\b/);
        assert.match(out, /streamid=<redacted>/);
        assert.match(out, /passphrase=<redacted>/);
        assert.match(out, /key=<redacted>/);
        assert.match(out, /stream_key=<redacted>/);
        assert.match(out, /x-token=<redacted>/);
    });

    test('removes a bare stream key and other long token-like strings', () => {
        const out = redactMessage(
            'key abcd-1234-efgh-5678 and abcd-1234-efgh-5678-ijkl and key01_9f8e7d6c5b4a3210 and 0123456789abcdef0123456789abcdef and ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGH',
        );
        assert.equal(
            out,
            'key <redacted> and <redacted> and <redacted> and <redacted> and <redacted>',
        );
    });

    test('keeps long words without digits that are not secrets', () => {
        assert.equal(
            redactMessage('misconfiguration_internal happened'),
            'misconfiguration_internal happened',
        );
    });

    test('joins lines and cuts to 300 characters, after redacting', () => {
        const out = redactMessage(`line one\n\nline   two\r\n${'word '.repeat(200)}`);
        assert.ok(out.length <= MAX_MESSAGE_LENGTH);
        assert.ok(out.endsWith('...'));
        assert.ok(out.startsWith('line one line two word word'));
        assert.doesNotMatch(out, /\n/);
    });

    test('a secret that straddles the cut is redacted, not cut in half', () => {
        const padding = 'a b '.repeat(73); // 292 characters
        const out = redactMessage(`${padding}rtmp://host.example/live/SECRETKEY99`);
        assert.doesNotMatch(out, /SECRET|host\.example|rtmp/);
        assert.ok(out.length <= MAX_MESSAGE_LENGTH);
    });
});

describe('buildPayload', () => {
    const T = 1_700_000_000_000;
    const SECRET = 'payload-test-secret-0123456789';
    const pipelines: Pipeline[] = [
        { id: 1, name: 'Hindi', streamKey: 'k1', streamKeyId: 1, groupId: null },
        { id: 2, name: 'Tamil', streamKey: 'k2', streamKeyId: 2, groupId: null },
    ];
    const out = (id: string, pipelineId: number, over: Partial<Output> = {}): Output => ({
        id,
        pipelineId,
        seq: 1,
        name: `Output ${id}`,
        desiredState: 'running',
        videoEncoding: 'copy',
        url: `rtmp://dest.example/live/${id}`,
        audioEncoding: 'copy',
        watchUrl: '',
        lastError: null,
        hasErrorHistory: false,
        ...over,
    });
    const healthEntry = (over: Partial<OutputHealthEntry> = {}): OutputHealthEntry => ({
        status: 'running',
        bitrateKbps: 4000,
        startedAtMs: T - 60_000,
        failures: 0,
        warningReason: null,
        warningSinceMs: null,
        lastError: null,
        renditionId: null,
        ready: null,
        ...over,
    });
    const source = (over: Partial<PayloadSource> = {}): PayloadSource => ({
        instance: 'prod',
        hashSecret: SECRET,
        pipelines,
        outputs: [out('1-1', 1), out('2-1', 2, { desiredState: 'stopped' })],
        health: {
            1: { input: { live: true }, outputs: { '1-1': healthEntry() } },
            2: { input: { live: false }, outputs: { '2-1': healthEntry({ status: 'stopped' }) } },
        },
        since: createSinceTracker(),
        nowMs: T,
        ...over,
    });

    test('has the heartbeat shape, with a hash instead of the URL', () => {
        const payload = buildPayload(source());
        assert.deepEqual(Object.keys(payload), [
            'version',
            'instance',
            'sentAt',
            'outputs',
            'inputs',
        ]);
        assert.equal(payload.version, 1);
        assert.equal(payload.instance, 'prod');
        assert.equal(payload.sentAt, new Date(T).toISOString());
        assert.deepEqual(payload.outputs, [
            {
                hash: hashDestination(SECRET, 'rtmp://dest.example/live/1-1'),
                pipeline: 'Hindi',
                output: 'Output 1-1',
                status: 'running',
                message: '',
                failures: 0,
                stoppedAfterFailures: false,
                sinceMs: T - 60_000,
            },
            {
                hash: hashDestination(SECRET, 'rtmp://dest.example/live/2-1'),
                pipeline: 'Tamil',
                output: 'Output 2-1',
                status: 'stopped',
                message: '',
                failures: 0,
                stoppedAfterFailures: false,
                sinceMs: T,
            },
        ]);
        assert.doesNotMatch(JSON.stringify(payload), /dest\.example/);
    });

    test('maps warning, error and a stop after failures, with redacted messages', () => {
        const payload = buildPayload(
            source({
                outputs: [
                    out('1-1', 1),
                    out('1-2', 1),
                    out('2-1', 2, {
                        desiredState: 'stopped',
                        lastError: `${T - 5000}\nConnection to rtmp://a.example/live/KEY123abc failed`,
                    }),
                ],
                health: {
                    1: {
                        input: { live: true },
                        outputs: {
                            '1-1': healthEntry({
                                warningReason: 'Timestamps jumping on rtmp://a.example/live/K1',
                                warningSinceMs: T - 1000,
                            }),
                            '1-2': healthEntry({
                                status: 'failed',
                                failures: 3,
                                lastError: `${T - 2000}\nstreamid=#!::r=live/key01_x,m=publish refused`,
                            }),
                        },
                    },
                    2: {
                        input: { live: true },
                        outputs: {
                            '2-1': healthEntry({
                                status: 'stopped',
                                lastError: `${T - 5000}\nConnection to rtmp://a.example/live/KEY123abc failed`,
                            }),
                        },
                    },
                },
                failedAttemptsOf: (id: string) => (id === '2-1' ? 8 : 0),
            }),
        );
        const [warning, error, stopped] = payload.outputs;
        assert.equal(warning.status, 'warning');
        assert.equal(warning.message, 'Timestamps jumping on <url>');
        assert.equal(warning.sinceMs, T - 1000);
        assert.equal(error.status, 'error');
        assert.equal(error.failures, 3);
        assert.equal(error.sinceMs, T - 2000);
        assert.doesNotMatch(error.message, /key01_/);
        assert.equal(stopped.status, 'error');
        assert.equal(stopped.stoppedAfterFailures, true);
        assert.equal(stopped.failures, 8);
        assert.equal(stopped.message, 'Connection to <url> failed');
    });

    test('an output stopped by the operator is plain stopped, even with an old error', () => {
        const payload = buildPayload(
            source({
                outputs: [out('1-1', 1, { desiredState: 'stopped', lastError: null })],
                health: {
                    1: {
                        input: { live: true },
                        outputs: { '1-1': healthEntry({ status: 'stopped', lastError: null }) },
                    },
                },
            }),
        );
        assert.equal(payload.outputs[0].status, 'stopped');
        assert.equal(payload.outputs[0].stoppedAfterFailures, false);
    });

    test('leaves out the shared-encode rows', () => {
        const payload = buildPayload(
            source({
                outputs: [
                    out('1-1', 1, { videoEncoding: '720p' }),
                    out('1-2', 1, { videoEncoding: '720p' }),
                    out('1-9', 1, {
                        videoEncoding: '720p',
                        url: 'rtmp://127.0.0.1:21935/internal/r1_720p_acopy',
                        name: 'Shared encode 720p',
                    }),
                ],
                health: {
                    1: {
                        input: { live: true },
                        outputs: {
                            '1-1': healthEntry({ renditionId: '1-9' }),
                            '1-2': healthEntry({ renditionId: '1-9' }),
                            '1-9': healthEntry({ ready: true }),
                        },
                    },
                },
            }),
        );
        assert.deepEqual(
            payload.outputs.map((o) => o.output),
            ['Output 1-1', 'Output 1-2'],
        );
        assert.ok(payload.outputs.every((o) => o.status === 'running'));
    });

    test('an output waiting for a shared encode is a warning', () => {
        const payload = buildPayload(
            source({
                outputs: [
                    out('1-1', 1, { videoEncoding: '720p' }),
                    out('1-2', 1, { videoEncoding: '720p' }),
                    out('1-9', 1, {
                        videoEncoding: '720p',
                        url: 'rtmp://127.0.0.1:21935/internal/r1_720p_acopy',
                        name: 'Shared encode 720p',
                    }),
                ],
                health: {
                    1: {
                        input: { live: true },
                        outputs: {
                            '1-1': healthEntry({ status: 'stopped', startedAtMs: null }),
                            '1-2': healthEntry({ renditionId: '1-9' }),
                            '1-9': healthEntry({ ready: false }),
                        },
                    },
                },
            }),
        );
        assert.equal(payload.outputs[0].status, 'warning');
        assert.equal(payload.outputs[0].message, 'Waiting for Shared encode 720p');
    });

    test('a pipeline with no health yet reports its outputs as waiting, not as failed', () => {
        const payload = buildPayload(source({ health: {} }));
        assert.equal(payload.outputs[0].status, 'warning');
        assert.equal(payload.outputs[1].status, 'stopped');
    });

    test('sinceMs holds while the status holds, restarts on a change and forgets deleted outputs', () => {
        const since = createSinceTracker();
        const health = (over: Partial<OutputHealthEntry>) => ({
            1: { input: { live: true }, outputs: { '1-1': healthEntry(over) } },
        });
        const outputs = [out('1-1', 1)];
        const build = (nowMs: number, over: Partial<OutputHealthEntry>) =>
            buildPayload(
                source({
                    outputs,
                    health: health(over),
                    since,
                    nowMs,
                    pipelines: [pipelines[0]],
                }),
            ).outputs[0];

        const warn = { warningReason: 'slow', warningSinceMs: null };
        assert.equal(build(T, warn).sinceMs, T);
        assert.equal(build(T + 5000, warn).sinceMs, T, 'unchanged status keeps its time');
        assert.equal(build(T + 9000, {}).sinceMs, T - 60_000, 'running again: when it started');
        assert.equal(build(T + 9500, {}).sinceMs, T - 60_000);

        // Deleted, then back again: nothing is remembered of the earlier entry.
        buildPayload(source({ outputs: [], health: {}, since, pipelines: [pipelines[0]] }));
        assert.equal(build(T + 20_000, warn).sinceMs, T + 20_000);
    });

    test('the signature changes with a status and not with a message or counter', () => {
        const base = () => buildPayload(source());
        const changedMessage = base();
        changedMessage.outputs[0].message = 'something else';
        changedMessage.outputs[0].failures = 4;
        changedMessage.outputs[0].sinceMs = 5;
        assert.equal(payloadSignature(changedMessage), payloadSignature(base()));
        const changedStatus = base();
        changedStatus.outputs[0].status = 'warning';
        assert.notEqual(payloadSignature(changedStatus), payloadSignature(base()));
        const stoppedForGood = base();
        stoppedForGood.outputs[1].stoppedAfterFailures = true;
        assert.notEqual(payloadSignature(stoppedForGood), payloadSignature(base()));
        const fewer = base();
        fewer.outputs.pop();
        assert.notEqual(payloadSignature(fewer), payloadSignature(base()));
    });

    describe('inputs', () => {
        // A healthy, connected input; `over` changes what the case is about.
        const inputEntry = (
            over: Partial<InputStatusEntry> = {},
        ): PipelineStatusHealth['input'] => ({
            connected: true,
            live: true,
            mediaOk: true,
            mediaError: null,
            recvBitrateKbps: 4000,
            uptimeMs: 120_000,
            audioTracks: [{}] as InputStatusEntry['audioTracks'],
            audio: null,
            ...over,
        });
        interface OneOptions extends Partial<PayloadSource> {
            alerts?: PipelineStatusHealth['alerts'];
            outputDesired?: Output['desiredState'] | null;
        }
        // One pipeline, "Hindi", with one output that should run (or not).
        const one = (
            input: PipelineStatusHealth['input'],
            { alerts = [], outputDesired = 'running', nowMs = T, ...rest }: OneOptions = {},
        ) =>
            buildPayload(
                source({
                    pipelines: [pipelines[0]],
                    outputs: outputDesired ? [out('1-1', 1, { desiredState: outputDesired })] : [],
                    health: {
                        1: { input, outputs: { '1-1': healthEntry() }, alerts },
                    },
                    nowMs,
                    ...rest,
                }),
            ).inputs[0];

        test('every pipeline gets an entry, with its name as typed, also with no outputs', () => {
            const payload = buildPayload(
                source({
                    pipelines: [{ ...pipelines[0], name: ' Hindi  ' }, pipelines[1]],
                    outputs: [out('1-1', 1)],
                    health: {
                        1: { input: inputEntry(), outputs: { '1-1': healthEntry() } },
                        2: { input: inputEntry({ connected: false, live: false }), outputs: {} },
                    },
                }),
            );
            assert.deepEqual(payload.inputs, [
                { pipeline: ' Hindi  ', status: 'running', message: '', sinceMs: T - 120_000 },
                { pipeline: 'Tamil', status: 'stopped', message: '', sinceMs: T },
            ]);
        });

        test('maps each verdict of the dashboard to a reported status', () => {
            const cases: [string, PipelineStatusHealth['input'], OneOptions, string, string][] = [
                ['good', inputEntry(), {}, 'running', ''],
                [
                    'warn: no audio',
                    inputEntry({ audioTracks: [] }),
                    {},
                    'warning',
                    'No audio track detected in input.',
                ],
                [
                    'warn: waiting for ffprobe',
                    inputEntry({ mediaOk: null }),
                    {},
                    'warning',
                    'Waiting for ffprobe to finish and return the input encoding.',
                ],
                [
                    'warn: a pipeline alert',
                    inputEntry(),
                    {
                        alerts: [
                            {
                                severity: 'warning',
                                code: 'input-interlaced',
                                message: 'Input is interlaced.',
                                sinceMs: T,
                            },
                        ],
                    },
                    'warning',
                    'Input is interlaced.',
                ],
                [
                    'good: an alert about the relay link is not about the input',
                    inputEntry(),
                    {
                        alerts: [
                            {
                                severity: 'warning',
                                code: 'srt-packets-dropped',
                                message: 'SRT input dropped 3 packets.',
                                sinceMs: T,
                            },
                        ],
                    },
                    'running',
                    '',
                ],
                [
                    'error: a failed probe',
                    inputEntry({ mediaOk: false, mediaError: 'Invalid data found' }),
                    {},
                    'error',
                    'Invalid data found',
                ],
                [
                    'error: an error alert',
                    inputEntry(),
                    {
                        alerts: [
                            {
                                severity: 'error',
                                code: 'input-flapping',
                                message: 'Input keeps reconnecting.',
                                sinceMs: T,
                            },
                        ],
                    },
                    'error',
                    'Input keeps reconnecting.',
                ],
                [
                    'off, an output should run',
                    inputEntry({ connected: false, live: false }),
                    {},
                    'error',
                    'No signal is arriving.',
                ],
                [
                    'off, every output stopped',
                    inputEntry({ connected: false, live: false }),
                    { outputDesired: 'stopped' },
                    'stopped',
                    '',
                ],
                [
                    'off, no outputs at all',
                    inputEntry({ connected: false, live: false }),
                    { outputDesired: null },
                    'stopped',
                    '',
                ],
            ];
            for (const [label, input, options, status, message] of cases) {
                const reported = one(input, options);
                assert.equal(reported.status, status, label);
                assert.equal(reported.message, message, label);
            }
        });

        test('a pipeline with no health yet is not arriving when an output should run', () => {
            const reported = buildPayload(
                source({ pipelines: [pipelines[0]], outputs: [out('1-1', 1)], health: {} }),
            ).inputs[0];
            assert.equal(reported.status, 'error');
            assert.equal(reported.message, 'No signal is arriving.');
        });

        test('the message is redacted like an output message', () => {
            const reported = one(
                inputEntry({
                    mediaOk: false,
                    mediaError:
                        'Failed to open srt://host.example:9000?streamid=abc&passphrase=secretvalue123',
                }),
            );
            assert.equal(reported.status, 'error');
            assert.doesNotMatch(reported.message, /host\.example|secretvalue|streamid=abc/);
            assert.match(reported.message, /<url>/);
            const long = one(inputEntry({ mediaOk: false, mediaError: 'x '.repeat(400) }));
            assert.ok(long.message.length <= MAX_MESSAGE_LENGTH);
        });

        test('a blank name is left out and a long one is cut, so Key Vault never rejects the report', () => {
            const payload = buildPayload(
                source({
                    pipelines: [
                        { ...pipelines[0], name: '   ' },
                        { ...pipelines[1], name: 'T'.repeat(500) },
                    ],
                    outputs: [],
                    health: {},
                }),
            );
            assert.deepEqual(
                payload.inputs.map((i) => i.pipeline),
                ['T'.repeat(200)],
            );
        });

        test('sinceMs holds while the status holds, restarts on a change and forgets deleted pipelines', () => {
            const since = createSinceTracker();
            const build = (nowMs: number, input: PipelineStatusHealth['input']) =>
                one(input, { since, nowMs });
            const off = inputEntry({ connected: false, live: false });
            assert.equal(build(T, off).sinceMs, T);
            assert.equal(build(T + 5000, off).sinceMs, T, 'unchanged status keeps its time');
            const noAudio = inputEntry({ audioTracks: [] });
            assert.equal(build(T + 9000, noAudio).sinceMs, T + 9000, 'a change restarts it');
            assert.equal(build(T + 9500, noAudio).sinceMs, T + 9000);

            buildPayload(source({ pipelines: [], outputs: [], health: {}, since }));
            assert.equal(build(T + 20_000, noAudio).sinceMs, T + 20_000);
        });

        test('the signature changes when only an input status changes, not with its message', () => {
            const base = () => buildPayload(source());
            const changedMessage = base();
            changedMessage.inputs[0].message = 'something else';
            changedMessage.inputs[0].sinceMs = 5;
            assert.equal(payloadSignature(changedMessage), payloadSignature(base()));
            const changedStatus = base();
            changedStatus.inputs[0].status =
                changedStatus.inputs[0].status === 'running' ? 'warning' : 'running';
            assert.notEqual(payloadSignature(changedStatus), payloadSignature(base()));
            const fewer = base();
            fewer.inputs.pop();
            assert.notEqual(payloadSignature(fewer), payloadSignature(base()));
        });
    });
});
