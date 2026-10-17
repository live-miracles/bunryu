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
$H stop           # kills app, SRS, Chrome, publisher; prints "all test ports closed"
```

`shot <png> [js] [waitMs]` logs in (fresh DB password is `admin`), loads the
dashboard, optionally evals `js`, and writes the PNG; `MOVE=x,y` hovers first
(46,194 is the pipeline status icon in the sidebar, whose tooltip lists every
issue). **Look at the PNG.** Open `/?p=1` for the pipeline detail view with the
output cards.

Typical timestamp-fault check: `start`, `flood on`, wait ~12 s, `status` shows
each output's warning plus `('warning', 'input-timestamps-unstable')`;
`flood off`, wait ~35 s, `status` is clean again. Events are in
`$WORK/diagnostics/*.jsonl`.

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
- Shared encodes need an output with a video encoding other than `copy` or an
  audio track number, e.g. `{"videoEncoding":"720p","audioEncoding":"0"}`; the
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
