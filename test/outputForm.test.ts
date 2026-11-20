import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    addOutputForm,
    destinationOf,
    editOutputForm,
    outputLocked,
    submitOutputForm,
} from '../public/ts/core/output-form';

const targets = [
    {
        id: 7,
        rtmpPublishUrlLocal: 'rtmp://127.0.0.1/live/key07',
        srtPublishUrlLocal: 'srt://127.0.0.1:10080?streamid=#!::r=live/key07,m=publish',
    },
];

const saved = (over = {}) => ({
    name: 'Main',
    videoEncoding: 'copy',
    url: 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh',
    audioEncoding: 'copy',
    desiredState: 'stopped',
    ...over,
});

const values = (over = {}) => ({
    name: 'Main',
    videoEncoding: 'copy',
    audioEncoding: 'copy',
    watchUrl: '',
    server: 'youtube',
    destination: { key: 'abcd-efgh', srt: null },
    ...over,
});

const srtFields = (over = {}) => ({
    mode: 'caller',
    host: 'srt.example.net',
    port: '9000',
    latency: '',
    passphrase: '',
    keyLen: '',
    streamId: '',
    ...over,
});

describe('addOutputForm', () => {
    test('the first output starts empty on a Custom RTMP destination', () => {
        assert.deepEqual(addOutputForm([], targets), {
            mode: 'add',
            name: 'Output 1',
            videoEncoding: 'copy',
            destination: { server: 'custom-rtmp', key: '' },
            audioEncoding: 'copy',
            watchUrl: '',
            locked: false,
            canCopy: false,
        });
    });

    test('is numbered after the outputs the pipeline has', () => {
        assert.equal(addOutputForm([saved(), saved()], targets).name, 'Output 3');
    });

    test('is prefilled from the last output, without its stream key', () => {
        const form = addOutputForm(
            [
                saved({ url: 'rtmp://other.example/app/first' }),
                saved({
                    videoEncoding: '720p',
                    audioEncoding: '1',
                    url: 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh',
                }),
            ],
            targets,
        );
        assert.equal(form.videoEncoding, '720p');
        assert.equal(form.audioEncoding, '1');
        assert.equal(form.destination.server, 'youtube');
        assert.equal(form.destination.key, '', 'the key is never reused');
    });

    test('is never locked, even when the last output is running', () => {
        assert.equal(addOutputForm([saved({ desiredState: 'running' })], targets).locked, false);
    });
});

describe('editOutputForm', () => {
    test('shows the saved output, with its destination read back to a preset and key', () => {
        const form = editOutputForm(saved(), targets);
        assert.equal(form.mode, 'edit');
        assert.equal(form.name, 'Main');
        assert.deepEqual(form.destination, { server: 'youtube', key: 'abcd-efgh' });
        assert.equal(form.canCopy, true);
        assert.equal(form.locked, false);
    });

    test('shows a Restream destination as its pipeline', () => {
        const form = editOutputForm(saved({ url: 'rtmp://127.0.0.1/live/key07' }), targets);
        assert.deepEqual(form.destination, { server: 'restream-rtmp', key: '7' });
    });

    test('locks a running output', () => {
        assert.equal(editOutputForm(saved({ desiredState: 'running' }), targets).locked, true);
    });
});

describe('the watch link', () => {
    test('a new output starts without one, even when the last output has one', () => {
        const form = addOutputForm([saved({ watchUrl: 'https://youtu.be/abc' })], targets);
        assert.equal(form.watchUrl, '');
    });

    test('a saved output shows its link, and an old one without a link shows none', () => {
        assert.equal(
            editOutputForm(saved({ watchUrl: 'https://youtu.be/abc' }), targets).watchUrl,
            'https://youtu.be/abc',
        );
        assert.equal(editOutputForm(saved(), targets).watchUrl, '');
    });

    test('is sent trimmed with a new output', () => {
        const result = submitOutputForm(
            values({ watchUrl: '  https://youtu.be/abc ' }),
            undefined,
            targets,
        );
        assert.equal(result.body.watchUrl, 'https://youtu.be/abc');
    });

    test('a running output can still change it, and the rest stays locked', () => {
        const result = submitOutputForm(
            values({ watchUrl: 'https://youtu.be/abc' }),
            { desiredState: 'running' },
            targets,
        );
        assert.deepEqual(result, {
            ok: true,
            body: { name: 'Main', watchUrl: 'https://youtu.be/abc' },
        });
    });

    test('only an http(s) link is accepted, and it is flagged otherwise', () => {
        for (const bad of [
            'javascript:alert(1)',
            'youtube.com/watch',
            'ftp://x/y',
            'https://a b',
        ]) {
            const result = submitOutputForm(values({ watchUrl: bad }), undefined, targets);
            assert.equal(result.ok, false, bad);
            assert.equal(result.invalid.watchUrl, true, bad);
            assert.equal(result.invalid.key, false, bad);
        }
        const running = submitOutputForm(
            values({ watchUrl: 'javascript:alert(1)' }),
            { desiredState: 'running' },
            targets,
        );
        assert.equal(running.ok, false);
    });
});

