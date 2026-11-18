'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { statusHtml } = require('../public/ts/features/key-vault-status');

const NOW = 1_800_000_000_000;
const status = (over) => ({
    state: 'ok',
    lastReportAtMs: NOW - 12_000,
    problem: null,
    failingSinceMs: null,
    skipped: null,
    ...over,
});
const view = (s) => statusHtml({ status: s, nowMs: NOW });

describe('Key Vault status line', () => {
    test('says the reports are off when there is no link', () => {
        assert.match(view(null), /Reports are off/);
    });

    test('says it is waiting before the first answer', () => {
        assert.match(
            view(status({ state: 'waiting', lastReportAtMs: null })),
            /Waiting for the first report/,
        );
    });

    test('says connected, with how long ago, measured on the server clock', () => {
        const html = view(status());
        assert.match(html, /Connected/);
        assert.match(html, /12 s ago/);
        assert.doesNotMatch(html, /left out/);
    });

    test('warns when Key Vault left entries out, in the singular and the plural', () => {
        assert.match(view(status({ skipped: 1 })), /left out 1 entry/);
        assert.match(view(status({ skipped: 3 })), /left out 3 entries/);
    });

    test('shows the problem, since when, and the last good report', () => {
        const html = view(
            status({
                state: 'failing',
                problem: 'Key Vault refused the secret (HTTP 401).',
                failingSinceMs: NOW - 5 * 60_000,
            }),
        );
        assert.match(html, /Not reaching Key Vault since .*5 min ago/);
        assert.match(html, /refused the secret/);
        assert.match(html, /last report went through .*12 s ago/);
    });

    test('says so when no report has ever gone through', () => {
        const html = view(
            status({
                state: 'failing',
                lastReportAtMs: null,
                problem: 'The host in the link was not found.',
                failingSinceMs: NOW - 1000,
            }),
        );
        assert.match(html, /No report has gone through yet/);
    });

    test('shows the problem as text, never as markup', () => {
        const html = view(
            status({
                state: 'failing',
                problem: 'Could not reach Key Vault (<img src=x onerror=alert(1)>).',
                failingSinceMs: NOW,
            }),
        );
        assert.ok(!html.includes('<img'));
        assert.match(html, /&lt;img/);
    });
});
