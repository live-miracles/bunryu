import crypto from 'crypto';
import { classifyAddress, resolveAddresses } from './destination.js';

// The Key Vault link as the operator sets it in Settings (stored as JSON in the
// `keyVault` setting). The rules live here so that the Settings route refuses a wrong
// value when it is typed: nothing invalid is ever stored, and nothing about this link
// can stop the server from starting.

export const KEY_VAULT_SETTING = 'keyVault';

export interface KeyVaultConfig {
    // The ingest endpoint: https, or http only on loopback (a local test receiver).
    url: string;
    // Sent as `Authorization: Bearer <token>`.
    token: string;
    // Secret shared with Key Vault for the HMAC of each output's destination URL.
    hashSecret: string;
}

// What the dashboard may read back: the secret only as "is one saved".
export interface KeyVaultPublicConfig {
    url: string;
    secretSet: boolean;
}

// The operator enters one secret, the same `KEY_VAULT_SECRET` Key Vault is set up with.
// Key Vault derives the token and the hash secret from it; so does this server (below),
// and only those two are saved. The shortest secret Key Vault accepts, so a value this
// server takes is one Key Vault will take.
export const MIN_SECRET_LENGTH = 32;

// HMAC-SHA256 of the secret under a label, hex. The labels and the pinned values in
// test/keyVaultConfig.test.ts are Key Vault's (supabase/functions/_shared/secrets.ts):
// change them together or the token will never be accepted.
export function deriveKeyVaultSecrets(secret: string): { token: string; hashSecret: string } {
    const derive = (label: string) =>
        crypto.createHmac('sha256', secret).update(label).digest('hex');
    return {
        token: derive('key-vault/ingest-token'),
        hashSecret: derive('key-vault/hash-secret'),
    };
}

export function publicKeyVaultConfig(config: KeyVaultConfig | null): KeyVaultPublicConfig | null {
    return config ? { url: config.url, secretSet: true } : null;
}

// The stored value, or null when there is none. A value that cannot be used (the
// database was edited by hand) is reported as `problem` and treated as off, so the
// caller can say so instead of failing.
export function readStoredKeyVault(raw: string | null): {
    config: KeyVaultConfig | null;
    problem: string | null;
} {
    if (!raw) return { config: null, problem: null };
    try {
        const stored = JSON.parse(raw) as Record<string, unknown>;
        const url = checkUrl(stored.url);
        if (typeof url !== 'string') return { config: null, problem: url.error };
        const { token, hashSecret } = stored;
        if (typeof token !== 'string' || !token || typeof hashSecret !== 'string' || !hashSecret) {
            return { config: null, problem: 'the saved secret is missing; enter it again' };
        }
        return { config: { url, token, hashSecret }, problem: null };
    } catch (err) {
        return { config: null, problem: `not valid JSON (${String(err)})` };
    }
}

function text(raw: Record<string, unknown>, key: string): string | { error: string } {
    const value = raw[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return { error: `${key} must be a string` };
    return value.trim();
}

function checkUrl(value: unknown): string | { error: string } {
    if (typeof value !== 'string' || !value.trim()) return { error: 'url is required' };
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return { error: 'url is not a valid URL' };
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        return { error: 'url must be https (http is allowed only for localhost)' };
    }
    if (url.username || url.password) {
        return { error: 'url must not contain credentials; use the secret' };
    }
    return url.toString();
}

// Checks what the operator sent. A secret that is left empty keeps the saved one (the
// dashboard never shows it), so it is only required the first time.
export function parseKeyVaultInput(
    input: unknown,
    existing: KeyVaultConfig | null,
): { config: KeyVaultConfig } | { error: string } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'Key Vault settings must be an object' };
    }
    const raw = input as Record<string, unknown>;
    const url = checkUrl(raw.url);
    if (typeof url !== 'string') return url;

    const secret = text(raw, 'secret');
    if (typeof secret !== 'string') return secret;
    if (!secret) {
        if (!existing) return { error: 'secret is required' };
        return { config: { ...existing, url } };
    }
    // It becomes a MAC key, and printable ASCII leaves no doubt about the bytes both
    // sides hash.
    if (!/^[!-~]+$/.test(secret)) {
        return { error: 'secret must be printable ASCII without spaces' };
    }
    if (secret.length < MIN_SECRET_LENGTH) {
        return { error: `secret must be at least ${MIN_SECRET_LENGTH} characters` };
    }
    return { config: { url, ...deriveKeyVaultSecrets(secret) } };
}

// The server posts to whatever host the operator types, like an output destination:
// link-local (cloud metadata) and the unspecified address are refused, by what the
// host resolves to. A name that does not resolve is allowed; the report then fails
// and is logged like any other.
export async function checkKeyVaultHost(url: string): Promise<string | null> {
    const host = new URL(url).hostname;
    for (const address of await resolveAddresses(host)) {
        if (classifyAddress(address) === 'blocked') {
            return `url host ${host} resolves to ${address}, a link-local or unspecified address that is not allowed`;
        }
    }
    return null;
}
