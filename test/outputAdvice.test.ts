// Advice about how an output or pipeline is configured (public/ts/core/output-advice.ts).
// The card tests (outputCardWarnings.test.ts) check how it is shown; these check what it says.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    duplicateDestinations,
    outputAdvice,
    refLabel,
    restreamLoops,
    otherPipelinesOnKey,
} from '../public/ts/core/output-advice';
import type { InputHealth, OutputView, PipelineView } from '../public/ts/types';

// The fixtures carry only the fields the advice rules read, so each factory casts once.
const out = (id: string, name: string, url: string, over: Partial<OutputView> = {}) =>
    ({
        id,
        name,
        url,
        desiredState: 'running',
        videoEncoding: 'copy',
        audioEncoding: 'copy',
        ...over,
    }) as OutputView;
const pipeline = (id: number, name: string, outs: OutputView[], streamKeyId = id) =>
    ({
        id: String(id),
        name,
        streamKeyId,
        outs,
    }) as PipelineView;

const rtmpInput = { connected: true, isSrt: false, audioTracks: [{}] } as InputHealth;
const srtInput = (tracks = 2) =>
    ({
        connected: true,
        isSrt: true,
        audioTracks: Array.from({ length: tracks }, () => ({})),
    }) as InputHealth;

describe('refLabel', () => {
    test('names the output after its pipeline, or just the pipeline', () => {
        assert.equal(refLabel({ pipelineName: 'Hindi', outputName: 'YouTube' }), 'Hindi → YouTube');
        assert.equal(refLabel({ pipelineName: 'Hindi' }), 'Hindi');
    });
});

describe('duplicateDestinations', () => {
    test('lists every output that shares a URL, across pipelines, and nothing else', () => {
        const shared = 'rtmp://a.example/live/key';
        const dups = duplicateDestinations([
            pipeline(1, 'Hindi', [out('1-1', 'YT', shared), out('1-2', 'FB', 'rtmp://b/x')]),
            pipeline(2, 'Tamil', [out('2-1', 'YT', shared), out('2-2', 'Other', 'rtmp://c/y')]),
        ]);
        assert.deepEqual([...dups.keys()], [shared]);
        assert.deepEqual(dups.get(shared), [
            { pipelineName: 'Hindi', outputName: 'YT', outputId: '1-1' },
            { pipelineName: 'Tamil', outputName: 'YT', outputId: '2-1' },
        ]);
    });

    test('a URL used once, or an output with no URL, is not a duplicate', () => {
        const dups = duplicateDestinations([
            pipeline(1, 'Hindi', [
                out('1-1', 'A', 'rtmp://a/x'),
                out('1-2', 'B', ''),
                out('1-3', 'C', ''),
            ]),
        ]);
        assert.equal(dups.size, 0);
    });
});

describe('otherPipelinesOnKey', () => {
    const all = [
        pipeline(1, 'Hindi', [], 7),
        pipeline(2, 'Tamil', [], 7),
        pipeline(3, 'Telugu', [], 8),
        pipeline(4, 'Kannada', [], 7),
    ];

    test('names the other pipelines on the same key, never the pipeline itself', () => {
        assert.deepEqual(otherPipelinesOnKey(all, all[0]), ['Tamil', 'Kannada']);
        assert.deepEqual(otherPipelinesOnKey(all, all[1]), ['Hindi', 'Kannada']);
    });

    test('is empty for a key of its own', () => {
        assert.deepEqual(otherPipelinesOnKey(all, all[2]), []);
    });
});

