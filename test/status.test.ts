// What the dashboard does with a status: it takes the server's verdict (see
// healthVerdicts.test.ts for how that is worked out) and adds the hints.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    lastErrorLine,
    summarizeOutputError,
    toOutputStatusVerdict,
    toStatusVerdict,
} from '../public/ts/core/status';
import { alertHint } from '../public/ts/core/hints';
import { parsePipelines } from '../public/ts/core/pipeline';
import type { ConfigData, OutputView } from '../public/ts/types';

// lastErrorLine reads only lastError, so the rest of an OutputView is left out.
function outputWith(lastError: string | null): OutputView {
    return { lastError } as unknown as OutputView;
}

describe('the error helpers', () => {
    test('lastErrorLine is the last non-empty line', () => {
        assert.equal(lastErrorLine(outputWith('a\nb\n\n')), 'b');
        assert.equal(lastErrorLine(outputWith(null)), '');
    });

    test('summarizeOutputError keeps one line, at most 160 characters', () => {
        assert.equal(summarizeOutputError(null, 'fallback'), 'fallback');
        assert.equal(summarizeOutputError('  a   b  \n', 'fallback'), 'a b');
        const long = summarizeOutputError('x'.repeat(300), 'fallback');
        assert.equal(long.length, 160);
        assert.ok(long.endsWith('...'));
    });
});

describe('toStatusVerdict', () => {
    test('keeps the status and the issues, and adds the hint for an alert code', () => {
        const verdict = toStatusVerdict({
            status: 'warn',
            issues: [
                {
                    severity: 'warning',
                    message: 'Input is interlaced',
                    code: 'input-interlaced',
                    sinceMs: 5,
                },
                { severity: 'warning', message: 'No audio track detected in input.' },
            ],
        });
        assert.equal(verdict.status, 'warn');
        assert.deepEqual(verdict.issues, [
            {
                severity: 'warning',
                message: 'Input is interlaced',
                hint: alertHint('input-interlaced'),
                sinceMs: 5,
            },
            { severity: 'warning', message: 'No audio track detected in input.' },
        ]);
        assert.ok(alertHint('input-interlaced'), 'the code has a hint to add');
    });

    test('a code with no hint adds none', () => {
        const [issue] = toStatusVerdict({
            status: 'warn',
            issues: [{ severity: 'warning', message: 'x', code: 'no-such-alert' }],
        }).issues;
        assert.equal('hint' in issue, false);
    });

    test('no verdict at all is unknown, a warning, never "fine"', () => {
        const verdict = toStatusVerdict(undefined);
        assert.equal(verdict.status, 'warn');
        assert.equal(verdict.issues[0].message, 'The status is not available yet.');
    });

    test('a shared encode keeps its verdict without the input', () => {
        const verdict = toOutputStatusVerdict({
            status: 'warn',
            issues: [{ severity: 'warning', message: 'Output is running but input is not live.' }],
            withoutInput: { status: 'good', issues: [] },
        });
        assert.deepEqual(verdict.withoutInput, { status: 'good', issues: [] });
        assert.equal(
            'withoutInput' in toOutputStatusVerdict({ status: 'good', issues: [] }),
            false,
        );
    });
});

describe('parsePipelines attaches the server verdicts', () => {
    const config: Partial<ConfigData> = {
        pipelines: [
            {
                id: '1',
                name: 'Hindi',
                streamKey: 'k',
                streamKeyId: 1,
                groupId: null,
                rtmpPublishUrl: '',
                srtPublishUrl: '',
                rtmpPublishUrlLocal: '',
                srtPublishUrlLocal: '',
            },
        ],
        outputs: [
            {
                id: '1-1',
                pipelineId: '1',
                seq: 1,
                name: 'YouTube',
                desiredState: 'running',
                videoEncoding: 'copy',
                url: 'rtmp://a.example/live/k',
                audioEncoding: 'copy',
                watchUrl: '',
                lastError: null,
                hasErrorHistory: false,
            },
        ],
        encodings: ['copy'],
    };

    test('to the input and to each output, by pipeline id and output id', () => {
        const [pipeline] = parsePipelines(config, {
            pipelines: {},
            verdicts: {
                inputs: { 1: { status: 'good', issues: [] } },
                outputs: {
                    '1-1': {
                        status: 'warn',
                        issues: [{ severity: 'warning', message: 'Falling behind' }],
                    },
                },
            },
        });
        assert.deepEqual(pipeline.input.verdict, { status: 'good', issues: [] });
        assert.equal(pipeline.outs[0].verdict.status, 'warn');
        assert.equal(pipeline.outs[0].verdict.issues[0].message, 'Falling behind');
    });

    test('an input or output the server sent no verdict for is unknown', () => {
        const [pipeline] = parsePipelines(config, {
            pipelines: {},
            verdicts: { inputs: {}, outputs: {} },
        });
        assert.equal(pipeline.input.verdict.status, 'warn');
        assert.equal(pipeline.outs[0].verdict.status, 'warn');
        // Before the first health response there are no verdicts at all.
        const [first] = parsePipelines(config, {});
        assert.equal(first.input.verdict.status, 'warn');
        assert.equal(first.outs[0].verdict.status, 'warn');
    });
});
