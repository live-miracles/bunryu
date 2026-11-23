/* eslint-disable @typescript-eslint/no-explicit-any -- the payloads edited here are the dashboard's untyped JSON */
// node --experimental-strip-types would also work; run with tsx. Drives headless Chrome (CDP 9333)
// against the scenario proxy and writes one clipped PNG per shot plus a manifest with the text seen.
import fs from 'node:fs';
import { catalog, type Entry, type Shot } from './scenarios.mts';

// Where the manifest and the shots go (REVIEW_DIR) and where the proxy reads the scenario name (WORK).
const S = process.env.REVIEW_DIR ?? '/tmp/bunryu-message-review';
const WORK = process.env.WORK ?? '/tmp/bunryu-ui';
const APP = `http://127.0.0.1:${process.env.APP_PORT ?? 18090}`;
const SCEN_FILE = `${WORK}/scenario.txt`;
const OUT = `${S}/shots`;
const only = process.argv.slice(2);

const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = targets.find((t: any) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (d: any) => void>();
ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) pending.get(d.id)!(d);
};
const send = (method: string, params: any = {}): Promise<any> =>
    new Promise((res, rej) => {
        const i = ++id;
        const t = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), 20000);
        pending.set(i, (d) => {
            clearTimeout(t);
            res(d);
        });
        ws.send(JSON.stringify({ id: i, method, params }));
    });
const ev = async (expression: string): Promise<any> =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
        ?.result?.value;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setScenario = (name: string) => fs.writeFileSync(SCEN_FILE, name);

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
    width: 1500,
    height: 2200,
    deviceScaleFactor: 1,
    mobile: false,
});
setScenario('baseline');
await send('Page.navigate', { url: `${APP}/login.html` });
await sleep(1200);
await ev(
    `fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'admin'})}).then(r=>r.status)`,
);

type Rect = { x: number; y: number; w: number; h: number };
const PAD = 10;

async function clip(name: string, r: Rect): Promise<string> {
    const x = Math.max(0, Math.floor(r.x - PAD));
    const y = Math.max(0, Math.floor(r.y - PAD));
    const w = Math.min(1500 - x, Math.ceil(r.w + 2 * PAD));
    const h = Math.min(2200 - y, Math.ceil(r.h + 2 * PAD));
    const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x, y, width: w, height: h, scale: 1 },
    });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot.result.data, 'base64'));
    return `${name}.png`;
}

const RECT_FN = `(els)=>{const rs=els.filter(Boolean).map(e=>e.getBoundingClientRect());if(!rs.length)return null;const x=Math.min(...rs.map(r=>r.left)),y=Math.min(...rs.map(r=>r.top)),x2=Math.max(...rs.map(r=>r.right)),y2=Math.max(...rs.map(r=>r.bottom));return {x,y,w:x2-x,h:y2-y};}`;
const rectOf = (exprs: string): Promise<Rect | null> => ev(`(${RECT_FN})([${exprs}])`);

