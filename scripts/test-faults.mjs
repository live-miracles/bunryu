#!/usr/bin/env node
// Fault scenarios for the isolated test stack (scripts/test-stack.sh). Unlike the
// stack's default fake outputs, these push real FFmpeg copy outputs to real local
// destinations, so a destination can really freeze or swallow data:
//
//   freeze     50 healthy outputs + one whose destination is stopped (kill -STOP)
//   blackhole  50 healthy outputs + one whose destination accepts the TCP
//              connection and never reads or answers
//   soak       both faults for --minutes N (default 60), sampled every 30 s; fails
//              if memory, file handles or process count keep growing
//
// Usage:  FAST_WATCHDOG=1 scripts/test-stack.sh start
//         node scripts/test-faults.mjs freeze|blackhole|soak [--minutes N]
//         scripts/test-stack.sh stop
//
// FAST_WATCHDOG=1 shortens the stall watchdog (20 s warm-up, 15 s stall) so the
// scenarios take minutes. Needs ~1 GB free for the 50 FFmpeg processes. Exits 1 if
// any check fails; each check is printed as PASS or FAIL.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const WORK = process.env.WORK ?? path.join(process.env.TMPDIR ?? '/tmp', 'bunryu-ui');
const REPO = path.resolve(import.meta.dirname, '..');
const APP = 'http://127.0.0.1:18080';
const APP_PORT = 18080;
const SHIM = path.join(WORK, 'ffmpeg-shim.sh');
// Destination numbers are the last octet of 192.0.2.<N> in the output URL, which
// the stack's ffmpeg shim maps to $WORK/dest-<N>.port.
const DEST_HEALTHY = 1;
const DEST_FROZEN = 2;
const DEST_BLACKHOLE = 3;
const PORT_BASE = 31950;
const HEALTHY_OUTPUTS = 50;
const PIPELINE = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function check(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function waitFor(what, fn, timeoutMs, everyMs = 2000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > until) return null;
        await sleep(everyMs);
    }
}

// ── app API ─────────────────────────────────────────────────────────────────

let cookie = '';