describe('outputLocked and destinationOf', () => {
    test('only an output that should be running is locked', () => {
        assert.equal(outputLocked({ desiredState: 'running' }), true);
        assert.equal(outputLocked({ desiredState: 'stopped' }), false);
        assert.equal(outputLocked(undefined), false, 'a new output');
    });

    test('an empty URL is a blank Custom RTMP', () => {
        assert.deepEqual(destinationOf('', targets), { server: 'custom-rtmp', key: '' });
        assert.deepEqual(destinationOf(undefined, targets), { server: 'custom-rtmp', key: '' });
    });
});

describe('submitOutputForm', () => {
    test('a valid new output sends the whole payload with the built URL', () => {
        const result = submitOutputForm(values({ name: '  Main  ' }), undefined, targets);
        assert.deepEqual(result, {
            ok: true,
            body: {
                name: 'Main',
                videoEncoding: 'copy',
                url: 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh',
                audioEncoding: 'copy',
                watchUrl: '',
            },
        });
    });

    test('trims the key before building the URL', () => {
        const result = submitOutputForm(
            values({ destination: { key: '  abcd-efgh ', srt: null } }),
            undefined,
            targets,
        );
        assert.equal(result.ok, true);
        assert.equal(result.body.url, 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh');
    });

    test('a running output sends only its name and watch link, whatever else the form holds', () => {
        const result = submitOutputForm(
            values({ name: 'Renamed', destination: null }),
            { desiredState: 'running' },
            targets,
        );
        assert.deepEqual(result, { ok: true, body: { name: 'Renamed', watchUrl: '' } });
    });

    test('a running output with an empty name flags only the name', () => {
        const result = submitOutputForm(
            values({ name: ' ' }),
            { desiredState: 'running' },
            targets,
        );
        assert.deepEqual(result, {
            ok: false,
            invalid: { name: true, watchUrl: false, key: false, srt: [] },
        });
    });

    test('an empty name is flagged along with a bad destination, so both show', () => {
        const result = submitOutputForm(
            values({ name: '', destination: { key: '', srt: null } }),
            undefined,
            targets,
        );
        assert.deepEqual(result, {
            ok: false,
            invalid: { name: true, watchUrl: false, key: true, srt: [] },
        });
    });

    test('an empty key is flagged', () => {
        const result = submitOutputForm(
            values({ destination: { key: '', srt: null } }),
            undefined,
            targets,
        );
        assert.deepEqual(result.invalid, { name: false, watchUrl: false, key: true, srt: [] });
    });

    test('a Custom RTMP value that is not an rtmp URL is flagged', () => {
        const result = submitOutputForm(
            values({ server: 'custom-rtmp', destination: { key: 'example.net/app', srt: null } }),
            undefined,
            targets,
        );
        assert.equal(result.invalid.key, true);
    });

    test('a Restream pipeline that no longer exists is flagged', () => {
        const result = submitOutputForm(
            values({ server: 'restream-rtmp', destination: { key: '99', srt: null } }),
            undefined,
            targets,
        );
        assert.equal(result.invalid.key, true);
    });

    test('a Restream destination sends the pipeline publish URL', () => {
        const result = submitOutputForm(
            values({ server: 'restream-srt', destination: { key: '7', srt: null } }),
            undefined,
            targets,
        );
        assert.equal(result.body.url, targets[0].srtPublishUrlLocal);
    });

    test('Custom SRT builds the URL from its fields', () => {
        const result = submitOutputForm(
            values({
                server: 'custom-srt',
                destination: { key: '', srt: srtFields({ latency: '240' }) },
            }),
            undefined,
            targets,
        );
        assert.equal(result.ok, true);
        assert.match(result.body.url, /^srt:\/\/srt\.example\.net:9000/);
        assert.match(result.body.url, /latency=240/);
    });

    test('Custom SRT names the fields that are wrong, not the key', () => {
        const result = submitOutputForm(
            values({
                server: 'custom-srt',
                destination: { key: '', srt: srtFields({ host: '', port: '0' }) },
            }),
            undefined,
            targets,
        );
        assert.deepEqual(result.invalid, {
            name: false,
            watchUrl: false,
            key: false,
            srt: ['host', 'port'],
        });
    });

    test('a form without its destination row cannot be saved, and flags nothing', () => {
        const result = submitOutputForm(values({ destination: null }), undefined, targets);
        assert.deepEqual(result, {
            ok: false,
            invalid: { name: false, watchUrl: false, key: false, srt: [] },
        });
    });

    test('Custom SRT with its fields missing from the row cannot be saved', () => {
        const result = submitOutputForm(
            values({ server: 'custom-srt', destination: { key: '', srt: null } }),
            undefined,
            targets,
        );
        assert.equal(result.ok, false);
    });

    test('editing a stopped output sends the whole payload', () => {
        const result = submitOutputForm(
            values({ videoEncoding: '720p' }),
            { desiredState: 'stopped' },
            targets,
        );
        assert.equal(result.ok, true);
        assert.equal(result.body.videoEncoding, '720p');
    });
});