describe('outputAdvice', () => {
    const none: ReturnType<typeof duplicateDestinations> = new Map();

    test('a plain copy output on a matching input has none', () => {
        assert.deepEqual(outputAdvice(out('1-1', 'YT', 'rtmp://a/x'), rtmpInput, none), []);
        assert.deepEqual(outputAdvice(out('1-1', 'YT', 'srt://a:1'), srtInput(), none), []);
    });

    test('names the other outputs with the same destination, never the output itself', () => {
        const url = 'rtmp://a/x';
        const dups = duplicateDestinations([
            pipeline(1, 'Hindi', [out('1-1', 'YT', url)]),
            pipeline(2, 'Tamil', [out('2-1', 'FB', url), out('2-2', 'Again', url)]),
        ]);
        const first = outputAdvice(out('1-1', 'YT', url), rtmpInput, dups);
        assert.deepEqual(first, ['Same destination as Tamil → FB, Tamil → Again']);
        assert.deepEqual(outputAdvice(out('2-1', 'FB', url), rtmpInput, dups), [
            'Same destination as Hindi → YT, Tamil → Again',
        ]);
    });

    test('RTMP input: a track selection it cannot have, and Track 1 costing CPU', () => {
        const other = outputAdvice(
            out('1-1', 'YT', 'rtmp://a/x', { audioEncoding: '1' }),
            rtmpInput,
            none,
        );
        assert.deepEqual(other, [
            'RTMP input only has one audio track — use copy or Track 1, not a different track selection.',
        ]);
        const track1 = outputAdvice(
            out('1-1', 'YT', 'rtmp://a/x', { audioEncoding: '0' }),
            rtmpInput,
            none,
        );
        assert.equal(track1.length, 1);
        assert.match(track1[0], /^Track 1 re-encodes the audio, which costs extra CPU/);
        // To an SRT destination Track 1 is not advised against.
        assert.deepEqual(
            outputAdvice(out('1-1', 'S', 'srt://a:1', { audioEncoding: '0' }), rtmpInput, none),
            [],
        );
    });

    test('SRT input to an RTMP output copying the audio', () => {
        const copy = outputAdvice(out('1-1', 'YT', 'rtmp://a/x'), srtInput(), none);
        assert.equal(copy.length, 1);
        assert.match(copy[0], /^SRT-to-RTMP output should not use copy audio/);
        assert.deepEqual(
            outputAdvice(out('1-1', 'YT', 'rtmp://a/x', { audioEncoding: '1' }), srtInput(), none),
            [],
        );
    });

    test('an SRT input with fewer audio tracks than the output selects', () => {
        const advice = outputAdvice(
            out('1-1', 'YT', 'rtmp://a/x', { audioEncoding: '1,3' }),
            srtInput(2),
            none,
        );
        assert.deepEqual(advice, [
            'Output selects track 4, but the input only has 2 audio tracks.',
        ]);
        const one = outputAdvice(
            out('1-1', 'YT', 'rtmp://a/x', { audioEncoding: '2' }),
            srtInput(1),
            none,
        );
        assert.deepEqual(one, ['Output selects track 3, but the input only has 1 audio track.']);
    });

    test('nothing about the audio until an input is connected, or for an output with no URL', () => {
        const off = { connected: false, isSrt: false, audioTracks: [] } as unknown as InputHealth;
        assert.deepEqual(
            outputAdvice(out('1-1', 'YT', 'rtmp://a/x', { audioEncoding: '1' }), off, none),
            [],
        );
        assert.deepEqual(
            outputAdvice(out('1-1', 'YT', '', { audioEncoding: '1' }), rtmpInput, none),
            [],
        );
    });

    test('the same-destination line comes first, then the audio advice', () => {
        const url = 'rtmp://a/x';
        const dups = duplicateDestinations([
            pipeline(1, 'Hindi', [
                out('1-1', 'YT', url, { audioEncoding: '0' }),
                out('1-2', 'FB', url),
            ]),
        ]);
        const advice = outputAdvice(out('1-1', 'YT', url, { audioEncoding: '0' }), rtmpInput, dups);
        assert.equal(advice.length, 2);
        assert.match(advice[0], /^Same destination as Hindi → FB$/);
        assert.match(advice[1], /^Track 1 re-encodes/);
    });
});

describe('an output stopped after repeated failed attempts', () => {
    const none: ReturnType<typeof duplicateDestinations> = new Map();
    const stopped = (lastError: string | null, lastErrorAt: number | null = 1) =>
        out('1-1', 'YT', 'rtmp://a/x', { desiredState: 'stopped', lastError, lastErrorAt });

    test('is one line: the count, what to do, then the last error', () => {
        const advice = outputAdvice(
            stopped('1\nStopped after 5 failed attempts. Last error: Connection refused'),
            rtmpInput,
            none,
        );
        assert.equal(advice.length, 1);
        assert.equal(
            advice[0],
            'Stopped after 5 failed attempts. Check the link and stream key, update the output, then start it again. Last error: Connection refused',
        );
    });

    test('does not need the input: it is about the destination', () => {
        const off = { connected: false, isSrt: false, audioTracks: [] } as unknown as InputHealth;
        const advice = outputAdvice(stopped('Stopped after 22 failed attempts'), off, none);
        assert.equal(
            advice[0],
            'Stopped after 22 failed attempts. Check the link and stream key, update the output, then start it again.',
        );
    });

    test('a plain stop, or a running output with an error, gets none', () => {
        assert.deepEqual(outputAdvice(stopped(null, null), rtmpInput, none), []);
        assert.deepEqual(outputAdvice(stopped('boom', null), rtmpInput, none), []);
        const running = out('1-1', 'YT', 'rtmp://a/x', {
            desiredState: 'running',
            lastError: 'Stopped after 5 failed attempts',
            lastErrorAt: 1,
        });
        assert.deepEqual(outputAdvice(running, rtmpInput, none), []);
    });

    test('a message without a count still gets the advice, with the message as the error', () => {
        const advice = outputAdvice(stopped('something else'), rtmpInput, none);
        assert.match(advice[0], /^Stopped after repeated failures\. Check the link and stream key/);
        assert.match(advice[0], / Last error: something else$/);
    });
});

