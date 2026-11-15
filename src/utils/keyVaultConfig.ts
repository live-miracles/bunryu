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
    // Names this bunryu to Key Vault (e.g. "prod").
    instance: string;
}

// What the dashboard may read back: the secrets only as "is one saved".
export interface KeyVaultPublicConfig {
    url: string;
    instance: string;
    tokenSet: boolean;
    hashSecretSet: boolean;
}

const MIN_HASH_SECRET_LENGTH = 16;

export function publicKeyVaultConfig(config: KeyVaultConfig | null): KeyVaultPublicConfig | null {
    return config
        ? { url: config.url, instance: config.instance, tokenSet: true, hashSecretSet: true }
        : null;
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
        const parsed = parseKeyVaultInput(stored, null);
        if ('error' in parsed) return { config: null, problem: parsed.error };
        return { config: parsed.config, problem: null };
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

// Checks what the operator sent. A token or secret that is left empty keeps the saved
// one (the dashboard never shows them), so it is only required the first time.
export function parseKeyVaultInput(
    input: unknown,
    existing: KeyVaultConfig | null,
): { config: KeyVaultConfig } | { error: string } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'Key Vault settings must be an object' };
    }
    const raw = input as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const key of ['url', 'token', 'hashSecret', 'instance']) {
        const value = text(raw, key);
        if (typeof value !== 'string') return value;
        fields[key] = value;
    }

    if (!fields.url) return { error: 'url is required' };
    let url: URL;
    try {
        url = new URL(fields.url);
    } catch {
        return { error: 'url is not a valid URL' };
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        return { error: 'url must be https (http is allowed only for localhost)' };
    }
    if (url.username || url.password) {
        return { error: 'url must not contain credentials; use the token' };
    }

    // Both go into a header or a MAC key.
    const token = fields.token || existing?.token || '';
    if (!token) return { error: 'token is required' };
    if (!/^[!-~]+$/.test(token)) {
        return { error: 'token must be printable ASCII without spaces (it is sent in a header)' };
    }
    const hashSecret = fields.hashSecret || existing?.hashSecret || '';
    if (!hashSecret) return { error: 'hashSecret is required' };
    if (hashSecret.length < MIN_HASH_SECRET_LENGTH) {
        return { error: `hashSecret must be at least ${MIN_HASH_SECRET_LENGTH} characters` };
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(fields.instance)) {
        return { error: 'instance must be 1-64 characters of letters, digits, ".", "_" or "-"' };
    }
    return { config: { url: url.toString(), token, hashSecret, instance: fields.instance } };
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