async function api(method, route, body) {
    const res = await fetch(`${APP}${route}`, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
}

async function login() {
    const res = await fetch(`${APP}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'admin' }),
    });
    if (!res.ok) throw new Error(`login failed (${res.status}); is the stack running?`);
    cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
}

async function outputsHealth() {
    const health = await api('GET', '/api/health');
    return health.pipelines[String(PIPELINE)]?.outputs ?? {};
}

// ── processes ───────────────────────────────────────────────────────────────

function processTable() {
    return execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
            return m && { pid: +m[1], ppid: +m[2], rssKb: +m[3], args: m[4] };
        })
        .filter(Boolean);
}

function listenerPid(port) {
    try {
        const out = execFileSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
        return Number(out.split('\n')[0]) || null;
    } catch {
        return null;
    }
}

function fdCount(pid) {
    try {
        return fs.readdirSync(`/proc/${pid}/fd`).length;
    } catch {
        return null;
    }
}

const mb = (kb) => Math.round(kb / 1024);

function sample(destPids) {
    const table = processTable();
    const appPid = listenerPid(APP_PORT);
    const srsPid = listenerPid(31935);
    const rss = (pid) => table.find((p) => p.pid === pid)?.rssKb ?? 0;
    const ffmpegs = table.filter((p) => p.ppid === appPid && p.args.startsWith(SHIM));
    return {
        t: Date.now(),
        appRssMb: mb(rss(appPid)),
        srsRssMb: mb(rss(srsPid)),
        destRssMb: mb(destPids.reduce((sum, pid) => sum + rss(pid), 0)),
        ffmpegCount: ffmpegs.length,
        ffmpegRssMb: mb(ffmpegs.reduce((sum, p) => sum + p.rssKb, 0)),
        appFds: fdCount(appPid),
    };
}

// ── diagnostics ─────────────────────────────────────────────────────────────

function diagnosticsEvents(event, outputId) {
    const dir = path.join(WORK, 'diagnostics');
    if (!fs.existsSync(dir)) return [];
    const events = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
        for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
            if (!line.includes(event)) continue;
            try {
                const e = JSON.parse(line);
                if (e.event === event && (!outputId || e.outputId === outputId)) events.push(e);
            } catch {
                /* a partial last line */
            }
        }
    }
    return events;
}

// ── destinations ────────────────────────────────────────────────────────────

const cleanups = [];

function destPort(n) {
    return PORT_BASE + n;
}

function startDestSrs(n) {
    const port = destPort(n);
    const conf = path.join(WORK, `dest-${n}.conf`);
    fs.writeFileSync(
        conf,
        `pid ${path.join(WORK, `dest-${n}.pid`)};\nlisten ${port};\nmax_connections 1000;\ndaemon off;\n` +
            `srs_log_tank console;\nsrs_log_level warn;\nvhost __defaultVhost__ {\n}\n`,
    );
    const log = fs.openSync(path.join(WORK, `dest-${n}.out`), 'w');
    const child = spawn(path.join(REPO, 'objs/srs'), ['-c', conf], {
        stdio: ['ignore', log, log],
    });
    cleanups.push(() => {
        try {
            process.kill(child.pid, 'SIGCONT');
            child.kill('SIGKILL');
        } catch {
            /* already gone */
        }
    });
    fs.writeFileSync(path.join(WORK, `dest-${n}.port`), String(port));
    return child.pid;
}

// Accepts connections and never reads from them or answers: the kernel completes
// the TCP handshake, so the client's connect succeeds and its writes then block.
function startBlackhole(n) {
    const port = destPort(n);
    const server = net.createServer({ pauseOnConnect: true }, () => {});
    server.listen(port, '127.0.0.1');
    cleanups.push(() => server.close());
    fs.writeFileSync(path.join(WORK, `dest-${n}.port`), String(port));
}

function cleanup() {
    for (const fn of cleanups.splice(0)) fn();
    for (const n of [DEST_HEALTHY, DEST_FROZEN, DEST_BLACKHOLE]) {
        fs.rmSync(path.join(WORK, `dest-${n}.port`), { force: true });
    }
}

// ── setup ───────────────────────────────────────────────────────────────────

async function setup({ frozen, blackhole }) {
    if (!listenerPid(APP_PORT))
        throw new Error('the test stack is not running (test-stack.sh start)');
    await login();
    const destPids = [startDestSrs(DEST_HEALTHY)];
    if (frozen) destPids.push(startDestSrs(DEST_FROZEN));
    if (blackhole) startBlackhole(DEST_BLACKHOLE);
    await sleep(1500);

    await api('POST', `/api/pipelines/${PIPELINE}/outputs/stop-all`);
    await waitFor(
        'outputs stopped',
        async () => {
            const o = await outputsHealth();
            return Object.values(o).every((x) => x.status !== 'running');
        },
        30_000,
    );
    await api('DELETE', `/api/pipelines/${PIPELINE}/outputs`);

    const outputs = [];
    for (let i = 1; i <= HEALTHY_OUTPUTS; i++) {
        outputs.push({
            name: `h${String(i).padStart(2, '0')}`,
            url: `rtmp://192.0.2.${DEST_HEALTHY}/live/h${i}`,
        });
    }
    if (frozen) outputs.push({ name: 'frozen', url: `rtmp://192.0.2.${DEST_FROZEN}/live/frozen` });
    if (blackhole) {
        outputs.push({ name: 'blackhole', url: `rtmp://192.0.2.${DEST_BLACKHOLE}/live/blackhole` });
    }
    const created = await api('POST', `/api/pipelines/${PIPELINE}/outputs/bulk`, { outputs });
    const ids = Object.fromEntries(created.map((o) => [o.name, o.id]));
    const healthyIds = created.filter((o) => o.name.startsWith('h')).map((o) => o.id);
    await api('POST', `/api/pipelines/${PIPELINE}/outputs/start-all`);

    const ready = await waitFor(
        'healthy outputs running',
        async () => {
            const o = await outputsHealth();
            return healthyIds.every((id) => o[id]?.status === 'running' && o[id].bitrateKbps > 0);
        },
        180_000,
    );
    check(`${HEALTHY_OUTPUTS} healthy outputs reach running with data flowing`, !!ready);
    if (!ready) throw new Error('healthy outputs did not start; see ' + WORK + '/app.log');
    return { ids, healthyIds, destPids, expectedFfmpeg: created.length };
}

// What each healthy output looked like at the start, to detect any restart.
async function baselineOf(healthyIds) {
    const o = await outputsHealth();
    return new Map(
        healthyIds.map((id) => [id, { startedAtMs: o[id].startedAtMs, failures: o[id].failures }]),
    );
}

function restartedHealthy(o, baseline) {
    return [...baseline].filter(
        ([id, b]) =>
            !o[id] ||
            o[id].status !== 'running' ||
            o[id].startedAtMs !== b.startedAtMs ||
            o[id].failures !== b.failures,
    ).length;
}

