/* eslint-disable @typescript-eslint/no-explicit-any -- the payloads edited here are the dashboard's untyped JSON */
// Scenario proxy: forwards everything to the isolated test stack (18080) and rewrites
// /api/health, /api/config, /api/metrics/system, /api/events and /api/rejected-publishes
// according to the scenario named in $SCEN_FILE. Verdicts are recomputed with the real
// server rules (src/utils/healthVerdicts.ts), so the dashboard draws what the server would send.
import http from 'node:http';
import fs from 'node:fs';
import { buildHealthVerdicts } from '../../src/utils/healthVerdicts.ts';
import { scenarios, type Ctx } from './scenarios.mts';

const UPSTREAM = 18080;
const LISTEN = Number(process.env.PROXY_PORT ?? 18090);
const WORK = process.env.WORK ?? '/tmp/bunryu-ui';
const SCEN_FILE = process.env.SCEN_FILE ?? `${WORK}/scenario.txt`;

function fetchUpstream(
    req: { url?: string; method?: string; headers: http.IncomingHttpHeaders },
    body: Buffer,
): Promise<{ res: http.IncomingMessage; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const headers = {
            ...req.headers,
            host: `127.0.0.1:${UPSTREAM}`,
            'accept-encoding': 'identity',
        };
        delete headers['if-none-match'];
        delete headers['if-modified-since'];
        const up = http.request(
            { host: '127.0.0.1', port: UPSTREAM, path: req.url, method: req.method, headers },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
            },
        );
        up.on('error', reject);
        up.end(body);
    });
}

function currentScenario(): string {
    try {
        return fs.readFileSync(SCEN_FILE, 'utf8').trim() || 'baseline';
    } catch {
        return 'baseline';
    }
}

// What a healthy dashboard looks like: nothing from the developer's own machine leaks in.
function neutralise(ctx: Ctx): void {
    const h = ctx.health;
    h.hostAlerts = [];
    h.srtRelay = {
        status: 'running',
        pid: 4242,
        startedAtMs: Date.now() - 3_600_000,
        lastError: null,
        port: 10081,
    };
    // The stack's default outputs all push to one URL, which is advice ("Same destination as ...")
    // on every output; give each its own so a shot shows only what its scenario provokes.
    ctx.config.outputs.forEach((o: any, i: number) => {
        if (typeof o.url === 'string' && o.url.startsWith('rtmp://192.0.2.10/')) {
            o.url = `rtmp://192.0.2.${10 + i}/live/test`;
        }
    });
    // The stack's fake output FFmpeg reports 4000 kb/s whatever the input is, while its test stream
    // runs at about 0.9 Mb/s: every copy output would get the yellow "bitrate: input is ..." badge.
    // Give each live input the outputs' rate, as a real copy output would send.
    for (const p of Object.values<any>(h.pipelines)) {
        if (p.input?.live && p.input.recvBitrateKbps) p.input.recvBitrateKbps = 4000;
    }
    ctx.config.publicHost = 'live.example.test';
    ctx.config.srtPassphrasePending = false;
    ctx.metrics.cpu.percent = 24;
    ctx.metrics.ram.usedBytes = Math.round(ctx.metrics.ram.totalBytes * 0.42);
    if (ctx.metrics.disk)
        ctx.metrics.disk.usedBytes = Math.round(ctx.metrics.disk.totalBytes * 0.38);
}

http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const path = (req.url ?? '').split('?')[0];
    const scen = scenarios[currentScenario()] ?? scenarios.baseline;
    try {
        if (scen.down && path.startsWith('/api/') && !path.startsWith('/api/auth')) {
            req.socket.destroy();
            return;
        }
        const up = await fetchUpstream(req, body);
        const status = up.res.statusCode ?? 200;
        const headers = { ...up.res.headers } as Record<string, string | string[] | undefined>;
        const rewrite = [
            '/api/health',
            '/api/config',
            '/api/metrics/system',
            '/api/events',
            '/api/rejected-publishes',
        ].includes(path);
        if (!rewrite || status !== 200) {
            res.writeHead(status, headers);
            res.end(up.body);
            return;
        }
        const json = JSON.parse(up.body.toString('utf8'));
        // Always fetch the partner payloads so every scenario sees one consistent picture.
        const get = async (p: string) => {
            if (p === path) return json;
            const r = await fetchUpstream(
                { url: p, method: 'GET', headers: req.headers },
                Buffer.alloc(0),
            );
            return JSON.parse(r.body.toString('utf8'));
        };
        const ctx: Ctx = {
            health: await get('/api/health'),
            config: await get('/api/config'),
            metrics: await get('/api/metrics/system'),
            events: await get('/api/events'),
            rejected: { rejected: [], omitted: 0 },
        };
        neutralise(ctx);
        scen.apply?.(ctx);
        // Verdicts from the real rules.
        const healthByPipeline: Record<string, unknown> = {};
        for (const [id, p] of Object.entries<any>(ctx.health.pipelines)) {
            healthByPipeline[id] = { input: p.input, outputs: p.outputs, alerts: p.alerts };
        }
        ctx.health.verdicts = buildHealthVerdicts({
            pipelines: ctx.config.pipelines,
            outputs: ctx.config.outputs,
            health: healthByPipeline as never,
        });
        const out =
            path === '/api/health'
                ? ctx.health
                : path === '/api/config'
                  ? ctx.config
                  : path === '/api/metrics/system'
                    ? ctx.metrics
                    : path === '/api/events'
                      ? ctx.events
                      : ctx.rejected;
        const text = JSON.stringify(out);
        delete headers['content-length'];
        delete headers['etag'];
        headers['content-type'] = 'application/json; charset=utf-8';
        headers['content-length'] = String(Buffer.byteLength(text));
        res.writeHead(200, headers);
        res.end(text);
    } catch (err) {
        console.error('proxy error', path, err);
        res.writeHead(502).end(String(err));
    }
}).listen(LISTEN, '127.0.0.1', () => console.log(`proxy on ${LISTEN}`));
