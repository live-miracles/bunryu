import { readAppConfig } from './appConfig.js';
import { readRelayConfig } from './relayConfig.js';
import { readSrsConfigValues } from './srsConfig.js';

// EX_CONFIG: bunryu.service has RestartPreventExitStatus=78 (and the Docker
// entrypoint stops restarting), so a failure that needs an operator leaves the
// unit failed with its message instead of restarting every 2 s forever.
export const EXIT_NEEDS_OPERATOR = 78;

// A read that fails the same way on every attempt: the file is missing or does
// not parse. Anything else (EIO, EMFILE, ...) may pass on the next start, so it
// is left to crash and be restarted. The readers wrap the original error as `cause`.
export function isPermanentConfigError(err: unknown): boolean {
    for (let e = err; e instanceof Error; e = e.cause) {
        if (e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === 'ENOENT') return true;
    }
    return false;
}

// Reads bunryu.json, srs.conf and goryu.json, which the app then uses from its cache
// until it restarts. Throws the reader's error for the first one that fails.
export function checkConfigFiles(): void {
    readAppConfig();
    readSrsConfigValues();
    readRelayConfig();
}

// Run first thing at startup, before any module reads a config file. A missing or
// invalid file exits with 78; any other failure is rethrown so the process crashes
// and is restarted.
export function exitIfConfigUnusable(): void {
    try {
        checkConfigFiles();
    } catch (err) {
        if (!isPermanentConfigError(err)) throw err;
        console.error(
            `[server] ${err instanceof Error ? err.message : String(err)}\n` +
                '[server] Fix or restore the file, then start again; the service is not restarted automatically.',
        );
        process.exit(EXIT_NEEDS_OPERATOR);
    }
}
