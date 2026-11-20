import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    configToCopy,
    parseConfigPayload,
    planConfigPaste,
    planHasWork,
    configPasteMessage,
} from '../public/ts/core/config-payload';
import type { ConfigPastePlan } from '../public/ts/core/config-payload';

const out = (url: string, name = 'Out') => ({
    name,
    videoEncoding: 'copy',
    url,
    audioEncoding: 'copy',
    watchUrl: '',
});

const keys = (n: number, taken: number[] = []) =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, taken: taken.includes(i + 1) }));

const none = { groups: [], pipelines: [], streamKeys: keys(3) };

// planConfigPaste and parseConfigPayload answer with a value or { error }. A test that
// expects the value gets it narrowed here, and one that expects the refusal reads its text.
const planOf = (...args: Parameters<typeof planConfigPaste>): ConfigPastePlan => {
    const plan = planConfigPaste(...args);
    assert.ok(!('error' in plan), 'the paste was refused');
    return plan;
};
const errorOf = (result: object): string =>
    'error' in result && typeof result.error === 'string' ? result.error : '';

describe('configToCopy', () => {
    test('lists the groups in order and each pipeline with its group name and outputs', () => {
        const config = configToCopy(
            [
                { id: 2, name: 'Evening', position: 1 },
                { id: 1, name: 'Morning', position: 0 },
            ],
            [
                { name: 'A', groupId: 1, outs: [out('rtmp://h/a')] },
                { name: 'B', groupId: null, outs: [] },
            ],
        );
        assert.deepEqual(config.groups, ['Morning', 'Evening']);
        assert.equal(config.pipelines[0].group, 'Morning');
        assert.equal(config.pipelines[1].group, null);
        assert.equal(config.pipelines[0].outputs.length, 1);
    });

    test('leaves out shared encodes', () => {
        const config = configToCopy(
            [],
            [
                {
                    name: 'A',
                    groupId: null,
                    outs: [out('rtmp://h/a'), out('rtmp://127.0.0.1:31935/internal/r1_720p_a1')],
                },
            ],
        );
        assert.deepEqual(
            config.pipelines[0].outputs.map((o) => o.url),
            ['rtmp://h/a'],
        );
    });
});

describe('parseConfigPayload', () => {
    test('round-trips what Copy makes', () => {
        const config = configToCopy(
            [{ id: 1, name: 'Morning', position: 0 }],
            [{ name: 'A', groupId: 1, outs: [out('rtmp://h/a')] }],
        );
        assert.deepEqual(parseConfigPayload(JSON.stringify(config)), { config });
    });

    test("adds a pipeline's group that the list leaves out", () => {
        const parsed = parseConfigPayload(
            JSON.stringify({ pipelines: [{ name: 'A', group: ' Morning ', outputs: [] }] }),
        );
        assert.ok('config' in parsed);
        assert.deepEqual(parsed.config.groups, ['Morning']);
    });

    test('refuses what is not a configuration', () => {
        for (const text of ['nope', '[]', '{"a":1}', '{"pipelines":[]}', '{"pipelines":[5]}']) {
            assert.ok('error' in parseConfigPayload(text), text);
        }
    });

    test('refuses a name that is empty, too long or twice in the clipboard', () => {
        const pipelines = (list: unknown[]) => JSON.stringify({ pipelines: list });
        assert.ok('error' in parseConfigPayload(pipelines([{ name: ' ' }])));
        assert.ok('error' in parseConfigPayload(pipelines([{ name: 'x'.repeat(81) }])));
        assert.match(
            errorOf(parseConfigPayload(pipelines([{ name: 'A' }, { name: 'a' }]))),
            /twice/,
        );
    });

    test('refuses a bad output, naming nothing partially', () => {
        const bad = JSON.stringify({ pipelines: [{ name: 'A', outputs: [{ url: 'x' }] }] });
        assert.ok('error' in parseConfigPayload(bad));
    });
});

