'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function fakeElement(value = '') {
    const classes = new Set();
    return {
        value,
        textContent: '',
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
            contains: (c) => classes.has(c),
        },
    };
}

const hasError = (el) => el.classList.contains('input-error');
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('pipeline groups save as soon as they change', () => {
    let elements;
    let groupSaves;
    const realDocument = global.document;
    const realFetch = global.fetch;
    const realWindow = global.window;

    const toast = () => elements['error-msg'].textContent;

    beforeEach(() => {
        elements = {
            'pipe-group-name-input': fakeElement(''),
            'pipe-group-id-input': fakeElement(''),
            'pipe-group-modal': { close() {}, showModal() {} },
            'pipe-group-modal-title': fakeElement(),
            'error-msg': fakeElement(),
            'error-alert': fakeElement(),
        };
        elements['error-alert'].classList.add('hidden');
        global.document = {
            getElementById: (id) => elements[id] ?? null,
            querySelectorAll: () => [],
            querySelector: () => null,
            addEventListener() {},
            title: '',
        };
        // Importing the module pulls in the dashboard, which starts a refresh on load.
        global.window = { location: { search: '', href: '' }, addEventListener() {} };
        groupSaves = [];
        // Only the groups save is answered; the refresh after it never settles.
        global.fetch = (url, opts) => {
            if (!String(url).endsWith('/api/settings/pipeline-groups')) {
                return new Promise(() => {});
            }
            const body = JSON.parse(opts.body);
            groupSaves.push(body);
            const groups = body.groups.map((g, i) => ({
                id: g.id ?? 99,
                name: g.name,
                position: i,
            }));
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ groups }) });
        };
        const { state } = require('../public/ts/core/state');
        state.config.groups = [
            { id: 1, name: 'Main', position: 0 },
            { id: 2, name: 'Backup', position: 1 },
        ];
        state.config.pipelines = [];
    });

    afterEach(() => {
        global.document = realDocument;
        global.fetch = realFetch;
        global.window = realWindow;
    });

    test('an empty group name is marked, explained and not sent', async () => {
        const { submitPipelineGroupForm } = require('../public/ts/features/pipeline-groups');
        elements['pipe-group-name-input'].value = '   ';

        await submitPipelineGroupForm();

        assert.ok(hasError(elements['pipe-group-name-input']));
        assert.equal(toast(), 'Group name is required.');
        assert.deepEqual(groupSaves, []);
    });

    test('a group name that is too long is marked and explained', async () => {
        const { submitPipelineGroupForm } = require('../public/ts/features/pipeline-groups');
        elements['pipe-group-name-input'].value = 'x'.repeat(81);

        await submitPipelineGroupForm();

        assert.ok(hasError(elements['pipe-group-name-input']));
        assert.equal(toast(), 'Group name must be at most 80 characters.');
        assert.deepEqual(groupSaves, []);
    });

    test('renaming sends the whole list at once with only that name changed', async () => {
        const { submitPipelineGroupForm } = require('../public/ts/features/pipeline-groups');
        elements['pipe-group-id-input'].value = '2';
        elements['pipe-group-name-input'].value = '  Spare ';

        void submitPipelineGroupForm();
        await settle();

        assert.deepEqual(groupSaves, [
            {
                groups: [
                    { id: 1, name: 'Main' },
                    { id: 2, name: 'Spare' },
                ],
            },
        ]);
        const { state } = require('../public/ts/core/state');
        assert.deepEqual(
            state.config.groups.map((g) => g.name),
            ['Main', 'Spare'],
        );
    });

    test('adding appends a new group after the existing ones', async () => {
        const { submitPipelineGroupForm } = require('../public/ts/features/pipeline-groups');
        elements['pipe-group-name-input'].value = 'Extra';

        void submitPipelineGroupForm();
        await settle();

        assert.deepEqual(groupSaves, [
            { groups: [{ id: 1, name: 'Main' }, { id: 2, name: 'Backup' }, { name: 'Extra' }] },
        ]);
    });

    test('the rename dialog opens filled with the group name', () => {
        const { editPipelineGroup } = require('../public/ts/features/pipeline-groups');
        let opened = false;
        elements['pipe-group-modal'].showModal = () => (opened = true);
        elements['pipe-group-name-input'].focus = () => {};
        elements['pipe-group-name-input'].select = () => {};

        editPipelineGroup(2);

        assert.ok(opened);
        assert.equal(elements['pipe-group-id-input'].value, '2');
        assert.equal(elements['pipe-group-name-input'].value, 'Backup');
        assert.equal(elements['pipe-group-modal-title'].textContent, 'Rename Group');
    });

    test('adding past the 50-group maximum is refused without a request', () => {
        const { addPipelineGroup } = require('../public/ts/features/pipeline-groups');
        const { state } = require('../public/ts/core/state');
        state.config.groups = Array.from({ length: 50 }, (_, i) => ({
            id: i + 1,
            name: `G${i}`,
            position: i,
        }));

        addPipelineGroup();

        assert.equal(toast(), 'At most 50 groups are allowed.');
        assert.deepEqual(groupSaves, []);
    });
});