async function hover(selectorExpr: string): Promise<void> {
    const c = await ev(
        `(()=>{const e=${selectorExpr};if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
    );
    if (!c) return;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    await sleep(700);
}

const sectionExpr = (title: string) =>
    `(()=>{const h=[...document.querySelectorAll('#overview-col h2')].find(h=>h.textContent.trim().startsWith(${JSON.stringify(title)}));if(!h)return null;let top=h;if(h.parentElement&&h.parentElement.id!=='overview-col'&&h.parentElement.querySelector('input'))top=h.parentElement;return {top,body:top.nextElementSibling};})()`;

async function takeShot(
    e: Entry,
    shot: Shot,
    n: number,
): Promise<{ file: string; text: string } | null> {
    const name = `${e.id}-${n}`;
    switch (shot.kind) {
        case 'banner': {
            const r = await ev(
                `(()=>{let b=56;for(const id of ['connection-banner','srs-banner','srt-relay-banner','public-host-banner','srt-passphrase-banner','host-alert-banners']){const el=document.getElementById(id);if(el&&el.offsetParent!==null){b=Math.max(b,el.getBoundingClientRect().bottom)}}return {x:0,y:0,w:1500,h:b}})()`,
            );
            const text = await ev(
                `[...document.querySelectorAll('.banner')].filter(e=>e.offsetParent!==null).map(e=>e.innerText.replace(/\\s+/g,' ').trim()).join(' | ')`,
            );
            return {
                file: await clip(name, { ...r, x: PAD, y: PAD, w: r.w - 2 * PAD, h: r.h - PAD }),
                text,
            };
        }
        case 'topbar': {
            return {
                file: await clip(name, { x: 700, y: 10, w: 780, h: 40 }),
                text: await ev(
                    `document.querySelector('header, nav, body > div')?.innerText.replace(/\\s+/g,' ').slice(0,200)`,
                ),
            };
        }
        case 'ov-inputs':
        case 'ov-outputs':
        case 'ov-relay':
        case 'ov-shared': {
            const title = {
                'ov-inputs': 'Inputs',
                'ov-outputs': 'Outputs',
                'ov-relay': 'SRT Relay',
                'ov-shared': 'Shared encodes',
            }[shot.kind];
            const sec = `(${sectionExpr(title)})`;
            const r = await rectOf(`${sec}?.top,${sec}?.body`);
            if (!r) return null;
            const text = await ev(
                `(()=>{const s=${sec};return [...s.body.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\s+/g,' ').trim()).join(' || ')).join('\\n')})()`,
            );
            return { file: await clip(name, r), text };
        }
        case 'status-dot': {
            const card = `document.querySelector('#status-cards a[data-pipeline-id]')`;
            const dots = `${card}.querySelectorAll('.js-tooltip')`;
            const idx = shot.dot === 'input' ? 0 : shot.dot + 1;
            await hover(`${dots}[${idx}]`);
            const r = await rectOf(`${card},document.getElementById('hover-tooltip')`);
            const text = await ev(
                `document.getElementById('hover-tooltip')?.innerText.replace(/\\s+/g,' ').trim()`,
            );
            if (!r) return null;
            return { file: await clip(name, r), text };
        }
        case 'status-card': {
            const r = await rectOf(`document.querySelector('#status-cards a[data-pipeline-id]')`);
            if (!r) return null;
            const text = await ev(
                `document.querySelector('#status-cards a[data-pipeline-id]').innerText.replace(/\\s+/g,' ').trim()`,
            );
            // The head (counts) above the card gives the reader the totals.
            const head = await rectOf(`document.getElementById('status-head')`);
            return {
                file: await clip(
                    name,
                    head
                        ? { x: head.x, y: head.y, w: Math.max(head.w, r.w), h: r.y + r.h - head.y }
                        : r,
                ),
                text,
            };
        }
        case 'status-top': {
            const head = await rectOf(`document.getElementById('status-head')`);
            const cards = await rectOf(`document.getElementById('status-cards')`);
            if (!head || !cards) return null;
            return {
                file: await clip(name, {
                    x: head.x,
                    y: head.y,
                    w: cards.w,
                    h: Math.min(cards.y + cards.h, head.y + 330) - head.y,
                }),
                text: await ev(
                    `document.getElementById('status-cards').innerText.replace(/\\s+/g,' ').trim().slice(0,400)`,
                ),
            };
        }
        case 'sidebar-dot': {
            await hover(`document.querySelector('#pipelines .js-tooltip')`);
            const r = await rectOf(
                `document.querySelector('#pipelines li'),document.getElementById('hover-tooltip')`,
            );
            return r
                ? {
                      file: await clip(name, r),
                      text: await ev(
                          `document.getElementById('hover-tooltip')?.innerText.replace(/\\s+/g,' ').trim()`,
                      ),
                  }
                : null;
        }
        case 'pipeline-input': {
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
            await sleep(400);
            // The input's stats, and the SRT legs under them when the input is bonded.
            const stats = `document.getElementById('input-stats-container')`;
            const legs = `(document.getElementById('srt-bonding-stats')?.offsetHeight ? document.getElementById('srt-bonding-stats') : null)`;
            const r = await rectOf(`${stats},${legs}`);
            if (!r || r.w < 2 || r.h < 2) return null;
            return {
                file: await clip(name, r),
                text: await ev(`${stats}.innerText.replace(/\\s+/g,' ').trim()`),
            };
        }
        case 'relay-card-dot': {
            // The SRT Relay card's status circle in the second column, with its hover text.
            await hover(`document.getElementById('srt-bonding-status-dot')`);
            const r = await rectOf(
                `document.getElementById('srt-bonding-card'),document.getElementById('hover-tooltip')`,
            );
            if (!r || r.w < 2 || r.h < 2) return null;
            return {
                file: await clip(name, r),
                text: await ev(
                    `document.getElementById('hover-tooltip')?.innerText.replace(/\\s+/g,' ').trim()`,
                ),
            };
        }
        case 'out-card': {
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
            await sleep(400);
            const sel = `document.querySelectorAll('#outputs-list [data-output-card]')[${shot.out ?? 0}]`;
            const r = await rectOf(sel);
            if (!r) return null;
            return {
                file: await clip(name, r),
                text: await ev(`${sel}.innerText.replace(/\\s+/g,' ').trim()`),
            };
        }
        case 'out-hint': {
            const card = `document.querySelectorAll('#outputs-list [data-output-card]')[${shot.out}]`;
            await hover(`${card}?.querySelector('[aria-label^="Hint"]')`);
            const r = await rectOf(`${card},document.getElementById('hover-tooltip')`);
            if (!r) return null;
            return {
                file: await clip(name, r),
                text: await ev(
                    `document.getElementById('hover-tooltip')?.innerText.replace(/\\s+/g,' ').trim()`,
                ),
            };
        }
        case 'status-problems': {
            const r = await rectOf(`document.getElementById('status-events').parentElement`);
            return r
                ? {
                      file: await clip(name, r),
                      text: await ev(
                          `document.getElementById('status-events').innerText.replace(/\\s+/g,' ').trim()`,
                      ),
                  }
                : null;
        }
        case 'sidebar-rejected': {
            const r = await rectOf(`document.getElementById('rejected-publishes')`);
            return r
                ? {
                      file: await clip(name, r),
                      text: await ev(
                          `document.getElementById('rejected-publishes').innerText.replace(/\\s+/g,' ').trim()`,
                      ),
                  }
                : null;
        }
    }
}

fs.mkdirSync(OUT, { recursive: true });
const manifestPath = `${S}/manifest.json`;
const manifest: Record<string, { file: string; text: string; kind: string }[]> = fs.existsSync(
    manifestPath,
)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {};

for (const e of catalog) {
    if (only.length && !only.includes(e.id)) continue;
    if (!only.length && manifest[e.id] && !process.env.REDO) continue;
    try {
        await captureEntry(e);
    } catch (err) {
        console.log(`  !! ${e.id} failed:`, String(err));
    }
}
setScenario('baseline');
ws.close();

async function captureEntry(e: Entry): Promise<void> {
    const results: { file: string; text: string; kind: string }[] = [];
    // Shots of one entry may need two different pages (overview + status).
    const groups = new Map<string, Shot[]>();
    for (const shot of e.shots) {
        const url = shot.kind.startsWith('ov-')
            ? `${APP}/`
            : shot.kind.startsWith('status')
              ? `${APP}/?view=status`
              : e.pipelineView ||
                  shot.kind === 'pipeline-input' ||
                  shot.kind === 'relay-card-dot' ||
                  shot.kind === 'out-card' ||
                  shot.kind === 'out-hint' ||
                  (shot.kind === 'sidebar-dot' &&
                      e.shots.some((s) => s.kind === 'pipeline-input' || s.kind === 'out-card'))
                ? `${APP}/?p=1`
                : `${APP}/`;
        groups.set(url, [...(groups.get(url) ?? []), shot]);
    }
    let n = 0;
    for (const [url, shots] of groups) {
        if (e.post) {
            setScenario('baseline');
            await send('Page.navigate', { url });
            await sleep(3000);
            setScenario(e.id);
            await sleep(7500);
        } else {
            setScenario(e.id);
            await send('Page.navigate', { url });
            await sleep(3200);
        }
        for (const shot of shots) {
            n += 1;
            try {
                const r = await takeShot(e, shot, n);
                if (r)
                    results.push({ ...r, kind: shot.kind + ('dot' in shot ? `:${shot.dot}` : '') });
                else console.log(`  !! ${e.id} ${shot.kind}: nothing to capture`);
            } catch (err) {
                console.log(`  !! ${e.id} ${shot.kind}:`, String(err));
            }
        }
    }
    manifest[e.id] = results;
    console.log(e.id, results.map((r) => r.file).join(' '));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
}
