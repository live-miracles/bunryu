// Tiny Chrome DevTools driver (no playwright/chromium-cli needed; Node 22 global WebSocket).
// node scripts/test-stack-cdp.mjs <out.png> [js-to-eval-before-shot] [waitMs]   env: MOVE=x,y to hover before the shot, VIEWPORT=WxH to resize, SCALE=2 for a sharper (README) shot
import fs from 'node:fs';
const [out, pre = '', waitMs = '3000'] = process.argv.slice(2);
const APP = `http://127.0.0.1:${process.env.APP_PORT ?? 18080}`;
const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9333}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d);
};
const send = (method, params = {}) =>
    new Promise((res) => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
const evalJs = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
        ?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.enable');
// VIEWPORT=WxH (e.g. 390x844) emulates a phone-sized screen.
const [vw, vh] = (process.env.VIEWPORT ?? '1500x1000').split('x').map(Number);
await send('Emulation.setDeviceMetricsOverride', {
    width: vw,
    height: vh,
    deviceScaleFactor: Number(process.env.SCALE ?? 1),
    mobile: vw < 1024,
});
const href = await evalJs('location.href');
if (!href.startsWith(APP) || href.includes('login')) {
    // test-stack.sh seeds the fresh DB with dashboard_password "admin".
    await send('Page.navigate', { url: `${APP}/login.html` });
    await sleep(1500);
    await evalJs(
        `fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'admin'})}).then(r=>r.status)`,
    );
    await send('Page.navigate', { url: `${APP}/` });
}
await sleep(Number(waitMs));
if (pre) {
    const v = await evalJs(pre);
    if (v !== undefined) console.log(typeof v === 'string' ? v : JSON.stringify(v));
    await sleep(800);
}
if (process.env.MOVE) {
    const [x, y] = process.env.MOVE.split(',').map(Number);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(800);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved', out, 'url', await evalJs('location.href'));
ws.close();
