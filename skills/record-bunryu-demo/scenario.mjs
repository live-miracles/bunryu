// The "how it works" walkthrough of the README: create a pipeline, publish a film
// to it, preview it, add three destinations, start them. Driven by the app-demo
// recorder (record.mjs) against the Docker stack of skills/record-bunryu-demo/SKILL.md.
//
// Environment:
//   BUNRYU_DASHBOARD_PASSWORD  the password the stack was started with
//   DEMO_FEED                  the CBR clip to publish (SKILL.md has the ffmpeg recipe)
//   DEMO_FFMPEG                the real ffmpeg binary (not a shim) that publishes it
import { spawn, spawnSync } from 'node:child_process';

const PASSWORD = process.env.BUNRYU_DASHBOARD_PASSWORD;
const FEED = process.env.DEMO_FEED;
const FFMPEG = process.env.DEMO_FFMPEG ?? 'ffmpeg';
if (!PASSWORD || !FEED) throw new Error('Set BUNRYU_DASHBOARD_PASSWORD and DEMO_FEED');

let publisher = null;
// child.kill() did not end ffmpeg on Windows (it kept publishing), so end the process tree
function stopPublisher() {
    if (!publisher) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(publisher.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        publisher.kill();
    }
    publisher = null;
}
process.on('exit', stopPublisher);

// A failed run must not leave the publisher behind, or it keeps feeding the stack
export default async function run(d) {
    try {
        await scenario(d);
    } finally {
        stopPublisher();
    }
}

