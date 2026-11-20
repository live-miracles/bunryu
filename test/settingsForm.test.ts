import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

interface FakeElement {
    value: string;
    dataset: Record<string, string>;
    textContent: string;
    classList: {
        add(c: string): unknown;
        remove(c: string): unknown;
        toggle(c: string, force?: boolean): unknown;
        contains(c: string): boolean;
    };
}

function fakeElement(value = '', dataset: Record<string, string> = {}): FakeElement {
    const classes = new Set<string>();
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

const hasError = (el: FakeElement) => el.classList.contains('input-error');

// The dashboard modules read these browser globals; the fakes below stand in for them, and this
// is the one place they are let through as the DOM types they replace.
const browser = globalThis as unknown as { document: unknown; window: unknown; fetch: unknown };

describe('settings forms do not fail silently', () => {
    let elements: Record<string, FakeElement>;
    let rows: Record<string, unknown[]>;
    let selectors: Record<string, unknown>;
    let fetchCalls: string[];
    const realDocument = browser.document;
    const realFetch = browser.fetch;
    const realWindow = browser.window;

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
        rows = { '[data-pipeline-group-row]': [] };
        selectors = {};
        browser.document = {
            getElementById: (id: string) => elements[id] ?? null,
            querySelectorAll: (selector: string) => rows[selector] ?? [],
            querySelector: (selector: string) => selectors[selector] ?? null,
            addEventListener() {},
            title: '',
        };
        // Importing the editor pulls in the dashboard module, which starts a refresh
        // on load; its requests never settle here.
        browser.window = { location: { search: '', href: '' }, addEventListener() {} };
        fetchCalls = [];
        browser.fetch = (url: unknown) => {
            fetchCalls.push(String(url));
            return new Promise(() => {});
        };
    });

    afterEach(() => {
        browser.document = realDocument;
        browser.fetch = realFetch;
        browser.window = realWindow;
    });

    test('an empty server name is marked, explained and not sent', async () => {
        const { submitGeneralSettingsForm } =
            require('../public/ts/features/editor') as typeof import('../public/ts/features/editor');

        await submitGeneralSettingsForm();

        assert.ok(hasError(elements['settings-server-name-input']));
        assert.equal(toast(), 'Server name is required.');
        assert.ok(!elements['error-alert'].classList.contains('hidden'));
        assert.ok(!savedAnything());
    });

    test('password: each missing or mismatched field is marked and explained', async () => {
        const { submitPasswordForm } =
            require('../public/ts/features/editor') as typeof import('../public/ts/features/editor');
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
