import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { srtPassphraseResetBlock } from '../public/ts/core/pipeline';
import type { PipelineHealth } from '../public/ts/types';

// Only the fields the rule reads; the cast is here once, not at every use.
const pipeline = (live: boolean, outputStatuses: string[]): PipelineHealth =>
    ({
        input: { live },
        outputs: Object.fromEntries(outputStatuses.map((status, i) => [`o${i}`, { status }])),
    }) as unknown as PipelineHealth;

describe('srtPassphraseResetBlock', () => {
    test('allows a reset before health has loaded, with no pipelines, or with everything idle', () => {
        assert.equal(srtPassphraseResetBlock({}), null);
        assert.equal(srtPassphraseResetBlock({ pipelines: {} }), null);
        assert.equal(
            srtPassphraseResetBlock({
                pipelines: { 1: pipeline(false, ['stopped', 'stopped']), 2: pipeline(false, []) },
            }),
            null,
        );
    });

    test('blocks on a live input', () => {
        assert.equal(
            srtPassphraseResetBlock({ pipelines: { 1: pipeline(true, ['stopped']) } }),
            '1 input live. Stop them before resetting.',
        );
    });

    test('blocks on a running or failed (retrying) output, like the server', () => {
        assert.equal(
            srtPassphraseResetBlock({ pipelines: { 1: pipeline(false, ['running', 'failed']) } }),
            '2 outputs not stopped. Stop them before resetting.',
        );
    });

    test('counts inputs and outputs across pipelines', () => {
        assert.equal(
            srtPassphraseResetBlock({
                pipelines: { 1: pipeline(true, ['running']), 2: pipeline(true, ['stopped']) },
            }),
            '2 inputs live, 1 output not stopped. Stop them before resetting.',
        );
    });
});
