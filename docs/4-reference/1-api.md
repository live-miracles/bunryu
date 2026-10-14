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
| POST | `/api/pipelines/:id` | Rename pipeline `{ name }`, optionally reassign key `{ name, streamKeyId }` |
| DELETE | `/api/pipelines/:id` | Delete pipeline (stream key is freed, not deleted) |
| GET | `/api/pipelines/:id/logs` | Pipeline online/offline event log |
| POST | `/api/pipelines/:id/preview/start` | Start an HLS preview `{ audioTrack? }` |
| POST | `/api/pipelines/:id/preview/keepalive` | Refresh the preview TTL — a preview with no keepalive and no HLS fetch for 20s is stopped automatically; closing the tab also stops it immediately |
| POST | `/api/pipelines/:id/preview/stop` | Stop the HLS preview |
| POST | `/api/pipelines/:id/outputs` | Create output `{ name, videoEncoding, url, audioEncoding }` |
| POST | `/api/pipelines/:id/outputs/bulk` | Bulk create outputs `{ outputs: [{ name, videoEncoding, url, audioEncoding }] }` — validates all before creating any |
| DELETE | `/api/pipelines/:id/outputs` | Clear all outputs for the pipeline — returns 409 if any output is still running |
| POST | `/api/pipelines/:id/outputs/:outId` | Update output (same body as create) |
| DELETE | `/api/pipelines/:id/outputs/:outId` | Delete output (stops it first if running) |
| POST | `/api/pipelines/:id/outputs/start-all` | Start all outputs (staggered at 200 ms intervals, returns immediately) |
| POST | `/api/pipelines/:id/outputs/stop-all` | Stop all outputs |
| POST | `/api/pipelines/:id/outputs/:outId/start` | Start output |
| POST | `/api/pipelines/:id/outputs/:outId/stop` | Stop output |
| POST | `/api/settings` | Update settings `{ name, publicHost }` |
| POST | `/api/settings/regenerate-stream-keys` | Regenerate all stream keys |
| POST | `/api/auth/login` | Login `{ password }` — sets session cookie |
| POST | `/api/auth/logout` | Logout — clears session cookie |
| POST | `/api/auth/change-password` | Change password `{ currentPassword, newPassword }` |
| POST | `/api/srs/on_publish` | SRS publish hook (called by SRS on the loopback-only `hook_port`, not on the dashboard port) |
