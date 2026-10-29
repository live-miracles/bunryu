'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
    countOutputs,
    matchesOutputFilter,
    outputSummaryHtml,
    noMatchingOutputsText,
} = require('../public/ts/core/outputs-filter');
const { outputSeverity } = require('../public/ts/features/output-card');

describe('countOutputs', () => {
    test('running and stopped are every output, whatever is wrong with it; errors and warnings overlap', () => {
        const counts = countOutputs([
            { severity: 'error', stopped: true }, // stopped after repeated failures
            { severity: 'error', stopped: false }, // crashing and being retried
            { severity: 'warning', stopped: false }, // running, with a shared-destination warning
            { severity: 'warning', stopped: true }, // stopped, with an encoding warning
            { severity: null, stopped: false },
            { severity: null, stopped: false },
            { severity: null, stopped: true },
        ]);

        assert.deepEqual(counts, { error: 2, warning: 2, running: 4, stopped: 3 });
        assert.equal(counts.running + counts.stopped, 7, 'together they are all the outputs');
    });
});

describe('matchesOutputFilter', () => {
    const youtube = { name: 'YouTube EN', url: 'rtmp://a.rtmp.youtube.com/live2/key' };

    test('matches the name or the destination, ignoring case', () => {
        assert.equal(matchesOutputFilter(youtube, null, 'youtube en', false), true);
        assert.equal(matchesOutputFilter(youtube, null, 'RTMP.YOUTUBE', false), true);
        assert.equal(matchesOutputFilter(youtube, null, 'twitch', false), false);
    });

    test('an output without a destination is found by name only', () => {
        const rendition = { name: 'Shared', url: null };
        assert.equal(matchesOutputFilter(rendition, null, 'shared', false), true);
        assert.equal(matchesOutputFilter(rendition, null, 'null', false), false);
    });

    test('Problems only drops outputs with neither an error nor a warning', () => {
        assert.equal(matchesOutputFilter(youtube, null, '', true), false);
        assert.equal(matchesOutputFilter(youtube, 'warning', '', true), true);
        assert.equal(matchesOutputFilter(youtube, 'error', '', true), true);
    });

    test('Problems only and a query must both match', () => {
        assert.equal(matchesOutputFilter(youtube, 'error', 'twitch', true), false);
        assert.equal(matchesOutputFilter(youtube, 'error', 'youtube', true), true);
    });
});

describe('outputSummaryHtml', () => {
    test('leaves out empty buckets and says nothing about hidden outputs when all show', () => {
        const html = outputSummaryHtml({ error: 0, warning: 1, running: 97, stopped: 0 }, 98, 98);

        assert.match(html, /1 warning</);
        assert.match(html, /97 running/);
        assert.ok(!/error/.test(html));
        assert.ok(!/stopped/.test(html));
        assert.ok(!/showing/.test(html));
    });

    test('says how many are shown while a filter hides outputs', () => {
        const html = outputSummaryHtml({ error: 2, warning: 0, running: 8, stopped: 0 }, 2, 10);

        assert.match(html, />2 of 10</);
        assert.match(html, /2 errors/);
    });
});

describe('noMatchingOutputsText', () => {
    test('names the filter that hid everything', () => {
        assert.equal(noMatchingOutputsText(' yt ', false), 'No outputs match “yt”.');
        assert.equal(noMatchingOutputsText('', true), 'No outputs with problems.');
        assert.equal(noMatchingOutputsText('yt', true), 'No outputs with problems match “yt”.');
    });
});

describe('outputSeverity', () => {
    const output = (over) => ({
        id: '1-1',
        name: 'o',
        desiredState: 'running',
        status: 'running',
        videoEncoding: 'copy',
        audioEncoding: 'copy',
        failures: 0,
        lastError: null,
        lastErrorAt: null,
        warningReason: null,
        bitrateKbps: 5000,
        url: 'rtmp://a.example/live/key',
        ...over,
    });
    const rtmpInput = { connected: true, live: true, isSrt: false, audioTracks: [] };
    const severity = (over, dupUrls = new Map()) =>
        outputSeverity(output(over), rtmpInput, dupUrls);
    const stopped = { desiredState: 'stopped', status: 'stopped' };

    test('a healthy output has none', () => {
        assert.equal(severity({}), null);
    });

    test('an error status or a current error line is an error', () => {
        assert.equal(severity({ status: 'failed' }), 'error');
        assert.equal(severity({ ...stopped, lastError: 'boom', lastErrorAt: 1 }), 'error');
    });

    test('an old error that is no longer current is not a problem', () => {
        assert.equal(severity({ ...stopped, lastError: 'boom', lastErrorAt: null }), null);
    });

    test('every warning the card shows counts, even on a stopped output', () => {
        assert.equal(severity({ bitrateKbps: 100 }), 'warning');
        assert.equal(severity({ warningReason: 'timestamps' }), 'warning');
        assert.equal(severity({ ...stopped, audioEncoding: '1' }), 'warning');
        const dup = new Map([
            [
                'rtmp://a.example/live/key',
                [
                    { pipelineName: 'P', outputName: 'o', outputId: '1-1' },
                    { pipelineName: 'P', outputName: 'o2', outputId: '1-2' },
                ],
            ],
        ]);
        assert.equal(severity({}, dup), 'warning');
    });

    test('an error outranks a warning', () => {
        assert.equal(severity({ warningReason: 'x', lastError: 'boom', lastErrorAt: 1 }), 'error');
    });
});