// ── scenarios ───────────────────────────────────────────────────────────────

async function freeze(ctx) {
    const { ids, healthyIds, destPids, expectedFfmpeg } = ctx;
    await waitFor(
        'frozen output running',
        async () => {
            const o = await outputsHealth();
            return o[ids.frozen]?.status === 'running' && o[ids.frozen].bitrateKbps > 0;
        },
        60_000,
    );
    await sleep(20_000);
    const baseline = await baselineOf(healthyIds);
    const restartsBefore = diagnosticsEvents('ffmpeg-restart', ids.frozen).length;

    console.log('freezing the frozen output’s destination (SIGSTOP)');
    process.kill(destPids[1], 'SIGSTOP');
    const t0 = Date.now();
    let maxFfmpeg = 0;
    let worstHealthy = 0;
    let restartedAt = null;
    while (Date.now() - t0 < 240_000) {
        const o = await outputsHealth();
        maxFfmpeg = Math.max(maxFfmpeg, sample(destPids).ffmpegCount);
        worstHealthy = Math.max(worstHealthy, restartedHealthy(o, baseline));
        if (
            !restartedAt &&
            diagnosticsEvents('ffmpeg-restart', ids.frozen).length > restartsBefore
        ) {
            restartedAt = Date.now();
            console.log(
                `stall watchdog restarted it after ${Math.round((restartedAt - t0) / 1000)} s`,
            );
        }
        if (restartedAt && Date.now() - restartedAt > 20_000) break;
        await sleep(3000);
    }
    check('the stalled output is restarted by the stall watchdog', !!restartedAt);
    check(
        'no healthy output restarted or stopped while it was frozen',
        worstHealthy === 0,
        `worst ${worstHealthy}`,
    );
    check(
        'FFmpeg process count stays bounded',
        maxFfmpeg <= expectedFfmpeg + 1,
        `max ${maxFfmpeg} of ${expectedFfmpeg}`,
    );

    console.log('thawing the destination (SIGCONT)');
    process.kill(destPids[1], 'SIGCONT');
    const recovered = await waitFor(
        'frozen output recovers',
        async () => {
            const o = await outputsHealth();
            return o[ids.frozen]?.status === 'running' && o[ids.frozen].bitrateKbps > 0;
        },
        120_000,
    );
    check('the output recovers by itself once the destination is back', !!recovered);
    await sleep(5000);
    check(
        'process count returns to one FFmpeg per output',
        sample(destPids).ffmpegCount === expectedFfmpeg,
        `${sample(destPids).ffmpegCount} of ${expectedFfmpeg}`,
    );
}

async function blackhole(ctx) {
    const { ids, healthyIds, destPids, expectedFfmpeg } = ctx;
    const baseline = await baselineOf(healthyIds);
    const restartsBefore = diagnosticsEvents('ffmpeg-restart', ids.blackhole).length;
    const t0 = Date.now();
    let maxFfmpeg = 0;
    let worstHealthy = 0;
    let everFlowing = false;
    while (Date.now() - t0 < 150_000) {
        const o = await outputsHealth();
        maxFfmpeg = Math.max(maxFfmpeg, sample(destPids).ffmpegCount);
        worstHealthy = Math.max(worstHealthy, restartedHealthy(o, baseline));
        if (o[ids.blackhole]?.bitrateKbps > 0) everFlowing = true;
        await sleep(3000);
    }
    const restarts = diagnosticsEvents('ffmpeg-restart', ids.blackhole).slice(restartsBefore);
    check('no data ever flows to the black-holed destination', !everFlowing);
    const gapsSec = restarts
        .slice(1)
        .map((e, i) => (Date.parse(e.ts) - Date.parse(restarts[i].ts)) / 1000);
    check(
        'the stall watchdog restarts the stuck output, every time for a stall',
        restarts.length >= 2 && restarts.every((e) => e.reason === 'output progress stalled'),
        `${restarts.length} restarts`,
    );
    // A run needs the 20 s warm-up before it can be judged stalled, so a gap
    // shorter than that would be a retry loop spinning.
    check(
        'restarts are spaced out, never a tight loop',
        gapsSec.length > 0 && gapsSec.every((g) => g >= 20),
        `gaps ${gapsSec.map((g) => Math.round(g)).join(', ')} s`,
    );
    check('no healthy output restarted or stopped', worstHealthy === 0, `worst ${worstHealthy}`);
    check(
        'FFmpeg process count stays bounded',
        maxFfmpeg <= expectedFfmpeg + 1,
        `max ${maxFfmpeg} of ${expectedFfmpeg}`,
    );
}

