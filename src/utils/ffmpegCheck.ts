import { execFile } from 'child_process';
import { ffmpegEnv } from './ffmpeg.js';

const CHECK_TIMEOUT_MS = 10_000;

// What the outputs and previews need from the ffmpeg build.
// A build without one of them still starts, so without this check the gap shows
// up only as every output of that kind failing.
const REQUIRED_PROTOCOLS = ['rtmp', 'rtmps', 'srt'];
const REQUIRED_ENCODERS = ['aac', 'libx264'];

export interface FfmpegCheckResult {
    ok: boolean;
    version: string | null;
    // e.g. "srt output protocol", "libx264 encoder", "ffprobe"
    missing: string[];
    error: string | null;
}

// `ffmpeg -protocols` lists names under "Input:" then "Output:".
export function parseProtocols(text: string): { input: Set<string>; output: Set<string> } {
    const input = new Set<string>();
    const output = new Set<string>();
    let section: Set<string> | null = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === 'Input:') section = input;
        else if (line === 'Output:') section = output;
        else if (section && /^[a-z0-9_]+$/.test(line)) section.add(line);
    }
    return { input, output };
}

// `ffmpeg -encoders`: " V....D libx264  ..."; the name is the second column. Legend lines ("V..... = Video") are skipped.
export function parseNames(text: string): Set<string> {
    const names = new Set<string>();
    for (const line of text.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 3 && cols[1] !== '=' && /^[a-z0-9_]+$/.test(cols[1])) {
            names.add(cols[1]);
        }
    }
    return names;
}

export function missingFeatures(listings: { protocols: string; encoders: string }): string[] {
    const missing: string[] = [];
    const protocols = parseProtocols(listings.protocols);
    for (const name of REQUIRED_PROTOCOLS) {
        if (!protocols.input.has(name)) missing.push(`${name} input protocol`);
        if (!protocols.output.has(name)) missing.push(`${name} output protocol`);
    }
    const encoders = parseNames(listings.encoders);
    for (const name of REQUIRED_ENCODERS) {
        if (!encoders.has(name)) missing.push(`${name} encoder`);
    }
    return missing;
}

function run(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            cmd,
            args,
            { timeout: CHECK_TIMEOUT_MS, killSignal: 'SIGKILL', env: ffmpegEnv() },
            (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        );
    });
}

// Runs the configured ffmpeg and ffprobe once and reports what the app needs
// but the build lacks. Never throws: a broken binary is a result, not an error.
export async function checkFfmpeg(
    ffmpegPath: string,
    ffprobePath: string,
): Promise<FfmpegCheckResult> {
    let version: string | null = null;
    let missing: string[];
    try {
        const versionOut = await run(ffmpegPath, ['-hide_banner', '-version']);
        version = /^ffmpeg version (\S+)/.exec(versionOut)?.[1] ?? null;
        const [protocols, encoders] = await Promise.all([
            run(ffmpegPath, ['-hide_banner', '-protocols']),
            run(ffmpegPath, ['-hide_banner', '-encoders']),
        ]);
        missing = missingFeatures({ protocols, encoders });
    } catch (err) {
        const error = `ffmpeg (${ffmpegPath}) did not run: ${err instanceof Error ? err.message : String(err)}`;
        return { ok: false, version, missing: [], error };
    }
    try {
        await run(ffprobePath, ['-hide_banner', '-version']);
    } catch {
        missing.push('ffprobe');
    }
    return { ok: missing.length === 0, version, missing, error: null };
}