async function scenario(d) {
    const q = JSON.stringify;

    // Dead time (a probe, a stream warming up) is not recorded; cap_gaps.py turns the gap
    // into a jump cut
    const skip = async (fn) => {
        await d.record.stop();
        try {
            return await fn();
        } finally {
            d.record.start();
        }
    };
    // d.waitFor treats every string as a CSS selector, so a JS condition needs its own poll
    const until = async (expr, timeout = 10000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            if (await d.js(`!!(${expr})`)) return;
            await d.sleep(200);
        }
        throw new Error('until timed out: ' + expr);
    };
    const clear = (sel) => d.js(`(() => { document.querySelector(${q(sel)}).value = ''; })()`);
    // The output form is prefilled from the last output, so clear before typing
    const fill = async (sel, text) => {
        await d.waitFor(sel);
        await clear(sel);
        await d.type(sel, text, { delay: 30, wait: 300 });
    };
    const pickServer = async (value) => {
        await d.moveTo('#out-server-input');
        await d.js(
            `(() => { const s = document.getElementById('out-server-input'); s.value = ${q(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
        );
        await d.sleep(800);
    };
    const addOutput = async ({ name, server, value }) => {
        await d.click('button[onclick^="addOutBtn"]', { wait: 500 });
        await fill('#out-name-input', name);
        await pickServer(server);
        await fill('#out-sink-key-input', value);
        await d.click('#out-save-btn', { wait: 900 });
    };

    // ---- not recorded: log in, start from an empty server ----
    await d.js(
        `(() => { document.getElementById('password-input').value = ${q(PASSWORD)}; setTimeout(() => document.getElementById('login-btn').click(), 0); })()`,
    );
    await d.sleep(3000);
    await d.waitFor('button[onclick^="addPipeBtn"]');
    await d
        .js(
            `(async () => {
      const cfg = await (await fetch('/api/config')).json();
      for (const p of cfg.pipelines) await fetch('/api/pipelines/' + p.id, { method: 'DELETE' });
      // Set the public host, so the "Public Host is not set" banner is not in the GIF
      await fetch('/api/settings/general', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cfg.serverName, publicHost: 'live.example.test' }) });
      const left = (await (await fetch('/api/config')).json()).pipelines.length;
      if (left) return left; // not empty: reported below
      setTimeout(() => location.reload(), 0);
      return 0;
    })()`,
        )
        .then((left) => {
            if (left)
                throw new Error(
                    `${left} pipeline(s) left: recreate the stack with a fresh volume before recording`,
                );
        });
    await d.sleep(3000);
    await d.waitFor('button[onclick^="addPipeBtn"]');

    // The fake cursor and the caption sit in the top layer when a modal is open, or they
    // would hide behind it
    await d.js(
        `(() => { setInterval(() => { const host = document.querySelector('dialog[open]') ?? document.documentElement; for (const id of ['__demo_cursor', '__demo_caption']) { const el = document.getElementById(id); if (el && el.parentElement !== host) host.appendChild(el); } }, 50); })()`,
    );
    // A caption bar names each step, so the GIF reads without sound or a README next to it
    const say = (text) =>
        d.js(`(() => {
          let c = document.getElementById('__demo_caption');
          if (!c) {
            c = document.createElement('div');
            c.id = '__demo_caption';
            Object.assign(c.style, { position: 'fixed', left: '50%', bottom: '22px', transform: 'translateX(-50%)', zIndex: 2147483646, pointerEvents: 'none', padding: '9px 20px', borderRadius: '999px', background: 'rgba(24,24,32,.94)', border: '1px solid rgba(255,255,255,.18)', color: '#fff', font: '600 16px system-ui, sans-serif', boxShadow: '0 4px 18px rgba(0,0,0,.45)', whiteSpace: 'nowrap' });
            document.documentElement.appendChild(c);
          }
          c.textContent = ${q(text)};
        })()`);
    // Smooth-scroll the page's main scrollable area to a fraction of its length (0 top, 1 bottom)
    const scrollMain = (fraction, ms) =>
        d.js(`(async () => {
          const cands = [document.scrollingElement, ...document.querySelectorAll('*')].filter(
            (e) => e && e.scrollHeight > e.clientHeight + 40 &&
              (e === document.scrollingElement || ['auto', 'scroll'].includes(getComputedStyle(e).overflowY)) &&
              e.getBoundingClientRect().width > 400,
          );
          cands.sort((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight));
          const el = cands[0];
          if (!el) return 'no scrollable area';
          const from = el.scrollTop;
          const to = ${fraction} * (el.scrollHeight - el.clientHeight);
          const t0 = performance.now();
          await new Promise((done) => {
            const step = (t) => {
              const k = Math.min(1, (t - t0) / ${ms});
              const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
              el.scrollTop = from + (to - from) * e;
              if (k < 1) requestAnimationFrame(step); else done();
            };
            requestAnimationFrame(step);
          });
          return el.tagName + '#' + el.id + ' ' + Math.round(el.scrollHeight) + '/' + Math.round(el.clientHeight);
        })()`);
    // Stills are for the docs: no caption in them
    const shot = async (name) => {
        await d.js(
            `(() => { const c = document.getElementById('__demo_caption'); if (c) c.style.visibility = 'hidden'; })()`,
        );
        await d.shot(name);
        await d.js(
            `(() => { const c = document.getElementById('__demo_caption'); if (c) c.style.visibility = ''; })()`,
        );
    };

    d.record.start();
    await d.sleep(1500); // the empty dashboard

    // 1. Create a pipeline, name it ("Add pipeline" creates one at once; the pencil renames it)
    await say('1   Create a pipeline: one input with its own stream key');
    await d.click('button[onclick^="addPipeBtn"]', { wait: 1800 });
    await d.click('#pipe-edit-btn', { wait: 900 });
    await fill('#pipe-name-input', 'Main Stage');
    await d.click('#edit-pipe-modal button[onclick^="pipeFormBtn"]', { wait: 1500 });
    await shot('pipeline-created');

    // 2. Publish to it (the encoder is a looped film)
    await say('2   Publish to its URL from any encoder (RTMP, SRT)');
    const url = await d.js(`(async () => {
      const j = await (await fetch('/api/config')).json();
      const p = j.pipelines.find((x) => x.name === 'Main Stage');
      return p ? p.rtmpPublishUrlLocal.replace('localhost', '127.0.0.1') : 'MISSING ' + JSON.stringify(j.pipelines.map((x) => x.name));
    })()`);
    d.log('publish url: ' + url.replace(/key\d+_\w+/, 'key<redacted>')); // the log is not for the repo
    if (url.startsWith('MISSING')) throw new Error(url);
    await d.sleep(1500); // let the viewer read the Publish card
    publisher = spawn(
        FFMPEG,
        ['-re', '-stream_loop', '-1', '-i', FEED, '-c', 'copy', '-f', 'flv', url],
        {
            stdio: 'ignore',
        },
    );
    // The first probe can time out (15 s) on a busy machine and is retried, so allow time
    await skip(() => until(`document.body.innerText.includes('h264')`, 90000));
    await d.sleep(1500);
    await shot('input-live');

    // 3. Preview
    await say('3   The live input is detected: preview it and see its media details');
    await d.click('#preview-stop-btn', { wait: 500 });
    await skip(() => until(`(document.querySelector('video')?.currentTime ?? 0) > 1`, 20000));
    await d.sleep(2800); // long enough to read the caption and see the picture move
    await shot('preview');

    // 4. Outputs: the YouTube preset's host resolves to the receiver container
    await say('4   Add destinations: YouTube, a CDN, an archive');
    await addOutput({ name: 'YouTube', server: 'youtube', value: 'demo-1234-abcd-5678' });
    await addOutput({
        name: 'Partner CDN',
        server: 'custom-rtmp',
        value: 'rtmp://cdn-a.example.test/live/partner',
    });
    await addOutput({
        name: 'Archive',
        server: 'custom-rtmp',
        value: 'rtmp://cdn-b.example.test/live/archive',
    });
    await shot('outputs-added');

    // 5. Start them all ("Start all" asks for a confirmation)
    await say('5   Start them: one input, three destinations');
    await d.click('#outputs-start-all-btn', { wait: 900 });
    await d.click('#confirm-modal-ok', { wait: 1500 }); // the outputs start, still with warnings
    // Wait (unrecorded) until all three run clean: no warning text and no bitrate chip
    // (a chip means the output's bitrate is off the input's)
    await skip(() =>
        until(
            `/3 running/.test(document.body.innerText) && !/warning/i.test(document.body.innerText) && !document.querySelector('#outputs-list .badge-warning')`,
            90000,
        ),
    );
    await d.sleep(2500);
    await shot('outputs-running');
    d.log(
        'outputs list: ' +
            (await d.js(
                `document.getElementById('outputs-list').innerText.replace(/\\n+/g, ' | ')`,
            )),
    );
    await d.sleep(500);

    // 6. The Overview: host charts, then scroll down to every input and output
    await say('6   Overview: host charts and every input and output at a glance');
    await d.click('#overview-nav-btn', { wait: 2800 });
    await shot('overview');
    d.log('overview scroller: ' + (await scrollMain(1, 2600)));
    // The caption would cover the last table row at the bottom of the scroll
    await d.js(`document.getElementById('__demo_caption')?.remove()`);
    await d.sleep(2200);
    await shot('overview-tables');
    await d.sleep(500);
    await d.record.stop();
    // Not shown: the Status view lists "Recent problems", and the stack's first seconds leave
    // one there (SRS unreachable until it is up). Server Logs prints the raw SRS lines,
    // which contain the stream key.

    // Prove the actions took effect
    const state = await d.js(
        `fetch('/api/config').then(r => r.json()).then(j => ({ pipelines: j.pipelines.map(p => p.name), outputs: j.outputs.map(o => o.name) }))`,
    );
    d.log('config: ' + JSON.stringify(state));
}