function slopePerHour(points) {
    // Least-squares slope of value over time, in units per hour.
    const n = points.length;
    const mx = points.reduce((s, p) => s + p.x, 0) / n;
    const my = points.reduce((s, p) => s + p.y, 0) / n;
    const num = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
    const den = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    return den === 0 ? 0 : (num / den) * 3_600_000;
}

async function soak(ctx, minutes) {
    const { healthyIds, destPids, expectedFfmpeg } = ctx;
    const baseline = await baselineOf(healthyIds);
    const csvPath = path.join(WORK, 'soak.csv');
    fs.writeFileSync(
        csvPath,
        'elapsed_s,app_rss_mb,srs_rss_mb,dest_rss_mb,ffmpeg_count,ffmpeg_rss_mb,app_fds,healthy_restarted\n',
    );
    const t0 = Date.now();
    const samples = [];
    let worstHealthy = 0;
    let frozenNow = false;
    let nextToggle = t0 + 5 * 60_000;
    console.log(`soak for ${minutes} min; samples in ${csvPath}`);
    while (Date.now() - t0 < minutes * 60_000) {
        if (Date.now() >= nextToggle) {
            frozenNow = !frozenNow;
            process.kill(destPids[1], frozenNow ? 'SIGSTOP' : 'SIGCONT');
            console.log(`${frozenNow ? 'froze' : 'thawed'} the frozen destination`);
            nextToggle += 150_000;
        }
        const o = await outputsHealth();
        const s = sample(destPids);
        const bad = restartedHealthy(o, baseline);
        worstHealthy = Math.max(worstHealthy, bad);
        samples.push(s);
        fs.appendFileSync(
            csvPath,
            `${Math.round((s.t - t0) / 1000)},${s.appRssMb},${s.srsRssMb},${s.destRssMb},${s.ffmpegCount},${s.ffmpegRssMb},${s.appFds},${bad}\n`,
        );
        await sleep(30_000);
    }
    if (frozenNow) process.kill(destPids[1], 'SIGCONT');

    const warm = samples.filter((s) => s.t - t0 >= 10 * 60_000);
    check(
        'no healthy output restarted or stopped during the soak',
        worstHealthy === 0,
        `worst ${worstHealthy}`,
    );
    check(
        'FFmpeg process count stays bounded',
        Math.max(...samples.map((s) => s.ffmpegCount)) <= expectedFfmpeg + 1,
        `max ${Math.max(...samples.map((s) => s.ffmpegCount))} of ${expectedFfmpeg}`,
    );
    if (warm.length < 20) {
        console.log(
            'SKIP  growth checks need a soak of 20+ minutes (10 min warm-up, then 20 samples)',
        );
        return;
    }
    const growth = (key) => slopePerHour(warm.map((s) => ({ x: s.t, y: s[key] })));
    const app = growth('appRssMb');
    const srs = growth('srsRssMb');
    const fds = growth('appFds');
    check(
        'control-plane memory growth is under 50 MB/h after warm-up',
        app < 50,
        `${app.toFixed(1)} MB/h`,
    );
    check('SRS memory growth is under 50 MB/h after warm-up', srs < 50, `${srs.toFixed(1)} MB/h`);
    check(
        'control-plane file handles grow by under 20/h after warm-up',
        fds < 20,
        `${fds.toFixed(1)}/h`,
    );
}

// ── main ────────────────────────────────────────────────────────────────────

const scenario = process.argv[2];
const minutesIdx = process.argv.indexOf('--minutes');
const minutes = minutesIdx > 0 ? Number(process.argv[minutesIdx + 1]) : 60;
if (!['freeze', 'blackhole', 'soak'].includes(scenario) || !(minutes > 0)) {
    console.error('usage: node scripts/test-faults.mjs freeze|blackhole|soak [--minutes N]');
    process.exit(2);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        cleanup();
        process.exit(130);
    });
}

try {
    const ctx = await setup({
        frozen: scenario !== 'blackhole',
        blackhole: scenario !== 'freeze',
    });
    if (scenario === 'freeze') await freeze(ctx);
    else if (scenario === 'blackhole') await blackhole(ctx);
    else await soak(ctx, minutes);
} catch (err) {
    console.error(`scenario aborted: ${err instanceof Error ? err.message : err}`);
    results.push(false);
} finally {
    cleanup();
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
