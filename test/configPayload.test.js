'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    configToCopy,
    parseConfigPayload,
    planConfigPaste,
    planHasWork,
    configPasteMessage,
} = require('../public/ts/core/config-payload');

const out = (url, name = 'Out') => ({
    name,
    videoEncoding: 'copy',
    url,
    audioEncoding: 'copy',
    watchUrl: '',
});

const keys = (n, taken = []) =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, taken: taken.includes(i + 1) }));

const none = { groups: [], pipelines: [], streamKeys: keys(3) };

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
        assert.deepEqual(parsed.config.groups, ['Morning']);
    });

    test('refuses what is not a configuration', () => {
        for (const text of ['nope', '[]', '{"a":1}', '{"pipelines":[]}', '{"pipelines":[5]}']) {
            assert.ok('error' in parseConfigPayload(text), text);
        }
    });

    test('refuses a name that is empty, too long or twice in the clipboard', () => {
        const pipelines = (list) => JSON.stringify({ pipelines: list });
        assert.ok('error' in parseConfigPayload(pipelines([{ name: ' ' }])));
        assert.ok('error' in parseConfigPayload(pipelines([{ name: 'x'.repeat(81) }])));
        assert.match(parseConfigPayload(pipelines([{ name: 'A' }, { name: 'a' }])).error, /twice/);
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
        const plan = planConfigPaste(config, none);
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
        const plan = planConfigPaste(config, {
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
        const plan = planConfigPaste(config, {
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
        const plan = planConfigPaste(config, {
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
        const plan = planConfigPaste(config, {
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
        assert.match(planConfigPaste(many, none).error, /at most 50/);
    });
});

describe('planHasWork and configPasteMessage', () => {
    test('a paste of what is already here has no work', () => {
        const plan = planConfigPaste(
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
