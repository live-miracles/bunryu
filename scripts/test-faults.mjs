#!/usr/bin/env node
// Fault scenarios for the isolated test stack (scripts/test-stack.sh). Unlike the
// stack's default fake outputs, these push real FFmpeg copy outputs to real local
// destinations, so a destination can really freeze or swallow data:
//
//   freeze     50 healthy outputs + one whose destination is stopped (kill -STOP)
//   blackhole  50 healthy outputs + one whose destination accepts the TCP
//              connection and never reads or answers (the output's -rw_timeout
//              ends each attempt, and the retry back-off paces them)
//   soak       both faults for --minutes N (default 60), sampled every 30 s; fails
//              if memory, file handles or process count keep growing
//   refused    10 healthy outputs + two whose destination refuses connections: the
//              retry back-off, an operator stop after the streak, and recovery once
//              the destination is back
//   churn      10 healthy outputs while outputs are added, started, stopped and
//              deleted in quick succession: no orphan FFmpeg, no leaked handles
//   publisher-drop
//              10 healthy outputs while the input publisher disappears for 3 s and
//              for 25 s: a blip restarts nothing, a longer outage recovers by itself
//              (the destination drops its idle connection after about 5 s, so each
//              output reconnects once)
//   contention 50 healthy outputs while CPU burners saturate the host for
//              --burn-seconds N (default 90): the watchdogs must not fire on a
//              slow but healthy host
//
// Usage:  FAST_WATCHDOG=1 scripts/test-stack.sh start
//         node scripts/test-faults.mjs <scenario> [--minutes N] [--burn-seconds N]
//         scripts/test-stack.sh stop
//
// FAST_WATCHDOG=1 shortens the stall watchdog (20 s warm-up, 15 s stall) so the
// scenarios take minutes; leave it off for `contention`, which is only meaningful
// with the production windows. Needs ~1 GB free for 50 FFmpeg processes (less for
// the 10-output scenarios). Exits 1 if any check fails; each check is printed as
// PASS or FAIL.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
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
const DEST_REFUSED = 4;
const PORT_BASE = 31950;
const HEALTHY_OUTPUTS = 50;
const SMALL_HEALTHY_OUTPUTS = 10;
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

