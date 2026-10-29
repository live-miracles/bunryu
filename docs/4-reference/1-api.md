# REST API

All routes below sit behind the session-cookie auth middleware except
`/api/ready` and `/api/auth/login`. HLS preview files under `/hls` use the same
session cookie. SRS's `on_publish`/`on_play` hooks are not on this port at all —
they are served on the loopback-only hook port. An output pushes to a
single destination: `url` and `audioEncoding`, plus `videoEncoding`. The input is
pulled back over whatever protocol it was published with (SRT input → SRT pull,
RTMP input → RTMP pull), so there is no pull-method setting. An error is always
JSON, `{ "error": "…" }`; an unexpected failure is a 500 with a generic message
(the detail is in the log).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Pipelines, outputs, encodings, stream keys, server name. `srtPassphrasePending` is `true` while a reset passphrase is waiting for the restart |
| GET | `/api/health` | Live input/output status snapshot (refreshed every 5s). An output has `warningReason` and `warningSinceMs` (when that warning began), and `nextRetryAtMs`, when its pending retry after a failure is due (else `null`); each pipeline alert has `sinceMs`, the time its current episode started, which stays the same while the alert lasts. An alert is one episode until it has been absent for six polls (~30 s). `pipelines.<id>.input.keyframes` is the keyframe check of the current publisher, `{ windowSec, spanSec, keyframes, meanGapSec, maxGapSec, checkedAt }` (`null` until it has run, or if it failed; `meanGapSec` is `null` below two keyframes), and the `input-keyframe-interval` alert is raised from it. `hostAlerts` lists the open host resource alerts (`cpu`, `memory`, `disk`). `srtBonding.input`, each of its `legs` and `srtBonding.output` have `recent`: `{ spanMs, packets, loss, retrans, drop }`, how much those cumulative counters grew over the last 10 minutes (`spanMs` is shorter just after connecting; a counter the relay does not report is `null`), or `null` until two polls exist |
| GET | `/api/rejected-publishes` | Recent publish attempts rejected for a key with no pipeline (label only, never the secret) |
| GET | `/api/version` | App, SRS, relay, FFmpeg and Node versions, git commit, OS, kernel and CPU model (cached after the first request), and the kernel's UDP buffer caps `rmemMaxBytes` / `wmemMaxBytes` (read on every request, `null` if unreadable) |
| GET | `/api/metrics/history` | System metric samples every 5 s for the last 2 hours; `?after=<ms>` returns only newer samples |
| GET | `/api/metrics/system` | Host CPU, RAM, disk and network stats (RAM used is total minus `MemAvailable`, so reclaimable page cache does not count) |
| GET | `/api/srs-logs` | Recent Server events (SRS and Goryu becoming unreachable or recovering, host CPU, memory and disk alerts: `{ ts, source: srs\|relay\|host, type: problem\|recovered, message }`) and log tails for SRS, the dashboard, and the relay |
| GET | `/api/ready` | Unauthenticated readiness check used by systemd before starting SRS |
| POST | `/api/pipelines` | Create pipeline (auto-names and assigns stream key) |
| GET | `/api/pipelines/:id` | Pipeline details including relay health and bonded-input activity |
| POST | `/api/pipelines/:id` | Rename pipeline `{ name }`, optionally reassign key `{ name, streamKeyId }` — a key change returns 409 while any of your outputs is running; a shared encode still running is stopped first, so the next one pulls the new key |
| DELETE | `/api/pipelines/:id` | Delete pipeline (stream key is freed, not deleted) — 409 while any of your outputs is running; its shared encodes are stopped and removed with it |
| GET | `/api/pipelines/:id/logs` | Pipeline event log: input online/offline, probe results, and bonded legs joining or leaving (event `legs`) |
| GET | `/api/health/pipelines/:id/legs/history` | Per-leg SRT history of a bonded input (state, health, rate, RTT, loss), 5 s samples for up to 30 min; `?from=`, `?to=`, `?after=` in ms |
| POST | `/api/pipelines/:id/preview/start` | Start an HLS preview `{ audioTrackCount? }` (1–50, default 1); returns `{ hlsUrl }`. Video is copied, audio is AAC, one rendition per track |
| POST | `/api/pipelines/:id/preview/keepalive` | Refresh the preview TTL — a preview with no keepalive and no HLS fetch for 20s is stopped automatically; closing the tab also stops it immediately |
| POST | `/api/pipelines/:id/preview/stop` | Stop the HLS preview |
| POST | `/api/pipelines/:id/outputs` | Create output `{ name, videoEncoding, url, audioEncoding }` |
| POST | `/api/pipelines/:id/outputs/bulk` | Bulk create outputs `{ outputs: [{ name, videoEncoding, url, audioEncoding }] }` — validates all before creating any |
| DELETE | `/api/pipelines/:id/outputs` | Clear all outputs for the pipeline — returns 409 if any of your outputs is still running (shared encodes are stopped and removed with them) |
| POST | `/api/pipelines/:id/outputs/:outId` | Update output (same body as create; a field left out keeps its stored value). A running output accepts only `{ name }` — any other field gives 409, even with an unchanged value — and a shared encode always gives 409 |
| DELETE | `/api/pipelines/:id/outputs/:outId` | Delete output (stops it first if running) — 409 for a shared encode |
| POST | `/api/pipelines/:id/outputs/start-all` | Start all outputs (staggered at 200 ms intervals, returns immediately) |
| POST | `/api/pipelines/:id/outputs/stop-all` | Stop all outputs |
| POST | `/api/pipelines/:id/outputs/:outId/start` | Start output |
| POST | `/api/pipelines/:id/outputs/:outId/stop` | Stop output |
| POST | `/api/pipelines/:id/outputs/:outId/restart` | Stop a running output and start it again; works for any output including a shared encode, whose outputs reconnect with it. Returns `{ ok: true }`, or 409 when the output is not running or was restarted less than 5 s ago. Recorded in its History as "Restarted by user" (not a failure) |
| GET | `/api/pipelines/:id/outputs/:outId/errors` | Output History, oldest first (also for a shared encode). A repeated crash is one record with `count` and `lastTs`; `recoveredTs` is set once the output ran steadily again |
| POST | `/api/settings/general` | Update the server name and public host `{ name, publicHost? }` |
| POST | `/api/settings/layout-order` | Save the dashboard's pipeline and output order `{ order: [{ id, outs: [outputId] }] }` |
| POST | `/api/settings/pipeline-groups` | Replace the sidebar pipeline groups `{ groups: [{ id?, name }] }` |
| POST | `/api/settings/regenerate-stream-keys` | Regenerate all stream keys |
| POST | `/api/settings/reset-srt-passphrase` | Write a new random SRT passphrase to `srs.conf` and `goryu.json` and answer `{ ok: true }` (the value is not returned). `409` while an input is live or an output is not stopped; `500` if a file can't be edited (nothing is left changed). SRS and Goryu enforce it after they restart, and the app shows it after its own restart |
| POST | `/api/auth/login` | Login `{ password }` — sets session cookie |
| POST | `/api/auth/logout` | Logout — clears session cookie |
| POST | `/api/auth/change-password` | Change password `{ currentPassword, newPassword }` |
| POST | `/api/srs/on_play` | SRS play hook (on the loopback-only `hook_port`). Only plays from loopback (the app's own FFmpeg) are accepted; others are refused and listed in `/api/rejected-publishes` |
| POST | `/api/srs/on_publish` | SRS publish hook (called by SRS on the loopback-only `hook_port`, not on the dashboard port). Pipeline keys are accepted in the `live` app; the reserved `internal` app is accepted only for a running shared encode, over RTMP from loopback |

## Using the API from a script

There is no CLI or API token: a script logs in with the dashboard password and
sends the session cookie (valid 7 days) on every call. Five wrong passwords in a
minute block that IP for five minutes (`429`), so don't retry a failed login in a loop.

```bash
curl -sS -c jar -H 'content-type: application/json' \
  -d '{"password":"…"}' http://localhost:8080/api/auth/login
curl -sS -b jar http://localhost:8080/api/health
curl -sS -b jar -X POST http://localhost:8080/api/pipelines/1/outputs/start-all
```

A start returns before anything is running, so poll `/api/health` for the result.
An output started while its pipeline has no live input stays `stopped` (its
desired state is `running`) until a publisher connects.

## Shared encodes

Outputs of one pipeline that need the same encode (the same `videoEncoding` plus
the same single audio track, and not plain copy or multi-track)
share one upstream FFmpeg, a *shared encode* (internally a rendition). It is an
ordinary output row owned by the server, so the API exposes it as one:

- **It appears in `outputs`** of `/api/config` and in `/api/health` like any other
  output. It is recognised by its `url`,
  `rtmp://127.0.0.1:<rtmpPort>/internal/r<pipelineId>_<videoEncoding>_a<audioEncoding>`,
  and its `name` lists what is encoded: `Shared encode <video> · T<n>`, leaving out a copied video or source audio (`Shared encode 720p · T1`, `Shared encode T2`; T1 is audio track 0). Its `videoEncoding` and
  `audioEncoding` are the recipe.
- **The server creates and deletes it** while a pipeline has at least two outputs
  with the same recipe (a single output encodes on its own and gets no row), and
  starts and stops it with the outputs that use it (it stops 15 s after the last
  one). The row is created within about a second of the second output being added,
  and removed once fewer than two are left and no output is still reading it.
- **You cannot change it.** Update, delete, start and stop of a shared encode
  return `409 { "error": "Shared encodes are managed automatically" }`. Its History
  can be read, and it can be restarted (`/restart`).
- **You cannot create outputs in the `internal` app.** Create, bulk create and
  update refuse a destination that resolves to this host with a path under
  `/internal/` (`400`, "the internal app is reserved for shared encodes").
- **Output stats carry extra fields** (`GET /api/health`, per output): `role`
  (`"rendition"` for a shared encode, else `"output"`), `renditionId` (the shared
  encode a running shared output is pulling, else `null`), and, for a shared
  encode, `ready` (running and already writing data) and `readers` (outputs
  currently pulling it; `null` on other outputs). The internal streams never
  affect a pipeline's own `input` (liveness, readers).
