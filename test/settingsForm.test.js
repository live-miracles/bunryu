'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function fakeElement(value = '', dataset = {}) {
    const classes = new Set();
    return {
        value,
        dataset,
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

describe('settings forms do not fail silently', () => {
    let elements;
    let rows;
    let selectors;
    let fetchCalls;
    const realDocument = global.document;
    const realFetch = global.fetch;
    const realWindow = global.window;

    const toast = () => elements['error-msg'].textContent;
    const savedAnything = () =>
        fetchCalls.some((url) => url.includes('/api/settings') || url.includes('/api/auth'));

    beforeEach(() => {
        elements = {
            'settings-server-name-input': fakeElement(''),
            'settings-public-host-input': fakeElement('example.com'),
            'current-password-input': fakeElement(''),
            'new-password-input': fakeElement(''),
            'confirm-password-input': fakeElement(''),
            'error-msg': fakeElement(),
            'error-alert': fakeElement(),
        };
        elements['error-alert'].classList.add('hidden');
        rows = { '[data-host-probe-row]': [], '[data-pipeline-group-row]': [] };
        selectors = {};
        global.document = {
            getElementById: (id) => elements[id] ?? null,
            querySelectorAll: (selector) => rows[selector] ?? [],
            querySelector: (selector) => selectors[selector] ?? null,
            addEventListener() {},
            title: '',
        };
        // Importing the editor pulls in the dashboard module, which starts a refresh
        // on load; its requests never settle here.
        global.window = { location: { search: '', href: '' }, addEventListener() {} };
        fetchCalls = [];
        global.fetch = (url) => {
            fetchCalls.push(String(url));
            return new Promise(() => {});
        };
    });

    afterEach(() => {
        global.document = realDocument;
        global.fetch = realFetch;
        global.window = realWindow;
    });

    test('an empty server name is marked, explained and not sent', async () => {
        const { submitGeneralSettingsForm } = require('../public/ts/features/editor');

        await submitGeneralSettingsForm();

        assert.ok(hasError(elements['settings-server-name-input']));
        assert.equal(toast(), 'Server name is required.');
        assert.ok(!elements['error-alert'].classList.contains('hidden'));
        assert.ok(!savedAnything());
    });

    test('a host probe missing its name or host, or with a bad port, is marked and explained', async () => {
        const { submitHostProbesForm } = require('../public/ts/features/editor');
        const probe = (label, host, port) => {
            const els = {
                label: fakeElement(label),
                host: fakeElement(host),
                port: fakeElement(port),
            };
            rows['[data-host-probe-row]'] = [fakeElement('', { hostProbeRow: '1' })];
            for (const [field, el] of Object.entries(els)) {
                selectors[`[data-host-probe-slot="1"][data-host-probe-field="${field}"]`] = el;
            }
            return els;
        };

        const missing = probe('', 'a.example.com', '1935');
        await submitHostProbesForm();
        assert.ok(hasError(missing.label));
        assert.equal(toast(), 'Host probe needs a name.');

        const bad = probe('YouTube', '', '70000');
        await submitHostProbesForm();
        assert.ok(hasError(bad.host) && hasError(bad.port));
        assert.equal(toast(), 'Host probe needs a host, a port from 1 to 65535.');
        assert.ok(!savedAnything());
    });

    test('clearing the name of an existing pipeline group is refused instead of deleting it', async () => {
        const { submitPipelineGroupsForm } = require('../public/ts/features/editor');
        const nameEl = fakeElement('   ');
        const row = { dataset: { pipelineGroupRow: '7' }, querySelector: () => nameEl };
        rows['[data-pipeline-group-row]'] = [row];

        await submitPipelineGroupsForm();

        assert.ok(hasError(nameEl));
        assert.equal(toast(), 'Group name is required. Remove the row to delete the group.');
        assert.ok(!savedAnything());
    });

    test('a pipeline group name that is too long is marked and explained', async () => {
        const { submitPipelineGroupsForm } = require('../public/ts/features/editor');
        const nameEl = fakeElement('x'.repeat(81));
        rows['[data-pipeline-group-row]'] = [
            { dataset: { pipelineGroupRow: 'new-1' }, querySelector: () => nameEl },
        ];

        await submitPipelineGroupsForm();

        assert.ok(hasError(nameEl));
        assert.equal(toast(), 'Group name must be at most 80 characters.');
        assert.ok(!savedAnything());
    });

    test('password: each missing or mismatched field is marked and explained', async () => {
        const { submitPasswordForm } = require('../public/ts/features/editor');
        const current = elements['current-password-input'];
        const next = elements['new-password-input'];
        const confirm = elements['confirm-password-input'];

        await submitPasswordForm();
        assert.ok(hasError(current));
        assert.equal(toast(), 'Enter your current password.');

        current.value = 'old';
        await submitPasswordForm();
        assert.ok(!hasError(current) && hasError(next));
        assert.equal(toast(), 'Enter a new password.');

        next.value = 'new-password-123';
        confirm.value = 'different';
        await submitPasswordForm();
        assert.ok(!hasError(next) && hasError(confirm));
        assert.equal(toast(), 'The new passwords do not match.');
        assert.ok(!savedAnything());
    });
});
