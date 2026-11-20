import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// The parts of a DOM element the dashboard code touches; a test adds the others it needs.
interface FakeElement {
    value: string;
    textContent: string;
    classList: {
        add(c: string): unknown;
        remove(c: string): unknown;
        toggle(c: string, force?: boolean): unknown;
        contains(c: string): boolean;
    };
    close?: () => void;
    showModal?: () => unknown;
    focus?: () => void;
    select?: () => void;
}

function fakeElement(value = ''): FakeElement {
    const classes = new Set<string>();
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

// The globals the test replaces: the page's document and window and fetch are fakes, so
// they are set through this untyped view of globalThis.
const globals = globalThis as unknown as Record<string, unknown>;

const hasError = (el: FakeElement) => el.classList.contains('input-error');
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('pipeline groups save as soon as they change', () => {
    let elements: Record<string, FakeElement>;
    let groupSaves: unknown[];
    const realDocument = globals.document;
    const realFetch = globals.fetch;
    const realWindow = globals.window;

    const toast = () => elements['error-msg'].textContent;

    beforeEach(() => {
        elements = {
            'pipe-group-name-input': fakeElement(''),
            'pipe-group-id-input': fakeElement(''),
            'pipe-group-modal': Object.assign(fakeElement(), { close() {}, showModal() {} }),
            'pipe-group-modal-title': fakeElement(),
            'error-msg': fakeElement(),
            'error-alert': fakeElement(),
        };
        elements['error-alert'].classList.add('hidden');
        globals.document = {
            getElementById: (id: string) => elements[id] ?? null,
            querySelectorAll: () => [],
            querySelector: () => null,
            addEventListener() {},
            title: '',
        };
        // Importing the module pulls in the dashboard, which starts a refresh on load.
        globals.window = { location: { search: '', href: '' }, addEventListener() {} };
        groupSaves = [];
        // Only the groups save is answered; the refresh after it never settles.
        globals.fetch = (url: unknown, opts: { body: string }) => {
            if (!String(url).endsWith('/api/settings/pipeline-groups')) {
                return new Promise(() => {});
            }
            const body = JSON.parse(opts.body);
            groupSaves.push(body);
            const groups = body.groups.map((g: { id?: number; name: string }, i: number) => ({
                id: g.id ?? 99,
                name: g.name,
                position: i,
            }));
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ groups }) });
        };
        const { state } =
            require('../public/ts/core/state') as typeof import('../public/ts/core/state');
        state.config.groups = [
            { id: 1, name: 'Main', position: 0 },
            { id: 2, name: 'Backup', position: 1 },
        ];
        state.config.pipelines = [];
    });

    afterEach(() => {
        globals.document = realDocument;
        globals.fetch = realFetch;
        globals.window = realWindow;
    });

    test('an empty group name is marked, explained and not sent', async () => {
        const { submitPipelineGroupForm } =
            require('../public/ts/features/pipeline-groups') as typeof import('../public/ts/features/pipeline-groups');
        elements['pipe-group-name-input'].value = '   ';

        await submitPipelineGroupForm();

        assert.ok(hasError(elements['pipe-group-name-input']));
        assert.equal(toast(), 'Group name is required.');
        assert.deepEqual(groupSaves, []);
    });

    test('a group name that is too long is marked and explained', async () => {
        const { submitPipelineGroupForm } =
            require('../public/ts/features/pipeline-groups') as typeof import('../public/ts/features/pipeline-groups');
        elements['pipe-group-name-input'].value = 'x'.repeat(81);

        await submitPipelineGroupForm();

        assert.ok(hasError(elements['pipe-group-name-input']));
        assert.equal(toast(), 'Group name must be at most 80 characters.');
        assert.deepEqual(groupSaves, []);
    });

    test('renaming sends the whole list at once with only that name changed', async () => {
        const { submitPipelineGroupForm } =
            require('../public/ts/features/pipeline-groups') as typeof import('../public/ts/features/pipeline-groups');
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
        const { state } =
            require('../public/ts/core/state') as typeof import('../public/ts/core/state');
        assert.deepEqual(
            state.config.groups?.map((g) => g.name),
            ['Main', 'Spare'],
        );
    });

    test('adding appends a new group after the existing ones', async () => {
        const { submitPipelineGroupForm } =
            require('../public/ts/features/pipeline-groups') as typeof import('../public/ts/features/pipeline-groups');
        elements['pipe-group-name-input'].value = 'Extra';

        void submitPipelineGroupForm();
        await settle();

        assert.deepEqual(groupSaves, [
            { groups: [{ id: 1, name: 'Main' }, { id: 2, name: 'Backup' }, { name: 'Extra' }] },
        ]);
    });

    test('the rename dialog opens filled with the group name', () => {
        const { editPipelineGroup } =
            require('../public/ts/features/pipeline-groups') as typeof import('../public/ts/features/pipeline-groups');
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
        const { addPipelineGroup } =
            require('../public/ts/features/pipeline-groups') as typeof import('../public/ts/features/pipeline-groups');
        const { state } =
            require('../public/ts/core/state') as typeof import('../public/ts/core/state');
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