describe('planConfigPaste', () => {
    const config = {
        groups: ['Morning', 'Evening'],
        pipelines: [
            { name: 'Main', group: 'Morning', outputs: [out('rtmp://h/1'), out('rtmp://h/2')] },
            { name: 'Side', group: 'Evening', outputs: [out('rtmp://h/3')] },
            { name: 'Plain', group: null, outputs: [] },
        ],
    };

    test('creates the groups and pipelines an empty instance lacks, on free keys', () => {
        const plan = planOf(config, none);
        assert.deepEqual(plan.newGroups, ['Morning', 'Evening']);
        assert.deepEqual(
            plan.pipelines.map((p) => [
                p.name,
                p.existingId,
                p.setGroup,
                p.streamKeyId,
                p.sharedKey,
            ]),
            [
                ['Main', null, 'Morning', 1, false],
                ['Side', null, 'Evening', 2, false],
                ['Plain', null, null, 3, false],
            ],
        );
    });

    test('matches groups and pipelines by name ignoring case and creates only the rest', () => {
        const plan = planOf(config, {
            groups: [{ id: 7, name: 'morning' }],
            pipelines: [{ id: 'p1', name: 'MAIN', groupId: 7, urls: [] }],
            streamKeys: keys(3, [1]),
        });
        assert.deepEqual(plan.newGroups, ['Evening']);
        assert.equal(plan.pipelines[0].existingId, 'p1');
        assert.equal(plan.pipelines[0].name, 'MAIN');
        assert.deepEqual(
            plan.pipelines.slice(1).map((p) => p.streamKeyId),
            [2, 3],
        );
    });

    test('an existing pipeline keeps its group, or gets the pasted one when it has none', () => {
        const plan = planOf(config, {
            groups: [
                { id: 1, name: 'Other' },
                { id: 2, name: 'Evening' },
            ],
            pipelines: [
                { id: 'p1', name: 'Main', groupId: 1, urls: [] },
                { id: 'p2', name: 'Side', groupId: null, urls: [] },
            ],
            streamKeys: keys(5, [1, 2]),
        });
        assert.equal(plan.pipelines[0].setGroup, null);
        assert.equal(plan.pipelines[1].setGroup, 'Evening');
    });

    test('adds only outputs with a destination the existing pipeline lacks, counting the rest', () => {
        const plan = planOf(config, {
            groups: [],
            pipelines: [{ id: 'p1', name: 'Main', groupId: null, urls: ['rtmp://h/1'] }],
            streamKeys: keys(3, [1]),
        });
        assert.deepEqual(
            plan.pipelines[0].outputs.map((o) => o.url),
            ['rtmp://h/2'],
        );
        assert.equal(plan.pipelines[0].skippedOutputs, 1);
    });

    test('gives new pipelines the last key, shared, once the free keys run out', () => {
        const plan = planOf(config, {
            groups: [],
            pipelines: [],
            streamKeys: keys(3, [1, 2]),
        });
        assert.deepEqual(
            plan.pipelines.map((p) => [p.streamKeyId, p.sharedKey]),
            [
                [3, false],
                [3, true],
                [3, true],
            ],
        );
    });

    test('refuses a paste that would pass the group limit, before changing anything', () => {
        const many = { groups: Array.from({ length: 51 }, (_, i) => `G${i}`), pipelines: [] };
        assert.match(errorOf(planConfigPaste(many, none)), /at most 50/);
    });
});

describe('planHasWork and configPasteMessage', () => {
    test('a paste of what is already here has no work', () => {
        const plan = planOf(
            { groups: ['G'], pipelines: [{ name: 'A', group: 'G', outputs: [out('rtmp://h/1')] }] },
            {
                groups: [{ id: 1, name: 'G' }],
                pipelines: [{ id: 'p', name: 'A', groupId: 1, urls: ['rtmp://h/1'] }],
                streamKeys: keys(2, [1]),
            },
        );
        assert.equal(planHasWork(plan), false);
    });

    test('warns about skipped outputs, shared keys and failures, and says what was done', () => {
        const base = {
            groupsCreated: 0,
            pipelinesCreated: 0,
            pipelinesGrouped: 0,
            outputsAdded: 0,
            outputsSkipped: 0,
            sharedKeys: 0,
            failed: 0,
        };
        const ok = configPasteMessage({
            ...base,
            pipelinesCreated: 2,
            groupsCreated: 1,
            outputsAdded: 3,
        });
        assert.equal(ok.tone, 'success');
        assert.match(ok.text, /created 2 pipelines, created 1 group, added 3 outputs/);
        const shared = configPasteMessage({ ...base, pipelinesCreated: 2, sharedKeys: 2 });
        assert.equal(shared.tone, 'warning');
        assert.match(shared.text, /2 new pipelines share the last stream key/);
        assert.equal(configPasteMessage({ ...base, outputsSkipped: 1 }).tone, 'warning');
        assert.match(configPasteMessage({ ...base, failed: 1 }).text, /1 step failed/);
    });
});
