'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
    checkKeyVaultHost,
    parseKeyVaultInput,
    publicKeyVaultConfig,
    readStoredKeyVault,
} = require('../src/utils/keyVaultConfig');

const GOOD = {
    url: 'https://kv.example.invalid/functions/v1/ingest',
    token: 'fake-ingest-token-0123456789',
    hashSecret: 'fake-hash-secret-0123456789',
};

describe('parseKeyVaultInput', () => {
    test('accepts a complete, valid link and normalises the url', () => {
        assert.deepEqual(parseKeyVaultInput({ ...GOOD, url: ` ${GOOD.url} ` }, null), {
            config: GOOD,
        });
    });

    test('a leftover instance field is not kept: the server name is the instance', () => {
        const parsed = parseKeyVaultInput({ ...GOOD, instance: 'prod' }, null);
        assert.deepEqual(parsed, { config: GOOD });
    });

    test('http is for loopback only', () => {
        for (const host of ['localhost', '127.0.0.1', '[::1]']) {
            const parsed = parseKeyVaultInput({ ...GOOD, url: `http://${host}:8000/in` }, null);
            assert.ok('config' in parsed, host);
        }
        const remote = parseKeyVaultInput({ ...GOOD, url: 'http://kv.example.invalid/in' }, null);
        assert.match(remote.error, /https/);
    });

    test('refuses what cannot work, with the field named', () => {
        const cases = [
            [null, /object/],
            [[], /object/],
            [{ ...GOOD, url: undefined }, /url is required/],
            [{ ...GOOD, url: 'nope' }, /valid URL/],
            [{ ...GOOD, url: 'https://a:b@kv.example.invalid/' }, /credentials/],
            [{ ...GOOD, token: 'two words' }, /printable ASCII/],
            [{ ...GOOD, token: 'tôken-with-accent' }, /printable ASCII/],
            [{ ...GOOD, hashSecret: 'x'.repeat(15) }, /at least 16/],
        ];
        for (const [input, message] of cases) {
            const parsed = parseKeyVaultInput(input, null);
            assert.match(parsed.error ?? '', message, JSON.stringify(input));
        }
    });

    test('an empty token or secret falls back to the saved one only', () => {
        const empty = { ...GOOD, token: '', hashSecret: '' };
        assert.match(parseKeyVaultInput(empty, null).error, /token is required/);
        assert.deepEqual(parseKeyVaultInput(empty, GOOD), { config: GOOD });
    });
});

describe('readStoredKeyVault', () => {
    test('nothing stored, or an emptied value, is off without a problem', () => {
        assert.deepEqual(readStoredKeyVault(null), { config: null, problem: null });
        assert.deepEqual(readStoredKeyVault(''), { config: null, problem: null });
    });

    test('a stored link is read back', () => {
        assert.deepEqual(readStoredKeyVault(JSON.stringify(GOOD)), {
            config: GOOD,
            problem: null,
        });
    });

    test('a value that cannot be used is off, with the reason, and never throws', () => {
        const garbled = readStoredKeyVault('{oops');
        assert.equal(garbled.config, null);
        assert.match(garbled.problem, /not valid JSON/);
        const invalid = readStoredKeyVault(
            JSON.stringify({ ...GOOD, url: 'http://remote.invalid' }),
        );
        assert.equal(invalid.config, null);
        assert.match(invalid.problem, /https/);
        assert.equal(readStoredKeyVault('null').config, null);
    });
});

describe('publicKeyVaultConfig', () => {
    test('has no token or secret in it', () => {
        const shown = publicKeyVaultConfig(GOOD);
        assert.deepEqual(shown, {
            url: GOOD.url,
            tokenSet: true,
            hashSecretSet: true,
        });
        assert.equal(publicKeyVaultConfig(null), null);
    });
});

describe('checkKeyVaultHost', () => {
    test('refuses link-local (cloud metadata) and unspecified addresses', async () => {
        assert.match(await checkKeyVaultHost('https://169.254.169.254/latest'), /not allowed/);
        assert.match(await checkKeyVaultHost('https://0.0.0.0/x'), /not allowed/);
    });

    test('allows a public address, a private LAN one and loopback', async () => {
        for (const url of [
            'https://203.0.113.5/x',
            'https://192.168.1.20/x',
            'http://127.0.0.1:9000/x',
            'http://[::1]:9000/x',
        ]) {
            assert.equal(await checkKeyVaultHost(url), null, url);
        }
    });
});
