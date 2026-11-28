// Sets the dashboard password in the database and signs out every session. It is how a
// fresh install gets its first password and how an operator recovers a forgotten one,
// so the password is never kept in plain text in bunryu.json.
//
//   node dist/setPassword.js     (production: sudo bash scripts/server-set-password.sh)
//
// The password comes from BUNRYU_DASHBOARD_PASSWORD (unattended installs), or is asked
// for, without echo, when run in a terminal. A running server keeps its sessions in
// memory, so restart it afterwards; the production wrapper does.
import { createDb } from './db/index.js';
import { readAppConfig } from './utils/appConfig.js';
import { setDashboardPassword } from './api/auth.js';

function askHidden(question: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        let value = '';
        const finish = () => {
            stdin.off('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stderr.write('\n');
        };
        const onData = (chunk: string) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    finish();
                    resolve(value);
                    return;
                }
                if (ch === '\u0003' || ch === '\u0004') {
                    finish();
                    reject(new Error('cancelled'));
                    return;
                }
                if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
                else value += ch;
            }
        };
        process.stderr.write(question);
        stdin.setEncoding('utf8');
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
    });
}

async function readPassword(): Promise<string> {
    const fromEnv = process.env.BUNRYU_DASHBOARD_PASSWORD;
    if (fromEnv) return fromEnv;
    if (!process.stdin.isTTY) {
        throw new Error('no terminal to ask in; set BUNRYU_DASHBOARD_PASSWORD');
    }
    const password = await askHidden('New dashboard password: ');
    if (password !== (await askHidden('Repeat it: '))) {
        throw new Error('the two passwords do not match');
    }
    return password;
}

async function main(): Promise<void> {
    const password = await readPassword();
    const config = readAppConfig();
    const db = createDb(config.databasePath, config.streamKeyCount);
    const revoked = await setDashboardPassword(db, password);
    console.log(
        `Dashboard password set in ${config.databasePath}; ${revoked} session(s) signed out.`,
    );
}

main().catch((err: unknown) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
