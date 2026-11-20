import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    checkKeyVaultHost,
    deriveKeyVaultSecrets,
    parseKeyVaultInput,
    publicKeyVaultConfig,
    readStoredKeyVault,
} from '../src/utils/keyVaultConfig';

const SECRET = 'fake-key-vault-secret-0123456789-abcdef';
const INPUT = { url: 'https://kv.example.invalid/functions/v1/ingest', secret: SECRET };
// What is saved: the two values derived from the secret, not the secret itself.
const GOOD = { url: INPUT.url, ...deriveKeyVaultSecrets(SECRET) };

describe('deriveKeyVaultSecrets', () => {
    test('matches the values Key Vault derives from the same secret', () => {
        // Pinned in Key Vault's test/secrets.test.mjs, computed there independently.
        assert.deepEqual(deriveKeyVaultSecrets('0123456789abcdef0123456789abcdef'), {
            token: '5899fc7ac70ac6e23c92cc4df577eea12fb89387be1b5a259359eb63d01ed506',
            hashSecret: '93a67513fc94b90004f8f0e49a786044707e0ad3a3a5d6545c88c5d4f981fb59',
        });
    });

    test('the token and the hash secret differ and do not contain the secret', () => {
        const { token, hashSecret } = deriveKeyVaultSecrets(SECRET);
        assert.notEqual(token, hashSecret);
        assert.ok(!token.includes(SECRET) && !hashSecret.includes(SECRET));
    });
});

describe('parseKeyVaultInput', () => {
    test('derives the token and hash secret from the secret and normalises the url', () => {
        assert.deepEqual(parseKeyVaultInput({ ...INPUT, url: ` ${INPUT.url} ` }, null), {
            config: GOOD,
        });
    });

    test('a leftover instance, token or hashSecret field is not kept', () => {
        const parsed = parseKeyVaultInput(
            { ...INPUT, instance: 'prod', token: 'old', hashSecret: 'old-old-old-old-old' },
            null,
        );
        assert.deepEqual(parsed, { config: GOOD });
    });

    test('http is for loopback only', () => {
        for (const host of ['localhost', '127.0.0.1', '[::1]']) {
            const parsed = parseKeyVaultInput({ ...INPUT, url: `http://${host}:8000/in` }, null);
            assert.ok('config' in parsed, host);
        }
        const remote = parseKeyVaultInput({ ...INPUT, url: 'http://kv.example.invalid/in' }, null);
        assert.match(remote.error, /https/);
    });

    test('refuses what cannot work, with the field named', () => {
        const cases = [
            [null, /object/],
            [[], /object/],
            [{ ...INPUT, url: undefined }, /url is required/],
            [{ ...INPUT, url: 'nope' }, /valid URL/],
            [{ ...INPUT, url: 'https://a:b@kv.example.invalid/' }, /credentials/],
            [{ ...INPUT, secret: 'two words '.repeat(5) }, /printable ASCII/],
            [{ ...INPUT, secret: 'sécret-with-accent-0123456789-abcdef' }, /printable ASCII/],
            [{ ...INPUT, secret: 'x'.repeat(31) }, /at least 32/],
            [{ ...INPUT, secret: 12345 }, /string/],
        ];
        for (const [input, message] of cases) {
            const parsed = parseKeyVaultInput(input, null);
            assert.match(parsed.error ?? '', message, JSON.stringify(input));
        }
    });

    test('an empty secret falls back to the saved one only', () => {
        const empty = { ...INPUT, secret: '' };
        assert.match(parseKeyVaultInput(empty, null).error, /secret is required/);
        assert.deepEqual(parseKeyVaultInput(empty, GOOD), { config: GOOD });
        const moved = parseKeyVaultInput(
            { ...empty, url: 'https://other.example.invalid/in' },
            GOOD,
        );
        assert.deepEqual(moved, { config: { ...GOOD, url: 'https://other.example.invalid/in' } });
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
        assert.deepEqual(shown, { url: GOOD.url, secretSet: true });
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
