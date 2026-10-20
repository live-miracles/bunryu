import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Express } from 'express';
import { readAppConfig } from '../utils/appConfig.js';
import { readSrsConfigValues } from '../utils/srsConfig.js';

const VERSION_EXEC_TIMEOUT_MS = 3000;
const VERSION_FETCH_TIMEOUT_MS = 2000;
const SRT_RELAY_BIN_CANDIDATES = ['/usr/local/bin/goryu', './objs/goryu'];
const SRT_RELAY_LIB_DIR_CANDIDATES = ['/usr/local/lib/bunryu-srt', './objs/lib'];

function exec(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve) => {
        execFile(
            cmd,
            args,
            { timeout: VERSION_EXEC_TIMEOUT_MS, cwd, env },
            // A failed command (e.g. git outside a checkout) reports nothing, so the
            // caller shows "unknown" instead of the command's error text.
            (err, stdout, stderr) => {
                resolve(err ? '' : (stdout || stderr).trim());
            },
        );
    });
}

export function readAppVersion(): string {
    try {
        const pkgPath = path.join(__dirname, '..', '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
        return pkg.version ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

function readOsRelease(): string {
    try {
        const content = fs.readFileSync('/etc/os-release', 'utf8');
        const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
        return match?.[1] ?? os.type();
    } catch {
        return os.type();
    }
}

function readCpuModel(): string {
    try {
        return os.cpus()[0]?.model.replace(/\s+/g, ' ').trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

async function getSrsVersion(): Promise<string> {
    const srsApiUrl = readSrsConfigValues().apiUrl;
    try {
        const resp = await fetch(`${srsApiUrl}/api/v1/versions`, {
            signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
        });
        const data = (await resp.json()) as { data?: { version?: string } };
        return data?.data?.version ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

async function getSrtRelayVersion(): Promise<string> {
    const bin = SRT_RELAY_BIN_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (!bin) return 'unknown';

    const env = { ...process.env };
    const libDir = SRT_RELAY_LIB_DIR_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (libDir) {
        env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${libDir}:${env.LD_LIBRARY_PATH}` : libDir;
    }
    const version = await exec(bin, ['--version'], undefined, env);
    return version || 'unknown';
}

interface VersionResult {
    app: string;
    commit: string;
    srs: string;
    srtRelay: string;
    ffmpeg: string;
    node: string;
    os: string;
    kernel: string;
    cpuModel: string;
}

let cached: VersionResult | null = null;

export function registerVersionApi(app: Express): void {
    app.get('/api/version', async (_req, res) => {
        if (cached) return res.json(cached);

        const [commitLine, commitDate, srs, srtRelay, ffmpegOut] = await Promise.all([
            exec('git', ['log', '-1', '--format=%h %s']),
            // Format in the server's local timezone, matching journald/log output.
            exec('git', ['log', '-1', '--date=format-local:%Y-%m-%d %H:%M', '--format=%cd']),
            getSrsVersion(),
            getSrtRelayVersion(),
            exec(readAppConfig().ffmpegPath, ['-version']),
        ]);

        const ffmpegLine = ffmpegOut.split('\n')[0] ?? '';
        const ffmpeg = ffmpegLine.replace(/^ffmpeg version /, '').split(' ')[0] || 'unknown';

        cached = {
            app: readAppVersion(),
            commit: commitDate ? `${commitDate} ${commitLine}` : commitLine || 'unknown',
            srs: srs || 'unknown',
            srtRelay,
            ffmpeg,
            node: process.version,
            os: readOsRelease(),
            kernel: os.release(),
            cpuModel: readCpuModel(),
        };
        return res.json(cached);
    });
}
