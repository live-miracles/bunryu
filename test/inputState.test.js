'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createInputState } = require('../src/services/inputState');

describe('input state', () => {
    test('requires both SRS reachability and live media for readiness', () => {
        const state = createInputState();

        state.setPipelineState(1, true, 'srt');
        assert.equal(state.isLive(1), true);
        assert.equal(state.isReady(1), false);
        assert.equal(state.getProtocol(1), 'srt');

        state.setSrsReachable(true);
        assert.equal(state.isReady(1), true);

        state.setPipelineState(1, false, 'rtmp');
        assert.equal(state.isLive(1), false);
        assert.equal(state.isReady(1), false);
        assert.equal(state.getProtocol(1), 'rtmp');

        state.clearPipeline(1);
        assert.equal(state.isLive(1), false);
        assert.equal(state.isReady(1), false);
        assert.equal(state.getProtocol(1), null);
    });

    test('flags 4K inputs by their larger dimension, including portrait sources', () => {
        const state = createInputState();

        assert.equal(state.isHighRes(1), false);

        state.setInputResolution(1, 3840, 2160);
        assert.equal(state.isHighRes(1), true);

        state.setInputResolution(1, 2160, 3840); // rotated/portrait 4K
        assert.equal(state.isHighRes(1), true);

        state.setInputResolution(1, 1920, 1080);
        assert.equal(state.isHighRes(1), false);

        state.setInputResolution(1, 3840, 2160);
        state.clearPipeline(1);
        assert.equal(state.isHighRes(1), false);

        state.setInputResolution(1, 3840, 2160);
        state.setInputResolution(1, null, null);
        assert.equal(state.isHighRes(1), false);
    });

    test('treats zero or negative dimensions as "no resolution known", not high-res', () => {
        const state = createInputState();

        state.setInputResolution(1, 3840, 2160);
        state.setInputResolution(1, 0, 2160);
        assert.equal(state.isHighRes(1), false);

        state.setInputResolution(1, 3840, 2160);
        state.setInputResolution(1, 3840, -1);
        assert.equal(state.isHighRes(1), false);

        state.setInputResolution(1, 3840, 2160);
        state.setInputResolution(1, 0, 0);
        assert.equal(state.isHighRes(1), false);
    });

    test('pullUrl defaults to rtmp when no protocol has been recorded yet', () => {
        const state = createInputState();
        assert.match(state.pullUrl(1, 'mykey'), /^rtmp:\/\//);
    });

    test('pullUrl switches to srt once the input protocol is set to srt', () => {
        const state = createInputState();
        state.setPipelineState(1, true, 'srt');
        assert.match(state.pullUrl(1, 'mykey'), /^srt:\/\//);
    });

    test('pullUrl reverts to rtmp after clearPipeline removes the recorded protocol', () => {
        const state = createInputState();
        state.setPipelineState(1, true, 'srt');
        state.clearPipeline(1);
        assert.match(state.pullUrl(1, 'mykey'), /^rtmp:\/\//);
    });

    test('isLive/isReady/getProtocol default safely for a pipeline that was never touched', () => {
        const state = createInputState();
        assert.equal(state.isLive(42), false);
        assert.equal(state.isReady(42), false);
        assert.equal(state.getProtocol(42), null);
    });

    test('keepOnly forgets the pipelines that no longer exist, whatever was recorded for them', () => {
        const state = createInputState();
        state.setSrsReachable(true);
        for (const id of [1, 2]) {
            state.setPipelineState(id, true, 'srt');
            state.setInputResolution(id, 3840, 2160);
        }

        state.keepOnly(new Set([2]));

        assert.equal(state.isLive(1), false);
        assert.equal(state.isReady(1), false);
        assert.equal(state.getProtocol(1), null);
        assert.equal(state.isHighRes(1), false);
        assert.equal(state.isReady(2), true);
        assert.equal(state.getProtocol(2), 'srt');
        assert.equal(state.isHighRes(2), true);
    });
});
