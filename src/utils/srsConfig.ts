import fs from 'fs';
import { readAppConfig } from './appConfig.js';

export interface SrsConfigValues {
    apiUrl: string;
    rtmpHost: string;
    rtmpPort: number;
    srtPort: number;
    srtPassphrase: string | null;
}

const DEFAULT_RTMP_PORT = 1935;
const DEFAULT_SRT_PORT = 10080;
const DEFAULT_API_PORT = 1985;
const DEFAULT_RTMP_HOST = '127.0.0.1';

let cachedValues: SrsConfigValues | null = null;

function stripComments(conf: string): string {
    return conf
        .split('\n')
        .map((line) => line.replace(/#.*$/, ''))
        .join('\n');
}

// SRS `listen` entries are <[ip:]port> (e.g. `127.0.0.1:1985`); only the port
// matters here because the app always reaches SRS over 127.0.0.1.
function parsePort(value: string | undefined, fallback: number): number {
    const port = Number(value?.slice(value.lastIndexOf(':') + 1));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function parseDirective(block: string, name: string): string | null {
    const match = block.match(new RegExp(`(?:^|\\n)\\s*${name}\\s+([^;]+);`));
    return match?.[1]?.trim() ?? null;
}

function parseBlock(conf: string, name: string): string {
    const match = conf.match(new RegExp(`${name}\\s*\\{([\\s\\S]*?)\\}`));
    return match?.[1] ?? '';
}

function topLevelOnly(conf: string): string {
    return conf.replace(/\b[a-zA-Z_][\w-]*\s*\{[\s\S]*?\}/g, '');
}

// The passphrase srs.conf holds right now, read fresh from disk (readSrsConfigValues
// keeps the one SRS started with). Throws if the file can't be read.
export function readSrsPassphraseOnDisk(): string | null {
    const conf = stripComments(fs.readFileSync(readAppConfig().srsConfigPath, 'utf8'));
    return parseDirective(parseBlock(conf, 'srt_server'), 'passphrase') || null;
}

export function readSrsConfigValues(): SrsConfigValues {
    if (cachedValues) return cachedValues;

    const srsConfigPath = readAppConfig().srsConfigPath;
    let conf: string;
    try {
        conf = stripComments(fs.readFileSync(srsConfigPath, 'utf8'));
    } catch (err) {
        throw new Error(`Failed to read SRS config ${srsConfigPath}: ${String(err)}`, {
            cause: err,
        });
    }

    const topLevelConf = topLevelOnly(conf);
    const rtmpPort = parsePort(
        parseDirective(topLevelConf, 'listen') ?? undefined,
        DEFAULT_RTMP_PORT,
    );
    const httpApiBlock = parseBlock(conf, 'http_api');
    const apiPort = parsePort(
        parseDirective(httpApiBlock, 'listen') ?? undefined,
        DEFAULT_API_PORT,
    );
    const srtServerBlock = parseBlock(conf, 'srt_server');
    const srtPort = parsePort(
        parseDirective(srtServerBlock, 'listen') ?? undefined,
        DEFAULT_SRT_PORT,
    );
    const srtPassphrase = parseDirective(srtServerBlock, 'passphrase');

    cachedValues = {
        apiUrl: `http://127.0.0.1:${apiPort}`,
        rtmpHost: DEFAULT_RTMP_HOST,
        rtmpPort,
        srtPort,
        srtPassphrase: srtPassphrase || null,
    };
    return cachedValues;
}