function diagnosticsEvents(event, outputId, sinceMs = 0) {
    const dir = path.join(WORK, 'diagnostics');
    if (!fs.existsSync(dir)) return [];
    const events = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
        for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
            if (!line.includes(event)) continue;
            try {
                const e = JSON.parse(line);
                if (e.event !== event || (outputId && e.outputId !== outputId)) continue;
                if (Date.parse(e.ts) >= sinceMs) events.push(e);
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

// A destination that refuses connections: the shim pushes to this port, where
// nothing listens, until startDestSrs(DEST_REFUSED) opens it.
function startRefusedDest() {
    fs.writeFileSync(path.join(WORK, `dest-${DEST_REFUSED}.port`), String(destPort(DEST_REFUSED)));
}

function cleanup() {
    for (const fn of cleanups.splice(0)) fn();
    for (const n of [DEST_HEALTHY, DEST_FROZEN, DEST_BLACKHOLE, DEST_REFUSED]) {
        fs.rmSync(path.join(WORK, `dest-${n}.port`), { force: true });
    }
}

// ── setup ───────────────────────────────────────────────────────────────────

async function setup({
    frozen = false,
    blackhole = false,
    refused = false,
    healthy = HEALTHY_OUTPUTS,
}) {
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
    for (let i = 1; i <= healthy; i++) {
        outputs.push({
            name: `h${String(i).padStart(2, '0')}`,
            url: `rtmp://192.0.2.${DEST_HEALTHY}/live/h${i}`,
        });
    }
    if (frozen) outputs.push({ name: 'frozen', url: `rtmp://192.0.2.${DEST_FROZEN}/live/frozen` });
    if (blackhole) {
        outputs.push({ name: 'blackhole', url: `rtmp://192.0.2.${DEST_BLACKHOLE}/live/blackhole` });
    }
    if (refused) {
        startRefusedDest();
        for (const name of ['refA', 'refB']) {
            outputs.push({ name, url: `rtmp://192.0.2.${DEST_REFUSED}/live/${name}` });
        }
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
    check(`${healthy} healthy outputs reach running with data flowing`, !!ready);
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
    const { ids, healthyIds, destPids, expectedFfmpeg, since } = ctx;
    const baseline = await baselineOf(healthyIds);
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
    // The output's own -rw_timeout ends a destination that never answers, well before
    // the stall watchdog's warm-up, so each attempt is an exit followed by a retry.
    const exits = diagnosticsEvents('ffmpeg-exited', ids.blackhole, since);
    const starts = diagnosticsEvents('ffmpeg-started', ids.blackhole, since);
    const startGapsSec = starts
        .slice(1)
        .map((e, i) => (Date.parse(e.ts) - Date.parse(starts[i].ts)) / 1000);
    check('no data ever flows to the black-holed destination', !everFlowing);
    check(
        'the output gives up on it by itself with "Connection timed out", each time',
        exits.length >= 3 && exits.every((e) => /timed out/i.test(e.stderrTail ?? '')),
        `${exits.length} exits`,
    );
    check(
        'the stall watchdog is not what ends it',
        diagnosticsEvents('ffmpeg-restart', ids.blackhole, since).length === 0,
    );
    // An attempt lasts about the 10 s timeout, so a shorter gap would be a spinning loop.
    check(
        'attempts are spaced out, never a tight loop',
        startGapsSec.length >= 2 && startGapsSec.every((g) => g >= 10),
        `gaps ${startGapsSec.map((g) => Math.round(g)).join(', ')} s`,
    );
    check('no healthy output restarted or stopped', worstHealthy === 0, `worst ${worstHealthy}`);
    check(
        'FFmpeg process count stays bounded',
        maxFfmpeg <= expectedFfmpeg + 1,
        `max ${maxFfmpeg} of ${expectedFfmpeg}`,
    );
}

// Retry delays of src/services/outputs.ts (RETRY_DELAYS_MS, RETRY_JITTER): the wait
// after the n-th failure in a row is the step's delay, shortened by up to 25 %.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

async function refused(ctx) {
    const { ids, healthyIds, expectedFfmpeg, since } = ctx;
    const baseline = await baselineOf(healthyIds);
    let maxFfmpeg = 0;
    let worstHealthy = 0;
    console.log('waiting for the refused outputs to fail six times in a row');
    const failing = await waitFor(
        'refused outputs failing',
        async () => {
            const o = await outputsHealth();
            maxFfmpeg = Math.max(maxFfmpeg, sample([]).ffmpegCount);
            worstHealthy = Math.max(worstHealthy, restartedHealthy(o, baseline));
            return o[ids.refA]?.failures >= 6 && o[ids.refB]?.failures >= 6;
        },
        150_000,
        2000,
    );
    check('a refused destination makes the output fail again and again', !!failing);

    const retries = diagnosticsEvents('ffmpeg-retry-scheduled', ids.refA, since);
    const inBounds = retries.every((e) => {
        const step = RETRY_DELAYS_MS[Math.min(e.attempt - 1, RETRY_DELAYS_MS.length - 1)];
        return e.delayMs >= step * 0.75 - 1 && e.delayMs <= step;
    });
    check(
        'retry waits follow the 1, 2, 4, 8, 16 s back-off, at most a quarter shorter',
        retries.length >= 5 && inBounds,
        retries.map((e) => `${e.attempt}:${e.delayMs}`).join(' '),
    );
    const starts = diagnosticsEvents('ffmpeg-started', ids.refA, since);
    const gapsMs = starts.slice(1).map((e, i) => Date.parse(e.ts) - Date.parse(starts[i].ts));
    check(
        'attempts are spaced out, never a tight loop',
        gapsMs.length >= 5 && gapsMs.every((g) => g >= 700),
        `gaps ${gapsMs.join(', ')} ms`,
    );

    console.log('stopping refB by hand after its streak of failures');
    await api('POST', `/api/pipelines/${PIPELINE}/outputs/${ids.refB}/stop`);
    const stopped = await waitFor(
        'stop recorded',
        async () => diagnosticsEvents('output-stopped-after-failures', ids.refB, since).length > 0,
        15_000,
        1000,
    );
    check(
        'a stop after a streak of failures is recorded as "Stopped after N failed attempts"',
        !!stopped,
    );
    const history = JSON.stringify(
        await api('GET', `/api/pipelines/${PIPELINE}/outputs/${ids.refB}/errors`),
    );
    check('the Error History says so', history.includes('Stopped after'));

    console.log('the destination comes back');
    startDestSrs(DEST_REFUSED);
    const recovered = await waitFor(
        'refA recovers',
        async () => {
            const o = await outputsHealth();
            worstHealthy = Math.max(worstHealthy, restartedHealthy(o, baseline));
            return o[ids.refA]?.status === 'running' && o[ids.refA].bitrateKbps > 0;
        },
        60_000,
        2000,
    );
    check('the retrying output recovers by itself once the destination is back', !!recovered);
    await sleep(20_000);
    const o = await outputsHealth();
    check(
        'the output stopped by hand stays stopped',
        o[ids.refB]?.status !== 'running',
        o[ids.refB]?.status,
    );
    check('no healthy output restarted or stopped', worstHealthy === 0, `worst ${worstHealthy}`);
    check(
        'FFmpeg process count stays bounded and settles at one per running output',
        maxFfmpeg <= expectedFfmpeg + 1 && sample([]).ffmpegCount === healthyIds.length + 1,
        `max ${maxFfmpeg}, now ${sample([]).ffmpegCount}`,
    );
}

async function churn(ctx) {
    const { healthyIds } = ctx;
    const baseline = await baselineOf(healthyIds);
    const before = sample([]);
    let maxFfmpeg = 0;
    let worstHealthy = 0;
    const apiErrors = [];
    const outputsPath = `/api/pipelines/${PIPELINE}/outputs`;
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (err) {
            apiErrors.push(`${what}: ${err.message}`);
        }
    };
    // Three outputs per round, each ended differently: deleted while still being
    // started, deleted while running, and stopped and then deleted.
    const one = async (name, mode) => {
        let out;
        await step(`create ${name}`, async () => {
            out = await api('POST', outputsPath, {
                name,
                url: `rtmp://192.0.2.${DEST_HEALTHY}/live/${name}`,
            });
        });
        if (!out) return;
        await step(`start ${name}`, () => api('POST', `${outputsPath}/${out.id}/start`));
        await sleep(mode === 0 ? 200 : 2500);
        if (mode === 2)
            await step(`stop ${name}`, () => api('POST', `${outputsPath}/${out.id}/stop`));
        await step(`delete ${name}`, () => api('DELETE', `${outputsPath}/${out.id}`));
    };
    const rounds = 15;
    console.log(`${rounds * 3} outputs added, started and removed, three at a time`);
    for (let i = 0; i < rounds; i++) {
        await Promise.all([0, 1, 2].map((mode) => one(`c${i}m${mode}`, mode)));
        const o = await outputsHealth();
        maxFfmpeg = Math.max(maxFfmpeg, sample([]).ffmpegCount);
        worstHealthy = Math.max(worstHealthy, restartedHealthy(o, baseline));
    }
    const settled = await waitFor(
        'FFmpeg count settles',
        async () => sample([]).ffmpegCount === healthyIds.length,
        30_000,
        1000,
    );
    const after = sample([]);
    // /api/health is a shared 5 s poll, so removed outputs may linger for one cycle.
    let left = -1;
    await waitFor(
        'removed outputs leave the health list',
        async () => (left = Object.keys(await outputsHealth()).length) === healthyIds.length,
        15_000,
        1000,
    );
    check(
        'every add, start, stop and delete call succeeded',
        apiErrors.length === 0,
        apiErrors.slice(0, 3).join('; '),
    );
    check('no healthy output restarted or stopped', worstHealthy === 0, `worst ${worstHealthy}`);
    check(
        'no FFmpeg is left behind by removed outputs',
        !!settled,
        `${after.ffmpegCount} running, ${healthyIds.length} outputs should run`,
    );
    check(
        'removed outputs leave the health list within one poll',
        left === healthyIds.length,
        `${left} listed`,
    );
    check(
        'FFmpeg process count stays bounded',
        maxFfmpeg <= healthyIds.length + 6,
        `max ${maxFfmpeg} with at most 3 churned at a time`,
    );
    check(
        'control-plane file handles return to their starting level',
        after.appFds - before.appFds <= 10,
        `${before.appFds} -> ${after.appFds}`,
    );
    check(
        'control-plane memory grows by under 40 MB',
        after.appRssMb - before.appRssMb < 40,
        `${before.appRssMb} -> ${after.appRssMb} MB`,
    );
}

// The publisher the stack starts (scripts/test-stack.sh): same stream, same encode.
function publisherArgs() {
    const key = JSON.parse(fs.readFileSync(path.join(WORK, 'pipe.json'), 'utf8')).streamKey;
    return [
        ...['-re', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25'],
        ...['-f', 'lavfi', '-i', 'sine=frequency=440', '-c:v', 'libx264', '-preset', 'ultrafast'],
        ...['-tune', 'zerolatency', '-b:v', '800k', '-g', '50', '-c:a', 'aac', '-b:a', '64k'],
        ...['-f', 'flv', `rtmp://127.0.0.1:31935/live/${key}`],
    ];
}

function startPublisher() {
    const log = fs.openSync(path.join(WORK, 'pub.log'), 'a');
    const child = spawn(path.join(REPO, 'objs/ffmpeg'), publisherArgs(), {
        stdio: ['ignore', log, log],
        detached: true,
    });
    child.unref();
    fs.writeFileSync(path.join(WORK, 'pub.pid'), String(child.pid));
    return child.pid;
}

function stopPublisher(signal) {
    const pid = Number(fs.readFileSync(path.join(WORK, 'pub.pid'), 'utf8'));
    process.kill(pid, signal);
}

async function publisherDrop(ctx) {
    const { healthyIds } = ctx;
    // The harness must leave the stack's publisher running whatever happens.
    cleanups.push(() => {
        try {
            if (!listenerPid(31935) || !isPublisherAlive()) startPublisher();
        } catch {
            /* best effort */
        }
    });
    const notFlowing = async () => {
        const o = await outputsHealth();
        return healthyIds.filter((id) => !(o[id]?.status === 'running' && o[id].bitrateKbps > 0));
    };
    const inputLive = async () => (await api('GET', '/api/health')).pipelines[PIPELINE]?.input.live;

    for (const { seconds, signal, strict } of [
        { seconds: 3, signal: 'SIGTERM', strict: true },
        { seconds: 25, signal: 'SIGKILL', strict: false },
    ]) {
        const baseline = await baselineOf(healthyIds);
        const since = Date.now();
        console.log(`the publisher goes away for ${seconds} s (${signal})`);
        stopPublisher(signal);
        await sleep(seconds * 1000);
        startPublisher();
        await waitFor('input live again', inputLive, 60_000, 1000);
        await sleep(10_000);
        const back = await waitFor(
            'outputs flowing again',
            async () => (await notFlowing()).length === 0,
            90_000,
            2000,
        );
        const o = await outputsHealth();
        const restarted = restartedHealthy(o, baseline);
        const starts = diagnosticsEvents('ffmpeg-started', undefined, since).length;
        check(
            `all outputs carry data again after a ${seconds} s publisher outage`,
            !!back,
            back ? '' : `not flowing: ${(await notFlowing()).join(', ')}`,
        );
        if (strict) {
            check(
                'a 3 s blip restarts no output',
                restarted === 0 && starts === 0,
                `${restarted} restarted, ${starts} FFmpeg starts`,
            );
        } else {
            // Not asserted either way: the destination SRS drops a publisher that sends
            // nothing for about 5 s, so outputs reconnect once when the input returns
            // (a platform ingest does the same). What matters is that recovery is
            // automatic and bounded, with no restart storm.
            console.log(
                `INFO  ${restarted} of ${healthyIds.length} outputs restarted, ${starts} FFmpeg starts`,
            );
            check(
                'recovery does not start more than a few FFmpeg per output',
                starts <= healthyIds.length * 3,
                `${starts} starts`,
            );
        }
        const count = sample([]).ffmpegCount;
        check('FFmpeg count returns to one per output', count === healthyIds.length, `${count}`);
    }
}

function isPublisherAlive() {
    try {
        process.kill(Number(fs.readFileSync(path.join(WORK, 'pub.pid'), 'utf8')), 0);
        return true;
    } catch {
        return false;
    }
}

async function contention(ctx, burnSeconds) {
    const { healthyIds, expectedFfmpeg } = ctx;
    let stallMs = '?';
    try {
        stallMs = JSON.parse(fs.readFileSync(path.join(WORK, 'bunryu.json'), 'utf8'))
            .output_watchdog.stall_ms;
    } catch {
        /* the watchdog setting is only printed */
    }
    console.log(`stall window ${stallMs} ms; ${os.cpus().length} CPU burners for ${burnSeconds} s`);
    const baseline = await baselineOf(healthyIds);
    const since = Date.now();
    const burners = [];
    for (let i = 0; i < os.cpus().length; i++) {
        burners.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
    }
    cleanups.push(() => burners.forEach((b) => b.kill('SIGKILL')));

    let worstHealthy = 0;
    let maxFfmpeg = 0;
    let slowestApiMs = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < burnSeconds * 1000) {
        const started = Date.now();
        let o;
        try {
            o = await outputsHealth();
        } catch (err) {
            console.log(`INFO  health call failed under load: ${err.message}`);
            slowestApiMs = 15_000;
            continue;
        }
        slowestApiMs = Math.max(slowestApiMs, Date.now() - started);
        maxFfmpeg = Math.max(maxFfmpeg, sample([]).ffmpegCount);
        worstHealthy = Math.max(worstHealthy, restartedHealthy(o, baseline));
        await sleep(2000);
    }
    const load = os.loadavg()[0];
    burners.forEach((b) => b.kill('SIGKILL'));
    await sleep(5000);

    const restarts = diagnosticsEvents('ffmpeg-restart', undefined, since);
    check(
        'no output is restarted by a watchdog while the host is saturated',
        restarts.length === 0,
        restarts
            .map((e) => `${e.outputId}:${e.reason}`)
            .slice(0, 3)
            .join('; '),
    );
    check('no healthy output restarted or stopped', worstHealthy === 0, `worst ${worstHealthy}`);
    check(
        'the API keeps answering under load',
        slowestApiMs < 5000,
        `slowest ${slowestApiMs} ms, load average ${load.toFixed(1)} on ${os.cpus().length} CPUs`,
    );
    check(
        'FFmpeg process count stays at one per output',
        maxFfmpeg <= expectedFfmpeg && sample([]).ffmpegCount === expectedFfmpeg,
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
const numberArg = (name, fallback) => {
    const idx = process.argv.indexOf(name);
    return idx > 0 ? Number(process.argv[idx + 1]) : fallback;
};
const minutes = numberArg('--minutes', 60);
const burnSeconds = numberArg('--burn-seconds', 90);
const SCENARIOS = [
    'freeze',
    'blackhole',
    'soak',
    'refused',
    'churn',
    'publisher-drop',
    'contention',
];
if (!SCENARIOS.includes(scenario) || !(minutes > 0) || !(burnSeconds > 0)) {
    console.error(
        `usage: node scripts/test-faults.mjs ${SCENARIOS.join('|')} [--minutes N] [--burn-seconds N]`,
    );
    process.exit(2);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        cleanup();
        process.exit(130);
    });
}

const scenarioStartedAt = Date.now();
try {
    const ctx = await setup({
        frozen: ['freeze', 'soak'].includes(scenario),
        blackhole: ['blackhole', 'soak'].includes(scenario),
        refused: scenario === 'refused',
        healthy: ['refused', 'churn', 'publisher-drop'].includes(scenario)
            ? SMALL_HEALTHY_OUTPUTS
            : HEALTHY_OUTPUTS,
    });
    ctx.since = scenarioStartedAt;
    if (scenario === 'freeze') await freeze(ctx);
    else if (scenario === 'blackhole') await blackhole(ctx);
    else if (scenario === 'soak') await soak(ctx, minutes);
    else if (scenario === 'refused') await refused(ctx);
    else if (scenario === 'churn') await churn(ctx);
    else if (scenario === 'publisher-drop') await publisherDrop(ctx);
    else await contention(ctx, burnSeconds);
} catch (err) {
    console.error(`scenario aborted: ${err instanceof Error ? err.message : err}`);
    results.push(false);
} finally {
    cleanup();
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
