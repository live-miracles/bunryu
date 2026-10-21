---
name: run-bunryu
description: Run, start, drive and screenshot the Bunryu dashboard in an isolated local test stack (own SRS + control plane + fresh DB + fake output ffmpeg), without touching a developer's own `npm run dev`. Use to test output/health/dashboard behavior, simulate FFmpeg timestamp-discontinuity floods, and take dashboard screenshots.
---

# Run Bunryu (isolated test stack)

Paths are relative to the repo root. `scripts/test-stack.sh` (a tool-agnostic
repo script; this skill is just its man page) starts a **separate** stack on
its own ports (app 18080, hooks 18082, SRS RTMP 31935 / API 31985 / SRT 31080, Chrome 9333)
with a **fresh database** in `$WORK` (default `${TMPDIR:-/tmp}/bunryu-ui`),
so it never collides with a developer's own instance on 8080/1985. The
control plane is the real code, and the test publisher, HLS preview and ffprobe
use the real pinned `objs/` binaries; only the *output* ffmpeg is a shim that
reports healthy progress and can emit an FFmpeg timestamp-discontinuity flood
on demand. [Shared encodes](../../docs/2-usage/2-outputs.md#shared-encodes) are
real: the shared encode's FFmpeg (it publishes to the `internal` app) runs the
real `objs/ffmpeg`, and an output that reads one runs the real FFmpeg too, writing
to `/dev/null`, so reader counts, fan-out through SRS and restarts are genuine. The dashboard is driven with headless Chrome over CDP
(`scripts/test-stack-cdp.mjs`) because `chromium-cli`/playwright are not installed here.

## Prerequisites

Repo-local binaries `objs/ffmpeg`, `objs/ffprobe`, `objs/srs` (the repo's normal
dev setup; `objs/ffmpeg` is the same pinned build prod installs, currently
`n7.1.4-7-gadcf20da26` — check with `objs/ffmpeg -version | head -1`, not the
system ffmpeg), `node` 22+, `google-chrome`, `lsof`, `python3`, `curl`, and
`npm install` done. The harness refuses to start with <1.5 GB of available
memory (`FORCE=1` overrides) — see Gotchas.

## Run (agent path)

```bash
export WORK=/tmp/bunryu-ui          # optional; any writable dir
H=scripts/test-stack.sh

$H start          # builds public/js, starts SRS+app, logs in, creates pipeline
                  # "Test_Live" with 4 outputs, publishes a test stream, starts
                  # outputs, prints health (~20 s). Safe to pipe through tail.
$H status         # per-output status/warning, shared encodes (status, ready, readers)
                  # and pipeline alerts from /api/health
$H flood on       # fake ffmpeg starts emitting ~80 discontinuity lines/s/output
$H flood off
$H shot $WORK/shot.png "history.replaceState({},'','/?p=1')" 1500
MOVE=46,194 $H shot $WORK/hover.png "history.replaceState({},'','/?p=1')" 1500
VIEWPORT=390x844 $H shot $WORK/phone.png "window.selectPipeline('1')" 2500   # phone-sized screen
$H stop           # kills app, SRS, Chrome, publisher; prints "all test ports closed"
```

`shot <png> [js] [waitMs]` logs in (the stack seeds the fresh DB with the password `admin`), loads the
dashboard, optionally evals `js`, and writes the PNG; `MOVE=x,y` hovers first
(46,194 is the pipeline status icon in the sidebar, whose tooltip lists every
issue). `VIEWPORT=WxH` resizes the screen (default 1500x1000; widths under 1024
emulate a phone, where the columns stack). **Look at the PNG.** Open `/?p=1` for the pipeline detail view with the
output cards.

Typical timestamp-fault check: `start`, `flood on`, wait ~12 s, `status` shows
each output's warning plus `('warning', 'input-timestamps-unstable')`;
`flood off`, wait ~35 s, `status` is clean again. Events are in
`$WORK/diagnostics/*.jsonl`.

### Fault scenarios (`scripts/test-faults.mjs`)

The default outputs are a shim and never touch the network, so a destination cannot
fail. `scripts/test-faults.mjs` runs real FFmpeg copy outputs to real local
destinations to exercise the stall watchdog, isolation and bounded resources:

```bash
FAST_WATCHDOG=1 $H start            # 20 s warm-up / 15 s stall instead of 90 s / 45 s
node scripts/test-faults.mjs freeze     # 50 healthy outputs + one whose destination is kill -STOP'd
node scripts/test-faults.mjs blackhole  # ... + one that accepts the TCP connection and never reads
node scripts/test-faults.mjs refused    # 10 healthy + two outputs whose destination refuses connections
node scripts/test-faults.mjs churn      # 10 healthy while 45 outputs are added, started, stopped, deleted
node scripts/test-faults.mjs publisher-drop  # 10 healthy while the publisher disappears for 3 s and 25 s
node scripts/test-faults.mjs srt         # 10 healthy + three SRT outputs: silent, frozen and non-reading destinations
node scripts/test-faults.mjs soak --minutes 60   # freeze and blackhole, thawing and freezing every 2.5 min
$H stop
$H start                            # production windows, for the next one
node scripts/test-faults.mjs contention [--burn-seconds 90]   # 50 healthy while CPU burners saturate the host
$H stop
```

Each prints PASS/FAIL per check and exits 1 on any failure (about 5, 4, 3, 2, 3, 2, N+3 and 3
minutes). The 50-output scenarios replace the stack's four default outputs with 50
`h01…h50` plus the faulty ones (about 1 GB for the 52 FFmpeg processes); the others use 10.
They start extra SRS instances as the destinations and remove them when they end.

- `blackhole` checks that the output's own `-rw_timeout` ends each attempt with
  "Connection timed out" and that the retry back-off paces them; the stall watchdog is
  the backstop and is not reached for RTMP.
- `refused` checks the 1, 2, 4, 8, 16 s retry back-off from the diagnostics, that an
  operator stop after a streak writes "Stopped after N failed attempts", that the
  output recovers by itself when the destination returns and that one stopped by hand
  stays stopped.
- `publisher-drop` expects a 3 s blip to restart nothing. After 25 s the destination
  SRS has dropped each idle publish connection (about 5 s without data), so every
  output reconnects once when the input returns; the scenario only asserts that this
  is bounded and automatic.
- `srt` runs three SRT outputs (the shim redirects `srt://192.0.2.<N>:<port>?...` like it
  does RTMP ones): a destination that never answers and a frozen SRS listener must end by
  themselves through libsrt's own timeouts (about 4 s and 6 s), and a receiver that stays
  connected but stops reading must go unnoticed and unrestarted.
- `contention` runs one busy loop per CPU and is only meaningful with the production
  windows (no `FAST_WATCHDOG`); it prints the load average. It makes the machine busy
  for the whole burn, so don't run it on a host someone is working on.
- `soak` writes `$WORK/soak.csv` (app, SRS and FFmpeg memory, FFmpeg count, app file
  handles every 30 s) and, for runs of 20+ minutes, fails if memory grows by 50 MB/h or
  more after a 10 minute warm-up.

How it works: an output to `rtmp://192.0.2.<N>/<name>` is pushed for real to
`rtmp://127.0.0.1:<port>/dest/<name>` when `$WORK/dest-<N>.port` exists (the shim reads it).
The socket watchdog stays off (it matches the configured destination port, which these
loopback destinations do not have), so these scenarios test the progress watchdog and
the output timeouts, not the socket watchdog.

### Dashboard at the supported ceiling (50 inputs, 500 outputs)

Measured in October 2026 for [Sizing](../../docs/1-getting-started/4-sizing.md#the-dashboard-at-the-supported-ceiling):

1. `$H start`, then with [control-bunryu](../control-bunryu/SKILL.md) create 49 more
   pipelines and add outputs with the bulk route until each has 10 (500 is the cap; it
   takes under a second). Optionally group them with `POST /api/settings/pipeline-groups`
   and `groupId` on each pipeline.
2. Publish a real stream to each pipeline: stream-copy one short clip in a loop with
   `objs/ffmpeg -re -stream_loop -1 -i clip.mp4 -c copy -f flv rtmp://127.0.0.1:31935/live/<key>`
   (about 25 MB each), then `start-all` on every pipeline.
3. Check `/api/health` (all `running`), then use `$H shot` and `scripts/test-stack-cdp.mjs`
   for screenshots and page metrics. Taking two publishers down shows how problems
   surface.

The shim's progress loop uses only bash builtins (a fork per output per second saturated
an 8-core host at 500 outputs); the outputs send nothing, so FFmpeg's own CPU and RAM are
not in the result, only the control plane's and the dashboard's.

Run the repo's own tests separately with `npm test` (not part of this harness).

## Gotchas

- **Never use `pkill -f` with a broad pattern** in agent commands — it matched
  its own command line and killed the shell. `stop` kills by listening port and
  a pid file instead.
- **Detached launches must redirect stdin/stdout/stderr** (`bg()` in
  `scripts/test-stack.sh`). The first version used `( cd … && cmd & )`, which left a
  subshell holding the caller's pipe open, so `scripts/test-stack.sh start | tail`
  never returned even though the stack was up.
- **Hooks and ports come from `$WORK/srs.conf`**: the app reads SRS's API/RTMP/SRT
  ports from `srs_config_path` and SRS calls `on_publish`/`on_play` at
  the app's loopback-only hook port (`127.0.0.1:8082`) — the harness rewrites those to the isolated ports. Edit the
  `sed` lines in `scripts/test-stack.sh` if `srs.conf` changes its listen lines.
- **`WORK` must be outside the repo**: `start` overwrites `bunryu.json` and
  `srs.conf` and deletes `db.sqlite*` in it, so the script refuses a `WORK` at or
  under the repo (it would wipe a developer's real config and database).
- `PORT` and `DATABASE_PATH` env vars override `bunryu.json`, which is what
  makes the isolated instance possible.
- **Socket watchdog**: outputs target `rtmp://192.0.2.10` (TEST-NET-1; the
  API rejects loopback destinations other than this server's own ports), which
  the shim never connects to, so `socket_warmup_ms`/`socket_grace_ms` are set to
  1 h or the watchdog would restart the shim outputs.
- The shim treats an ffmpeg call whose **last argument is an
  rtmp/rtmps/srt URL** as an output; everything else (HLS preview) runs the
  real `objs/ffmpeg`. Exceptions that run the real ffmpeg: a call whose last
  argument is `rtmp://127.0.0.1:$RTMP_PORT/internal/…` (a shared encode), and a call
  that reads such a stream as its input (a shared output; its destination is
  replaced by `/dev/null`). `touch $WORK/real-outputs` makes **every** output do
  that (for CPU comparisons); `start` and `stop` remove the file. Kill a shared
  encode by pid (find it with `ps -eo pid,args`, not `pkill -f`).
- Shared encodes need **two** outputs with the same recipe, each with a video
  encoding other than `copy` or an audio track number, e.g.
  `{"videoEncoding":"720p","audioEncoding":"0"}`; a lone one runs direct, and the
  default four outputs are plain copy and stay direct.
- `public/js` is gitignored build output; `start` runs `npx tsc -p tsconfig.json`
  so the served frontend matches `public/ts`.
- **Resource use**: on a 15 GB dev laptop with full swap, the stack plus a
  sustained flood pushed the machine into thrashing (load average >80, the
  publisher died). Check `free -m` first, keep floods to a few minutes, and
  `stop` when done.
- The test input is RTMP. To exercise the SRT *pull* path publish SRT with the
  pinned `objs/ffmpeg` (7.1; the system ffmpeg 8 stalls on SRS SRT pulls) to
  `srt://127.0.0.1:31080?streamid=#!::r=live/<key>,m=publish&passphrase=<from $WORK/srs.conf>&pbkeylen=16`.

## Troubleshooting

- `port N already in use - run 'stop' first` → a previous run is still up:
  `$H stop`.
- `only NNNMB available` → free memory, or `FORCE=1 $H start`.
- `$H shot` prints a login page / blank frame → the app isn't up (`$H status`
  fails); check `$WORK/app.log`.
- `status` shows `input {'connected': False…}` → the publisher died (look at
  `$WORK/pub.log`); `$H stop && $H start`.
