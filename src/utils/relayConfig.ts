import fs from 'fs';
import path from 'path';
import { readAppConfig } from './appConfig.js';

const CONF_PATH = readAppConfig().srsConfigPath;
const RELAY_CONFIG_PATH = path.join(path.dirname(CONF_PATH), 'goryu.json');

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

export function getRelayConfigPath(): string {
    return RELAY_CONFIG_PATH;
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

export function readRelayConfig(): SrtBondingRelayConfig {
    try {
        return normalizeRelayConfig(JSON.parse(fs.readFileSync(RELAY_CONFIG_PATH, 'utf8')));
    } catch {
        return { ...DEFAULT_RELAY_CONFIG };
    }
}

export function renderRelayConfig(config: SrtBondingRelayConfig): string {
    return JSON.stringify(config, null, 4).concat('\n');
}
