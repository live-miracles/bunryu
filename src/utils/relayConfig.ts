import fs from 'fs';
import path from 'path';
import { readAppConfig } from './appConfig.js';

export interface SrtBondingRelayConfig {
    input_host: string;
    input_port: number;
    output_host: string;
    output_port: number;
    status_port: number;
    passphrase: string;
}

export const DEFAULT_RELAY_CONFIG: SrtBondingRelayConfig = {
    input_host: '0.0.0.0',
    input_port: 10081,
    output_host: '127.0.0.1',
    output_port: 10080,
    status_port: 8081,
    passphrase: '',
};

function asString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function asPort(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
        ? value
        : fallback;
}

// Beside srs.conf. Computed on use so importing this module never reads bunryu.json.
export function getRelayConfigPath(): string {
    return path.join(path.dirname(readAppConfig().srsConfigPath), 'goryu.json');
}

export function normalizeRelayConfig(raw: unknown): SrtBondingRelayConfig {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
        input_host: asString(value.input_host, DEFAULT_RELAY_CONFIG.input_host),
        input_port: asPort(value.input_port, DEFAULT_RELAY_CONFIG.input_port),
        output_host: asString(value.output_host, DEFAULT_RELAY_CONFIG.output_host),
        output_port: asPort(value.output_port, DEFAULT_RELAY_CONFIG.output_port),
        status_port: asPort(value.status_port, DEFAULT_RELAY_CONFIG.status_port),
        passphrase: asString(value.passphrase, DEFAULT_RELAY_CONFIG.passphrase),
    };
}

let cachedConfig: SrtBondingRelayConfig | null = null;

// Goryu reads its file only at startup, so the app keeps the first successful read
// too: the values shown are the ones the running relay uses, and a file rewritten
// on disk shows up with the next restart. A failed read throws and caches nothing;
// the startup check (utils/configCheck.ts) turns that into an exit before the app
// serves anything, so there is no silent fallback to the defaults.
export function readRelayConfig(): SrtBondingRelayConfig {
    if (cachedConfig) return cachedConfig;
    const configPath = getRelayConfigPath();
    try {
        cachedConfig = normalizeRelayConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
        return cachedConfig;
    } catch (err) {
        throw new Error(`Failed to read relay config ${configPath}: ${String(err)}`, {
            cause: err,
        });
    }
}

// The passphrase goryu.json holds right now, read fresh from disk (readRelayConfig
// keeps the one Goryu started with). Throws if the file can't be read.
export function readRelayPassphraseOnDisk(): string {
    return normalizeRelayConfig(JSON.parse(fs.readFileSync(getRelayConfigPath(), 'utf8')))
        .passphrase;
}

export function renderRelayConfig(config: SrtBondingRelayConfig): string {
    return JSON.stringify(config, null, 4).concat('\n');
}
