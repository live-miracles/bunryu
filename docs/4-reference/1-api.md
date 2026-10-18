# REST API

All routes below sit behind the session-cookie auth middleware except
`/api/ready` and `/api/auth/login`. HLS preview files under `/hls` use the same
session cookie. SRS's `on_publish`/`on_play` hooks are not on this port at all —
they are served on the loopback-only hook port. An output pushes to a
single destination: `url` and `audioEncoding`, plus `videoEncoding`. The input is
pulled back over whatever protocol it was published with (SRT input → SRT pull,
RTMP input → RTMP pull), so there is no pull-method setting.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Pipelines, outputs, encodings, stream keys, server name |
| GET | `/api/health` | Live input/output status snapshot (refreshed every 5s) |
| GET | `/api/rejected-publishes` | Recent publish attempts rejected for a key with no pipeline (label only, never the secret) |
| GET | `/api/version` | App version / build info |
| GET | `/api/metrics/system` | Host CPU, RAM, disk and network stats |
| GET | `/api/srs-logs` | Recent SRS up/down events and log tails for SRS, the dashboard, and the relay |
| GET | `/api/ready` | Unauthenticated readiness check used by systemd before starting SRS |
| POST | `/api/pipelines` | Create pipeline (auto-names and assigns stream key) |
| GET | `/api/pipelines/:id` | Pipeline details including relay health and bonded-input activity |
| POST | `/api/pipelines/:id` | Rename pipeline `{ name }`, optionally reassign key `{ name, streamKeyId }` — a key change returns 409 while any of your outputs is running; a shared encode still running is stopped first, so the next one pulls the new key |
| DELETE | `/api/pipelines/:id` | Delete pipeline (stream key is freed, not deleted) — 409 while any of your outputs is running; its shared encodes are stopped and removed with it |
| GET | `/api/pipelines/:id/logs` | Pipeline online/offline event log |
| POST | `/api/pipelines/:id/preview/start` | Start an HLS preview `{ audioTrackCount? }` (1–50, default 1); returns `{ hlsUrl }`. Video is copied, audio is AAC, one rendition per track |
| POST | `/api/pipelines/:id/preview/keepalive` | Refresh the preview TTL — a preview with no keepalive and no HLS fetch for 20s is stopped automatically; closing the tab also stops it immediately |
| POST | `/api/pipelines/:id/preview/stop` | Stop the HLS preview |
| POST | `/api/pipelines/:id/outputs` | Create output `{ name, videoEncoding, url, audioEncoding }` |
| POST | `/api/pipelines/:id/outputs/bulk` | Bulk create outputs `{ outputs: [{ name, videoEncoding, url, audioEncoding }] }` — validates all before creating any |
| DELETE | `/api/pipelines/:id/outputs` | Clear all outputs for the pipeline — returns 409 if any of your outputs is still running (shared encodes are stopped and removed with them) |
| POST | `/api/pipelines/:id/outputs/:outId` | Update output (same body as create) — 409 unless stopped, and always 409 for a shared encode |
| DELETE | `/api/pipelines/:id/outputs/:outId` | Delete output (stops it first if running) — 409 for a shared encode |
| POST | `/api/pipelines/:id/outputs/start-all` | Start all outputs (staggered at 200 ms intervals, returns immediately) |
| POST | `/api/pipelines/:id/outputs/stop-all` | Stop all outputs |
| POST | `/api/pipelines/:id/outputs/:outId/start` | Start output |
| POST | `/api/pipelines/:id/outputs/:outId/stop` | Stop output |
| POST | `/api/pipelines/:id/outputs/:outId/restart` | Stop a running output and start it again; works for any output including a shared encode, whose outputs reconnect with it. Returns `{ ok: true }`, or 409 when the output is not running, is a translation output, or was restarted less than 5 s ago. Recorded in its Error History as "Restarted by user" (not a failure) |
| GET | `/api/pipelines/:id/outputs/:outId/errors` | Output Error History (also for a shared encode) |
| DELETE | `/api/pipelines/:id/outputs/:outId/errors` | Clear the Error History (also for a shared encode) |
| POST | `/api/settings` | Update settings `{ name, publicHost }` |
| POST | `/api/settings/regenerate-stream-keys` | Regenerate all stream keys |
| POST | `/api/auth/login` | Login `{ password }` — sets session cookie |
| POST | `/api/auth/logout` | Logout — clears session cookie |
| POST | `/api/auth/change-password` | Change password `{ currentPassword, newPassword }` |
| POST | `/api/srs/on_publish` | SRS publish hook (called by SRS on the loopback-only `hook_port`, not on the dashboard port). Pipeline keys are accepted in the `live` app; the reserved `internal` app is accepted only for a running shared encode, over RTMP from loopback |

## Shared encodes

Outputs of one pipeline that need the same encode (the same `videoEncoding` plus
the same single audio track, and not plain copy, multi-track or translation)
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
  return `409 { "error": "Shared encodes are managed automatically" }`. Its Error
  History can be read and cleared, and it can be restarted (`/restart`).
- **You cannot create outputs in the `internal` app.** Create, bulk create and
  update refuse a destination that resolves to this host with a path under
  `/internal/` (`400`, "the internal app is reserved for shared encodes").
- **It does not count toward the 500-output cap**, which is for your outputs.
- **Output stats carry extra fields** (`GET /api/health`, per output): `role`
  (`"rendition"` for a shared encode, else `"output"`), `renditionId` (the shared
  encode a running shared output is pulling, else `null`), and, for a shared
  encode, `ready` (running and already writing data) and `readers` (outputs
  currently pulling it; `null` on other outputs). The internal streams never
  affect a pipeline's own `input` (liveness, readers).