describe('restreamLoops', () => {
    // A pipeline with the publish URLs the dashboard knows for its key.
    const withKey = (id: number, name: string, key: string, outs: OutputView[]): PipelineView => ({
        ...pipeline(id, name, outs),
        streamKey: key,
        rtmpPublishUrl: `rtmp://live.example.com/live/${key}`,
        srtPublishUrl: `srt://live.example.com:10080?streamid=#!::r=live/${key},m=publish`,
        rtmpPublishUrlLocal: `rtmp://127.0.0.1:1935/live/${key}`,
        srtPublishUrlLocal: `srt://127.0.0.1:10080?streamid=#!::r=live/${key},m=publish`,
    });
    const toKey = (key: string) => `rtmp://127.0.0.1:1935/live/${key}`;

    test('an output that publishes into its own pipeline loops, however the URL is spelled', () => {
        for (const url of [
            toKey('kA'),
            'rtmp://live.example.com/live/kA',
            'srt://127.0.0.1:10080?streamid=#!::r=live/kA,m=publish',
            'srt://live.example.com:10080?streamid=#!::r=live/kA,m=publish',
        ]) {
            const a = withKey(1, 'A', 'kA', [out('1-1', 'Loop', url)]);
            const loops = restreamLoops([a]);
            assert.match(loops.get('1-1') ?? '', /^Loops back into this pipeline's own input/, url);
        }
    });

    test('localhost and 127.0.0.1 are the same address, and SRT options after the stream id do not matter', () => {
        for (const url of [
            'rtmp://localhost:1935/live/kA',
            'rtmp://127.0.0.1:1935/live/kA',
            'rtmps://live.example.com/live/kA',
            'srt://localhost:10080?streamid=#!::r=live/kA,m=publish&passphrase=x&pbkeylen=16',
            'srt://127.0.0.1:10080?latency=200&streamid=#!::r=live/kA,m=publish',
        ]) {
            const a = withKey(1, 'A', 'kA', [out('1-1', 'Loop', url)]);
            assert.equal(restreamLoops([a]).size, 1, url);
        }
    });

    test('a destination on another host or port, or another key, is not this server', () => {
        for (const url of [
            'rtmp://other.example.com:1935/live/kA',
            'rtmp://127.0.0.1:9999/live/kA',
            'rtmp://127.0.0.1:1935/live/not-a-pipeline-key',
            'srt://127.0.0.1:10080?streamid=#!::r=live/kA,m=request',
            'srt://other.example.com:10080?streamid=#!::r=live/kA,m=publish',
        ]) {
            const a = withKey(1, 'A', 'kA', [out('1-1', 'Out', url)]);
            assert.equal(restreamLoops([a]).size, 0, url);
        }
    });

    test('an output of another pipeline restreaming into this one does not', () => {
        const a = withKey(1, 'A', 'kA', [out('1-1', 'A to B', toKey('kB'))]);
        const b = withKey(2, 'B', 'kB', []);
        assert.equal(restreamLoops([a, b]).size, 0);
    });

    test('a loop through another pipeline marks both outputs of the circle, naming the other pipeline', () => {
        const a = withKey(1, 'A', 'kA', [out('1-1', 'A to B', toKey('kB'))]);
        const b = withKey(2, 'B', 'kB', [out('2-1', 'B to A', toKey('kA'))]);
        const loops = restreamLoops([a, b]);
        assert.equal(
            loops.get('1-1'),
            'Loops back into this pipeline\'s input through "B", so it cannot work',
        );
        assert.equal(
            loops.get('2-1'),
            'Loops back into this pipeline\'s input through "A", so it cannot work',
        );
    });

    test('follows a longer chain, and ignores outputs that go elsewhere', () => {
        const a = withKey(1, 'A', 'kA', [
            out('1-1', 'A to B', toKey('kB')),
            out('1-2', 'YT', 'rtmp://a.rtmp.youtube.com/live2/k'),
        ]);
        const b = withKey(2, 'B', 'kB', [out('2-1', 'B to C', toKey('kC'))]);
        const c = withKey(3, 'C', 'kC', [out('3-1', 'C to A', toKey('kA'))]);
        const loops = restreamLoops([a, b, c]);
        assert.deepEqual([...loops.keys()].sort(), ['1-1', '2-1', '3-1']);
    });

    test('a loop is advice on the output, and nothing is said without one', () => {
        const a = withKey(1, 'A', 'kA', [out('1-1', 'Loop', toKey('kA'))]);
        const loops = restreamLoops([a]);
        const o = a.outs[0];
        assert.deepEqual(outputAdvice(o, rtmpInput, new Map(), loops), [loops.get('1-1')]);
        assert.deepEqual(outputAdvice(o, rtmpInput, new Map()), []);
    });
});
