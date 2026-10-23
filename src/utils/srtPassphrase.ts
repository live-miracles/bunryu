import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { readAppConfig } from './appConfig.js';
import { getRelayConfigPath, readRelayConfig, readRelayPassphraseOnDisk } from './relayConfig.js';
import { readSrsConfigValues, readSrsPassphraseOnDisk } from './srsConfig.js';

const PASSPHRASE_LENGTH = 32;
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// 32 random characters, alphanumeric like the installer's: srs.conf treats '#' as a
// comment and the app parses it, and SRT wants 10-79 characters. 62 divides 248, so
// taking each byte modulo 62 below the cut-off of 248 has no bias.
export function generateSrtPassphrase(): string {
    let out = '';
    while (out.length < PASSPHRASE_LENGTH) {
        for (const byte of crypto.randomBytes(PASSPHRASE_LENGTH)) {
            if (byte < 248 && out.length < PASSPHRASE_LENGTH) {
                out += ALPHANUMERIC[byte % ALPHANUMERIC.length];
            }
        }
    }
    return out;
}

// Replaces the value of the `passphrase` directive inside the srt_server block (the
// same directive readSrsConfigValues reads). Throws when the block or the directive
// is missing, so a config the app can't edit is never written half-way.
export function replaceSrsPassphrase(conf: string, passphrase: string): string {
    const block = conf.match(/srt_server\s*\{[\s\S]*?\}/);
    if (!block) throw new Error('srs.conf has no srt_server block');
    const directive = /^([ \t]*passphrase[ \t]+)[^;\n]*;/m;
    if (!directive.test(block[0])) {
        throw new Error('srs.conf has no "passphrase" directive in its srt_server block');
    }
    const updated = block[0].replace(directive, (_m, prefix: string) => `${prefix}${passphrase};`);
    return conf.replace(block[0], () => updated);
}

export function replaceRelayPassphrase(json: string, passphrase: string): string {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('goryu.json is not a JSON object');
    }
    return JSON.stringify({ ...parsed, passphrase }, null, 4).concat('\n');
}

// Temp file in the same directory, then rename: a reader (SRS, Goryu starting at the
// wrong moment) sees the old file or the new one, never half of one. The mode and
// owner of the original carry over.
function writeFileAtomic(file: string, content: string): void {
    const stat = fs.statSync(file);
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    try {
        fs.writeFileSync(tmp, content, { mode: stat.mode & 0o777 });
        fs.renameSync(tmp, file);
    } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
    }
}

// Writes the passphrase to srs.conf and goryu.json. Both new contents are built
// before anything is written, so a file the app can't parse changes nothing; if the
// second write still fails, the first file is put back. SRS and Goryu read their
// file only at startup, so the new value takes effect when both restart.
export function writeSrtPassphrase(passphrase: string): void {
    const srsPath = readAppConfig().srsConfigPath;
    const relayPath = getRelayConfigPath();
    const srsOriginal = fs.readFileSync(srsPath, 'utf8');
    const relayOriginal = fs.readFileSync(relayPath, 'utf8');
    const srsUpdated = replaceSrsPassphrase(srsOriginal, passphrase);
    const relayUpdated = replaceRelayPassphrase(relayOriginal, passphrase);

    writeFileAtomic(srsPath, srsUpdated);
    try {
        writeFileAtomic(relayPath, relayUpdated);
    } catch (err) {
        try {
            writeFileAtomic(srsPath, srsOriginal);
        } catch (rollbackErr) {
            throw new Error(
                `Failed to write ${relayPath} (${String(err)}) and to restore ${srsPath} (${String(rollbackErr)}); ` +
                    'the two files now hold different passphrases',
                { cause: rollbackErr },
            );
        }
        throw err;
    }
}

// True when a file now holds a different passphrase than the app read at startup, i.e.
// a reset is waiting for SRS and Goryu to restart (the app restarts with them, which
// clears it). Never throws: a file that can't be read is logged and reported as not
// pending, so /api/config keeps working.
export function srtPassphrasePending(): boolean {
    try {
        return (
            readSrsPassphraseOnDisk() !== readSrsConfigValues().srtPassphrase ||
            readRelayPassphraseOnDisk() !== readRelayConfig().passphrase
        );
    } catch (err) {
        console.warn('[settings] could not check for a pending SRT passphrase reset:', err);
        return false;
    }
}
