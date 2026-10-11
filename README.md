# Restream SRS

Minimal streaming server — takes RTMP/SRT inputs and restreams them to multiple RTMP/SRT outputs. Built on official [SRS](https://github.com/ossrs/srs) for ingest, `srt-bonding-relay` for bonded SRT ingress, and FFmpeg for outputs. Node.js + TypeScript backend.

Designed to handle tens of simultaneous pipelines (inputs) and hundreds of output forwards running continuously across long events. See [Capacity & Limits](#capacity--limits) for the tested envelope.

```
OBS / ffmpeg  ──RTMP────────►  SRS (21935)  ──FFmpeg──►  YouTube / Facebook / ...
              ──SRT─────────►  SRS (10080)  ──FFmpeg──►  rtmp:// or srt://
              ──SRT bonding─►  srt-bonding-relay (10081) ──► SRS
```

---

## Architecture

| Component | Description |
|-----------|-------------|
| SRS | Ingest broker — accepts RTMP and SRT streams |
| srt-bonding-relay | Standalone bonded SRT relay (GitHub release in prod, sibling repo in dev) |
| Node.js app | REST API + dashboard on port 8080 |
| FFmpeg | One process per output, spawned and managed by the app |
| SQLite | Persistent state for pipelines, outputs, stream keys, settings |

---

## Capacity & Limits 

The server is built and operated for the envelope below. It has **not** been
tested or designed for anything beyond it — treat these as the supported ceiling,
not a target to exceed :)

| Limit | Supported ceiling |
|-------|-------------------|
| Inputs (pipelines) | up to **50** |
| Outputs (forwards) | up to **500** total — enforced: creating a 501st returns `409` |
| Outputs using custom (transcoding) encoding | only **a few** at a time — see below |
| Parallel dashboard clients | up to **~10** |

Past these figures, expect host CPU/RAM/network and the number of concurrent
FFmpeg processes (one per output) to become the limiting factors well before the
dashboard or API does.

**Keep almost all outputs in `copy` mode.** A `copy` output is a passthrough — it
remuxes the input and forwards it with negligible CPU cost, so hundreds can run on
modest hardware. A custom encoding (`720p`, `1080p`, `vertical_rotate`, …) makes
FFmpeg transcode the video, which is CPU-intensive: each such output consumes
roughly a full core's worth of work. **Only a handful of outputs should use custom
encoding at any one time**; everything else should be `copy`. Putting many outputs
into custom-encoding mode will saturate the CPU long before the 500-output ceiling
and starve the `copy` outputs and the dashboard alike.

**Parallel dashboard clients.** Health is computed once every 5s and shared by
all clients, so extra browser tabs do not multiply SRS/SRT-FFprobe work. API
responses are gzip-compressed, and config changes from another session are
picked up automatically via the health poll's config revision. Around 10
simultaneous dashboard clients is fine; higher counts are not tuned or tested.

---

## Running

This app now runs natively on Linux. The production setup uses three systemd services:

| Service | Purpose |
|---------|---------|
| `srs.service` | Native SRS binary, started as `/usr/local/bin/srs -c /etc/restream-srs/srs.conf` |
| `srt-bonding-relay.service` | Shared SRT bonding relay, started on UDP port 10081 |
| `restream-srs.service` | Node.js dashboard/API, started from `/opt/restream-srs/dist/index.js` |

The installer downloads the official SRS release binary and a pinned `srt-bonding-relay` binary from the standalone [`live-miracles/srt-bonding-relay`](https://github.com/live-miracles/srt-bonding-relay) GitHub releases.

Startup is ordered so the Node.js control plane is reachable before SRS accepts
publishes. `srs.service` waits for the unauthenticated readiness endpoint
`http://127.0.0.1:8080/api/ready` before starting; this prevents SRS publish
hooks from racing the dashboard/API process during boot.

**Production install:**
```bash
sudo apt-get update -q && sudo apt-get install -y -q git  # in case git is not installed
sudo git clone https://github.com/live-miracles/restream-srs /opt/restream-srs
sudo bash /opt/restream-srs/scripts/server-install.sh
```

**Set server timezone (optional, for readable log timestamps):**

SRS and journald log timestamps in the system's local timezone, which defaults to UTC on most fresh servers. Set it to your local timezone so log times make sense at a glance, e.g. for IST (Asia/Kolkata):
```bash
sudo timedatectl set-timezone Asia/Kolkata
```
List available timezone names with `timedatectl list-timezones`. No reboot is needed, but already-running services may have the old timezone cached in memory, so restart them to apply it to new log lines immediately:
```bash
sudo systemctl restart srs.service restream-srs.service srt-bonding-relay.service
```

**Update an installed server:**
```bash
sudo bash /opt/restream-srs/scripts/server-install.sh
```

**Stop services:**
```bash
sudo bash /opt/restream-srs/scripts/server-down.sh
```

Open the dashboard: `http://SERVER_IP:8080` — the installer prints the generated password on first install (it is also stored as `dashboard_password` in `restream.json`).

### Firewall ports needed

Default ports from `srs.conf` and `srt-bonding-relay.json`:

| Port | Protocol | Purpose |
|------|----------|---------|
| 21935 | TCP | RTMP input (non-default port to avoid 1935 scanner noise) |
| 10080 | UDP | SRT input (passphrase required) |
| 10081 | UDP | SRT bonding input (passphrase required) |
| 8080 | TCP | Dashboard + API |

Do **not** expose 8080 if the dashboard is served through a tunnel, or 8081 (relay
status). The SRS HTTP API (1985) is bound to `127.0.0.1` in `srs.conf`, and SRS's
publish/play hooks go to the app's separate loopback-only hook port (`hook_port`,
default **8082**), so neither can be reached from outside even with a permissive
firewall. Neither port needs a firewall rule; check with `ss -tlnp` after install
that 1985 and 8082 listen only on `127.0.0.1`.

### Cloudflare Tunnel (dashboard access)

The dashboard is meant to be reached through a Cloudflare Tunnel plus
Cloudflare Access (see [Security](#security)), so port 8080 can stay closed in
the firewall. The installer does not set this up; `cloudflared` runs as its own
systemd service, outside the three services above. Ingest (RTMP/SRT) and
outputs never go through the tunnel, so restarting `cloudflared` only
interrupts dashboard/API access.

1. **Create the tunnel** in Cloudflare Zero Trust → Networks → Tunnels →
   *Create a tunnel* (type *Cloudflared*). Copy the tunnel token from the
   install command it shows (the long string after `--token`).
2. **Add a public hostname** to the tunnel, e.g. `restream.example.com`, with
   service `HTTP` → `localhost:8080`.
3. **Protect it with Cloudflare Access**: Zero Trust → Access → Applications →
   add a self-hosted application for that hostname with an allow policy for
   your team. Without this the hostname is open to the internet and only the
   dashboard password stands in the way.
4. **Install `cloudflared`** from the
   [Cloudflare package repository](https://pkg.cloudflare.com/) (or the `.deb`
   from its GitHub releases).
5. **Store the token in a root-only environment file** rather than on the
   command line. Do **not** use `cloudflared service install <token>`: it puts
   the token in `ExecStart`, where every local user can read it via
   `ps`/`/proc/<pid>/cmdline` and the world-readable unit file.
   ```bash
   sudo install -d -m 0750 /etc/cloudflared
   sudo sh -c 'umask 077; printf "TUNNEL_TOKEN=%s\n" "<paste-token-here>" > /etc/cloudflared/tunnel.env'
   ```
   `cloudflared tunnel run` reads the `TUNNEL_TOKEN` environment variable
   itself, so no `--token` flag is needed.
6. **Create the unit** `/etc/systemd/system/cloudflared.service`:
   ```ini
   [Unit]
   Description=Cloudflare Tunnel client
   After=network-online.target
   Wants=network-online.target

   [Service]
   TimeoutStartSec=15
   Type=notify
   EnvironmentFile=/etc/cloudflared/tunnel.env
   ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run
   Restart=on-failure
   RestartSec=5s

   [Install]
   WantedBy=multi-user.target
   ```
7. **Start it and check**:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now cloudflared
   journalctl -u cloudflared -n 20 --no-pager   # look for "Registered tunnel connection"
   ps -eo args | grep '[c]loudflared'            # the token must not appear here
   ```

To rotate the token, generate a new one in the Zero Trust dashboard, update
`/etc/cloudflared/tunnel.env`, and `sudo systemctl restart cloudflared`. Treat
the token as compromised (and rotate it) if it was ever printed in a log or
terminal, or was previously passed on the command line.

### SRS and SRT relay config

The repository copies both runtime config files during install:
- `/etc/restream-srs/srs.conf`
- `/etc/restream-srs/srt-bonding-relay.json`

SRS only reads its config at startup, and the SRT bonding relay only reads its
JSON config file at startup.

The repo configs ship a public default SRT passphrase; on first install the
installer generates a random per-server secret and writes it to both files.
On reinstall it leaves each file's passphrase exactly as deployed — it
doesn't compare, regenerate, or sync the two. SRS rejects SRT connections
without the passphrase at the handshake, for publish and play alike; the
dashboard's SRT publish URLs include it.

To change or disable it, edit both files by hand and restart SRS and the
relay: `passphrase ;` in `srs.conf`, `"passphrase": ""` in
`srt-bonding-relay.json`. An empty value in both disables the passphrase
check entirely — SRS and the relay treat empty the same as unset.

Ingest is further locked down by SRS HTTP hooks handled by the app:
`on_publish` rejects unknown stream keys, and `on_play` rejects any play not
from loopback (only the app's own FFmpeg ever pulls streams), so the public
ports are ingest-only. See
[Known issues](#why-fail2ban-is-not-used) for why rejected attempts are logged
but not converted into firewall bans.

---

## Authentication

The dashboard is protected by a password. `dashboard_password` in `restream.json` is only the *initial* password: it is hashed into the database on first boot, and ignored whenever the database already has a password. The installer generates a random one on first install and keeps it on reinstall; if the field is absent (e.g. a dev checkout) the initial password is `admin`. Change it in **Settings → Change Password** after logging in — that updates the database only, not `restream.json`.

To reset a forgotten password:
```bash
sudo bash /opt/restream-srs/scripts/server-reset-password.sh
```
This clears the stored password and restarts the service, which re-seeds it from `dashboard_password` in `restream.json` (`admin` if unset).

---

## Security

**Dashboard/API auth is intentionally simple.** It's a single shared password
(see [Authentication](#authentication)) behind a session cookie — no
per-user accounts, no MFA, no CSRF token beyond `SameSite=Strict`, and the
app itself never terminates TLS (it's plain `app.listen` on 8080; the
cookie is only marked `Secure` when TLS is detected). That's a deliberate tradeoff, not an
oversight: this app is designed to be reached through a zero-trust tunnel
(e.g. Cloudflare Tunnel + Cloudflare Access) rather than exposed to the raw
internet. The tunnel is expected to provide TLS, identity-based access
control, and the real perimeter; the built-in password is just a lightweight
second factor for whoever's already authenticated through that layer, plus a
login-rate-limit (see `src/api/auth.ts`) against brute force if it's ever
reached directly. If you expose port 8080 straight to the internet instead
of through a tunnel, put a real reverse proxy (TLS + rate limiting) in front
of it rather than relying on the dashboard password alone.

Hardening that is on by default:
- **Sessions:** 7-day lifetime, stored only as SHA-256 hashes; changing the
  password signs out every other session; new passwords must be ≥ 12 characters;
  the cookie gets `Secure` when the request came over TLS (directly or via
  `X-Forwarded-Proto: https`). Logins, logouts and password changes are logged
  with the client IP.
- **Login rate limit:** 5 failures per minute per client, grouped per IPv6 /64.
  Behind a proxy set `trust_proxy`, or every user shares the proxy's address.
- **Headers:** `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`,
  `Referrer-Policy: no-referrer`. A full CSP is not possible until the dashboard's
  inline event handlers are removed.
- **Logs are not redacted:** journald, the diagnostics files, the output Error
  History and the dashboard keep FFmpeg's stderr as-is, including full
  destination URLs, stream keys and SRT passphrases. They are private to the
  server and its operators; redact before copying any of it into a commit or
  issue.
- **Output destinations and host probes:** the server will not connect to
  link-local/unspecified addresses (cloud metadata such as `169.254.169.254`), and
  loopback only on the app's own RTMP/SRT ports (pipeline-to-pipeline restreams).
  Hosts are resolved the way FFmpeg resolves them, so `2130706433` or `0x7f.1` are
  treated as loopback. Private LAN ranges and SRT `mode=listener` outputs are
  deliberately allowed. Outputs saved before the check existed are re-checked at
  startup and stopped, with the reason shown in the dashboard. Host probes never
  probe loopback. DNS that changes between the check and FFmpeg's own lookup
  cannot be ruled out.
- **HLS previews** require the session cookie, and a preview nobody is fetching or
  keeping alive for 20s is stopped (closing the tab stops it at once). A dashboard
  tab left in the background for several minutes loses its preview and shows it
  stopped.
- **Input bounds:** names are at most 80 characters with no control characters;
  destination URLs are at most 2048 characters with no whitespace or `< > "`;
  audio track counts/indexes are 0–49 (preview `audioTrackCount` 1–50); `publicHost`
  must be a hostname or IP. The dashboard escapes everything it renders on top of
  this. Existing longer names are kept but must comply when edited.
- **Installer ownership:** `/opt/restream-srs` is root-owned and read-only to the
  service user (root runs code from it on every update); the service user writes
  only to the data and config directories. `server-reset-password.sh` also signs
  out every existing session.
- **Hooks:** `/api/srs/*` is served only on `127.0.0.1:<hook_port>`; client IPs in
  hook bodies must be IP literals, so a request cannot forge log lines.

**RTMP/SRT ingest ports (21935, 10080, 10081) are different** — they have
to stay open to the raw internet so OBS/hardware encoders can reach them, so
they're hardened at the SRS/relay layer instead:
- SRT (`10080`, `10081`) requires a passphrase, checked at the handshake
  before a connection is accepted at all — see
  [SRS and SRT relay config](#srs-and-srt-relay-config).
- Every publish attempt (RTMP or SRT) is checked against a per-pipeline
  stream key via SRS's `on_publish` hook; unknown keys are rejected before
  any restream starts.
- `on_play` rejects any playback request not from loopback, so the public
  ports are ingest-only — nothing can pull a stream back out through SRS
  directly.
- RTMP listens on a non-default port (`21935`, not `1935`) to cut down on
  generic scanner noise.
- Rejected publish/play attempts are logged with the attempted stream name
  (repeated rejections of the same key are throttled to one line a minute),
  but this app does not install fail2ban; see [Known issues](#why-fail2ban-is-not-used).
- Rejected publishes also appear in the dashboard under the pipeline list
  ("Rejected publish attempts", kept for 5 minutes): one row per `keyNN` label,
  plus one aggregate "Unrecognized" row per protocol for empty or non-key
  stream names. The row shows how many distinct names it combines (counted by
  an in-memory hash, capped at 100); names are never shown or stored. An SRT encoder on a key with no pipeline
  still connects to the relay and can look healthy on its own side while SRS
  refuses the stream.
  Outside `on_play` rejections are listed too, marked "Play request": an SRT
  stream id without `m=publish` is a play request to SRS, so an encoder with an
  incomplete id lands there rather than in `on_publish`.

Never expose `1985` (SRS HTTP API) or `8081` (relay status) — the app only
talks to those over loopback.

---

## Usage

For how to publish to a pipeline (ffmpeg test commands for RTMP/SRT) and how
to configure translation outputs — which mix a separate translator pipeline's
audio into an output — see the in-app **User Manual** (the open-book icon in
the dashboard navbar). Translation output mixing, with per-track selection,
speech-detection ducking, and configurable delay/restore timing, is available
as a built-in audio encoding option on any output.

---

## API

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

---

## Development

Prerequisites: Node.js 22+ plus `curl`, `unzip`, `tar`, and `xz-utils`.

**1. Install dependencies and local media binaries:**
```bash
npm install
npm run dev-install   # downloads SRS and pinned FFmpeg into ./objs
```
Rerunning `npm run dev-install` also refreshes the sibling `../srt-bonding-relay`
repo when it has no local changes and rebuilds `./objs/srt-bonding-relay`.

To use a local SRS binary:
```bash
SRS_LOCAL_BIN=./build/srs npm run dev-install
```

The standalone relay now lives in the sibling `../srt-bonding-relay` repo during development and in `live-miracles/srt-bonding-relay` GitHub Releases for production installs.

**2. Start SRS** (terminal 1):
```bash
npm run srs           # runs ./objs/srs -c srs.conf in the foreground
```

**3. Start the SRT bonding relay** (terminal 2):
```bash
npm run relay         # runs the ./objs/srt-bonding-relay binary built by dev-install
npm run relay:update   # pulls the latest ../srt-bonding-relay source and rebuilds ./objs/srt-bonding-relay
```

The relay also exposes a local HTTP status endpoint on the default
`status_port` (`127.0.0.1:8081`) in development. The dashboard backend polls
that endpoint to show the top-level relay health and the per-pipeline
bonded-input status.

**4. Start the app** (terminal 3):
```bash
npm run dev           # tsx watch + tsc watch + tailwind watch
```

---

## Configuration

The app reads runtime settings from `restream.json` in the app root.

`restream.json`:

| Field | Default | Description |
|-------|---------|-------------|
| `port` | `8080` | App HTTP port |
| `hook_port` | `8082` | Loopback-only port for SRS's `on_publish`/`on_play` hooks. Must match the hook URLs in `srs.conf` |
| `trust_proxy` | `0` | Reverse-proxy hops whose `X-Forwarded-For` is trusted for client IPs (login rate limit, logs). Set `1` behind cloudflared/nginx; leave `0` when the port is reachable directly |
| `database_path` | `./db.sqlite` | SQLite database path |
| `srs_config_path` | `./srs.conf` | SRS config path |
| `ffmpeg_path` | `ffmpeg` | FFmpeg binary for outputs and previews |
| `ffprobe_path` | `ffprobe` | FFprobe binary for input media probing and validation |
| `dashboard_password` | `admin` | Initial dashboard password, used only when the database has no password yet (first boot or after a reset). Stored in plain text; the installer sets the file to mode `0600` |
| `output_watchdog.warmup_ms` | `90000` | Warmup before stall checks, shared by the output progress watchdog and the translation-mixer watchdogs below |
| `output_watchdog.stall_ms` | `45000` | Output progress stall window before restarting FFmpeg |
| `output_watchdog.translator_meter_stale_ms` | `10000` | How long a translation output's translator audio meter can go quiet (including never producing a sample) before the mixer is restarted |
| `output_watchdog.interval_ms` | `5000` | Output watchdog polling interval |
| `output_watchdog.socket_warmup_ms` | `15000` | Socket watchdog warmup before socket-state checks |
| `output_watchdog.socket_grace_ms` | `30000` | Socket warning grace window before restarting FFmpeg |
| `output_watchdog.memory_limit_mb` | `200` | FFmpeg RSS limit (MB) before an output is killed and restarted; applies to `copy` and any `videoEncoding` not listed below |
| `output_watchdog.memory_limit_mb_by_encoding` | `{vertical_rotate: 450, "720p": 650, "1080p": 950}` | Per-`videoEncoding` RSS limit override (MB); libx264 transcode profiles run at a much higher legitimate baseline than `copy` |

Relative file paths are resolved from the app root. Command names like `ffmpeg`
and `ffprobe` are left as command names.

SRS values are inferred from `srs.conf`:
- RTMP pull/publish port from top-level `listen`
- SRT pull/publish port from `srt_server { listen ... }`
- SRS HTTP API port from `http_api { listen ... }`
- SRS log tail path from `srs_log_file`, if present — otherwise the dashboard
  falls back to `journalctl -u srs.service` (production's `srs.conf` logs to
  console/journald instead of a file; only local dev's still sets `srs_log_file`)

The dashboard's own log and the relay's log are always read via
`journalctl -u restream-srs.service` / `-u srt-bonding-relay.service` — both only
ever log to the journal. All three require `restream-srs.service`'s
`SupplementaryGroups=systemd-journal` (set by `server-install.sh`); without it,
the Server Logs view shows no output for whichever service's journal it can't read.

The control plane also writes structured diagnostics to
`/var/lib/restream-srs/diagnostics/` in production. The rotated JSONL files keep
output starts/exits/restarts, SRS and relay transitions, input and bonded-leg
transitions, and FFmpeg timestamp/media-clock warnings for seven days (the last
ffmpeg stderr tail at exit is included on the exit event; raw stderr isn't
streamed to diagnostics to keep incident volume from crowding out the window;
timestamp warnings are aggregated as described under
[Input timestamp fault detection](#input-timestamp-fault-detection)).
Once per minute it also stores compact health snapshots containing SRT counters,
leg rates/health, relay forwarding state, and FFmpeg output progress so an
incident can be investigated after the live one-hour chart window has passed.
The snapshots also record resource usage: per-output FFmpeg RSS/CPU and memory
limit (translation mixers included), CPU and RSS for the Node control plane
(plus its V8 heap), SRS and the SRT relay (the same samples the dashboard
shows, up to ~10 s old), and host total/available memory and swap. Separately,
`host-memory-low` (available memory under 15% of total) and
`host-memory-recovered` (back above 20%) events are logged on transition, the
former with the five largest processes by RSS.
Files are
rotated daily or at 100 MB, whichever comes first, with a 5 GB total diagnostics
cap that removes the oldest rotated files first. The installer configures
persistent journald with a seven-day retention limit, 1 GB system journal cap,
256 MB runtime cap, and one-day journal file rotation.

Relay ports and status polling are read from `srt-bonding-relay.json`, located beside `srs_config_path`.

Installer/development overrides:

| Variable | Used by | Description |
|----------|---------|-------------|
| `REPO_URL` | `server-install.sh` | Repository URL cloned into `/opt/restream-srs` on first install |
| `SRT_RELEASE_TAG` | `server-install.sh` | Relay GitHub release tag to install |
| `SRT_URL` | `server-install.sh` | Custom relay release archive URL |
| `SRT_SHA256` | `server-install.sh` | Expected SHA256 for the relay archive; blank skips verification |
| `WIPE_DB` | `server-install.sh` | Set `y`/`n` to force or skip wiping the existing SQLite DB |
| `SRS_LOCAL_BIN` | `dev-server-install.sh` | Local executable SRS binary to copy into `./objs/srs` |

## Known issues

### Short CPU spikes from host package inventory checks every 10 min

On GCP Ubuntu hosts, `google-osconfig-agent.service` may periodically run
`apt-get update` / package inventory checks and briefly consume a large fraction
of one vCPU. On a 4-vCPU VM this can show up as a ~25% CPU spike. This is host
maintenance noise, not a restream pipeline failure.

Temporary live-event mitigation, cleared automatically on reboot:

```bash
sudo systemctl stop google-osconfig-agent.service
sudo systemctl mask --runtime google-osconfig-agent.service
```

If Ubuntu Pro APT/ESM jobs are also noisy:

```bash
sudo systemctl mask --runtime apt-news.service esm-cache.service
```

This temporarily affects GCP OS patch/inventory reporting or Ubuntu Pro update
messaging; re-enable after the event or reboot.

### SRS `srt_to_rtmp` produces breaking audio (avoided, not used)

SRS's native `srt_to_rtmp` feature (which remuxes an SRT publish into the RTMP
layer so it can be played back over RTMP/HLS) emits audio with bursty,
discontinuous timestamps — roughly 60 ms gaps between 21 ms packets. The
resulting RTMP/HLS plays with constantly breaking/crackling audio, and because
RTMP/FLV carries only one audio stream it also collapses a multi-track SRT source
to a single track. No combination of SRS settings (`hls_dts_directly`, etc.) made
the audio clean.

**How it's avoided:** `srt_to_rtmp` is turned **off** in `srs.conf`. SRT inputs
stay in the native SRT/MPEG-TS domain and are pulled back over SRT (raw MPEG-TS),
which preserves every audio track and keeps timestamps intact; the HLS preview is
generated by the app's own ffmpeg rather than SRS's native HLS. RTMP inputs are
unaffected — they never went through `srt_to_rtmp` — and are pulled over RTMP.

### SRS logs `SRTS_BROKEN` errors for every SRT play disconnect, including clean ones

The SRS log fills with `srt serve error code=6001(SrtIo)(SRT read or write failed) :
srt play recv thread : ... socket status=SRTS_BROKEN` at a steady background rate.
This is expected noise, not an incident: it fires on **every** teardown of an SRT
play (pull) connection — including the ffprobe media check this app runs when a
publisher connects to an SRT input, and its retries every
`FFPROBE_FAILED_REFRESH_MS` while that probe keeps failing — not just on
genuine connection failures.

Confirmed in SRS 6.0 source (`src/app/srs_app_srt_conn.cpp`,
`src/protocol/srs_protocol_srt.cpp`): `SrsMpegtsSrtConn::cycle()` logs at
`srs_error()` for any non-success return from the play loop, with no branch for
"peer closed cleanly" vs. "connection broke" — and the SRT recv thread treats any
non-timeout `read()` result (including a normal peer disconnect) as a hard error
that propagates up to that log call. `check_error()` just stringifies whatever
`srt_getsockstate()` reports at that instant, and libsrt sets a torn-down read-side
socket to `SRTS_BROKEN` regardless of how gracefully the peer closed.

**No client-side fix exists.** SRT socket options like `linger` only affect
how the *closing side* waits to flush unsent data — since ffprobe is a
receive-only client, they don't change what SRS observes or logs. This was
verified by adding `&linger=1` to the ffprobe pull URL and confirming SRS still
logged `SRTS_BROKEN` on every probe close. Fixing this would require patching
and rebuilding SRS itself.

**Mitigation:** filter `SRTS_BROKEN` / `srt play recv thread` lines out of log
monitoring/alerting rather than treating them as incidents.

### Translation output recovery after a translator SRT disconnect is slow

When a translation output's translator input drops, the source's ducked
volume does not recover for tens of seconds — sometimes a minute or more.
Reconnecting the translator is fast by comparison (a few seconds). This
asymmetry is expected: connecting is an edge-triggered, unambiguous event (a
new publish is immediately visible), but disconnecting is inferred from
absence, which SRS can't trust right away — the app only reacts once its
health poll observes SRS's own stream list as gone, and SRS itself only
concludes an SRT peer is dead after its `srt_server.peer_idle_timeout`
elapses with nothing received, confirmed via `SRTS_BROKEN` in the SRS log
(see the entry above). In the rarer case where the translation mixer's own
FFmpeg process also stalls (rather than just losing the translator leg
cleanly), recovery instead waits on the coarser output-progress-stalled
watchdog (`stallMs`, default 45s) to restart it.

**Why this is not tuned lower.** `peer_idle_timeout` is a single setting on
SRS's shared SRT listener — it applies to every SRT input, not just
translators, including the main broadcast source. SRT exists specifically to
tolerate lossy/unstable networks; shortening this timeout to speed up
translator recovery would risk the main source being torn down on a brief,
real network blip during a live event. A translator SRT drop is rare, and
the output degrades gracefully in the meantime (it keeps publishing source
audio throughout), so that tradeoff is not worth the risk to the primary
broadcast path.

**Mitigation:** none needed — the output stays up on source audio for the
entire gap. If translator disconnects become frequent enough to matter,
investigate the translator's own network path rather than this timeout.

### Translation sync is only tight for SRT sources

Translation pipelines are meant to use SRT inputs. With an SRT source the
mixed output keeps the source and translator within a fraction of a second
(measured ~0 s, or up to ~0.7 s translator-behind when the translator also
sends video), before the configured translation delay is added. This relies
on the mixer opening the translator first with a short probe; see the comment
in `buildTranslationMixerArgs`.

An RTMP source still works, but SRS's GOP cache makes every new RTMP player
start at the last keyframe, so the source can trail the translation by up to
its keyframe interval (measured −2.2 s to +0.2 s with a 2 s GOP), varying per
mixer start. This is not compensated: doing so would mean either disabling
SRS's GOP cache globally (slower start/restart for every output and preview)
or estimating the offset at runtime inside a live process.

**Mitigation:** use SRT for translation sources. If RTMP is unavoidable, a
1 s keyframe interval on the encoder keeps the error near 1 s.

### Watchdogs

The app runs these recovery loops:

| Watchdog | Scope | Restart condition | Notes |
|----------|-------|-------------------|-------|
| Health poll / input recovery | SRS reachability, live pipeline inputs, desired running outputs | When SRS and the pipeline input become ready, outputs whose desired state is `running` are started or restarted with staggered timing | Computed once every 5s and shared by dashboard clients. Inputs become live from SRS publisher presence; ffprobe fills in media/track metadata and retries every `FFPROBE_FAILED_REFRESH_MS` until it succeeds, then stops for that publisher. |
| Output progress watchdog | Every running FFmpeg output process | After warmup, if the input is ready but FFmpeg `total_size` / `out_time_ms` stop advancing for the configured stall window | Protocol-agnostic backstop; covers SRT outputs and local RTMP relays |
| Remote RTMP socket watchdog | Running outputs with a remote RTMP/RTMPS destination | After socket warmup and grace, if the destination socket is missing or remains in a closing state such as `CLOSE-WAIT` | Uses one `ss -H -tanp` snapshot per watchdog interval; a local RTMP/RTMPS destination is ignored because local input/output sockets are ambiguous |
| Output memory watchdog | Every running FFmpeg output process, including translation mixers (checked every 5 s; a mixer over its limit is restarted with a `translation-mixer-restart` event, reason `memory limit exceeded`) | After warmup, if process RSS crosses `memory_limit_mb` (or its per-encoding override) | Reads `/proc/<pid>/status`; unconditional — a leaking process can still show advancing `total_size`/healthy sockets, so this doesn't wait on the other two. Once RSS crosses 70% of the limit the output surfaces a yellow "High memory usage" warning in the dashboard, before the watchdog actually restarts it at 100%. The limit is doubled for outputs on a 4K (≥3840px on either dimension) input — the 2x multiplier is a placeholder, not a measured baseline; see [#11](https://github.com/live-miracles/restream-srs/issues/11) |
| Translator audio meter watchdog | Running translation-mixer outputs | After the same startup warmup grace as the output progress watchdog, if the translator audio meter has gone quiet for `translator_meter_stale_ms` (including a translator that never delivered a single sample) | Watches independently of the SRS live-state poll, so a translator that connects but sends a dead/silent track is still caught. Valid translator silence is not treated as a disconnect — FFmpeg continues emitting silent meter samples in that case — so this only fires when the meter itself stops updating. Restarts the mixer so it attaches to the current translator session. |

All output watchdogs above use the same restart path: they write a detailed
`last_error`, kill the stuck FFmpeg process, and let the normal retry loop start a
fresh process while the output's desired state remains `running`. The socket
watchdog is advisory: if `ss` fails or times out, it does not restart anything,
and a socket warning does not prevent the other watchdogs from acting.

Input media validation is separate from the output watchdogs. The health service
stays on the regular 5s poll, but ffprobe backs off once a publisher's probe
succeeds:

| Input check | Scope | Cadence | Notes |
|-------------|-------|---------|-------|
| Media validation | Connected RTMP/SRT inputs without a successful probe yet for this publisher | Immediate probe (staggered across pipelines), then retried every `FFPROBE_FAILED_REFRESH_MS` (30s) while it keeps failing | Stops re-probing once a probe succeeds for the current publisher; a new probe cycle starts on the next publisher change. Every failed probe is written to diagnostics as `media-probe-failed` (reason `timeout`/`exit`/`parse`/`unusable`, elapsed time, exit status, ffprobe stderr tail) and the first failure and the later recovery per publisher are added to the pipeline log (`probe_failed` / `probe_recovered`). Input liveness and output recovery do not wait for a valid ffprobe result — ffprobe fills in media/track details when available. |

### Input timestamp fault detection

The server detects when an input's audio/video timestamps become inconsistent
(for example after an encoder drops and reconnects with its audio and video
clocks out of step). FFmpeg reports this on every copy output as
`timestamp discontinuity` / non-monotonous or invalid DTS warnings, at up to tens
of lines per second per output, so the control plane groups them instead of
logging each line:

| Stage | Trigger | What is recorded and shown |
|-------|---------|----------------------------|
| Warning | First timestamp warning of a kind on an output | `ffmpeg-timestamp-warning` diagnostics event with the FFmpeg line (one per distinct kind per burst, at most 8); the output shows a yellow warning |
| Summary | Further warnings in the same burst | One `ffmpeg-timestamp-warning-summary` event every 30 s with the suppressed line count per kind, so the volume stays small while the total stays exact |
| Recovered | No timestamp warning for 30 s | `ffmpeg-timestamp-recovered` event with duration and total count. If the process exits mid-burst, the burst's duration and count are added to the `ffmpeg-exited` event instead |

Decode-error lines (`non-existing PPS`, `decode_slice_header error`, `corrupt
input`) go through the same grouping, but are treated as less serious, since
they also appear briefly when an output joins mid-GOP: FFmpeg probes the
stream before the next keyframe has delivered SPS/PPS, so for a second or two
it cannot decode and prints these lines (even in copy mode). This is expected
and harmless. A decode-only burst shorter than 10 s is treated as this routine
join noise: it is not shown on the output card and not written to History (the
diagnostics events still record it). Longer ones are shown and recorded.

Warnings stay output warnings: there is deliberately no pipeline-level "input is
unstable" alert, and nothing is written to the pipeline **History** (which is for
input and pipeline issues only), because the cause (encoder, network, relay or the
output itself) cannot be told from the warnings alone. Each finished burst (a
timestamp burst, or a decode-only burst of 10 s or more; stopped after 30 s of
quiet, or ended with the ffmpeg exit) is recorded in the output's own **Error
History** (the error button on the output) as a `warning` record with the duration,
warning count and first line. Per output, each class of burst is recorded at most
once per 10 minutes, and the diagnostics events always carry every burst. That
history keeps the last 10 records per output, of which at most 5 may be warnings, so
warnings can never push crashes and stops out; warnings never count as the output's
current error. Crashes, watchdog restarts and stops are recorded there as before.

The warnings that otherwise only show on the output card are recorded the same way,
once per episode: high memory usage (70 % or more of the output's limit), an
unhealthy destination socket, and the FFmpeg media clock running fast. An episode
logs an `ffmpeg-warning-started` diagnostics event, and when it clears (or the
process exits) an `ffmpeg-warning-ended` event with the duration plus one `warning`
record in the output's Error History. These share the 5 warning slots and the
10-minute-per-kind limit above. A warning that escalates to a watchdog restart
therefore appears twice: the build-up as a `warning`, then the restart as a crash.

This is detection and reporting only: outputs are not restarted automatically,
because the offset originates in the incoming stream and restarting would drop
the destination connections during a live event. The fix is on the encoder side; in the
observed incident, reconnecting the encoder cleared the condition.

### Outputs are not restarted when the encoder restarts, and a restart cannot be told apart from a network drop

When an encoder stops and reconnects (for example a manual ffmpeg restart), the
pipeline's input reconnects but its **outputs keep running and are not restarted**.
If the encoder's timeline restarted (timestamps back near 0), the running outputs
see a discontinuity and may log timestamp warnings until the condition clears (see
[Input timestamp fault detection](#input-timestamp-fault-detection)); restarting the
outputs by hand clears it, at the cost of dropping the destination connections.

Restarting outputs automatically whenever the input restarts is **not implemented**
because the server cannot reliably tell an encoder restart from a network
interruption, and restarting after a mere network drop would add downtime to a line
that would otherwise have recovered on its own. This was tested (SRS 6.0.184 and the
SRT bonding relay, RTMP, SRT and bonded SRT inputs; network faults simulated with a
userspace proxy that silently drops traffic, not kernel firewall rules, so RST/ICMP
failures and NAT remapping were not covered) and **no deterministic signal exists**:

- **Source ports do not distinguish them.** Every new connection gets a fresh
  ephemeral source port — on every bonded leg too — whether the encoder was restarted
  or reconnected after an outage. A port only survives when the connection never
  broke (an SRT outage shorter than about 5 s causes no disconnect and no event).
- **SRS hooks carry no cause.** `on_publish` / `on_unpublish` / `on_close` include the
  client id, IP, stream and `tcUrl`, but no port and no reason.
- **A killed or crashed encoder looks like a network loss.** For SRT the server sees
  about 5 s of silence followed by `6002 SrtTimeout` in both cases. (Over RTMP a
  killed process still closes its TCP connection, so it looks like a clean stop, while
  a network loss is only detected after about 18 s.)
- **Behind the bonding relay SRS sees nothing useful.** The relay always closes its
  downstream side gracefully, so SRS logs the same `6001 SrtIo` for every end of a
  bonded stream. Only the relay's own data differs.

Only weak, heuristic signals exist: a graceful stop closes within about a second
whereas a network loss or kill closes after about 5 s (SRT) or about 18 s (RTMP) of
silence, and on a bonded input a single leg disappearing from the relay's `/status`
while the group stays up points to a network problem on that leg rather than a
restart. These are not reliable enough to trigger an output restart on. A more
dependable basis for any future automatic restart would be the media timeline itself
(did timestamps jump or reset on reconnect?) rather than guessing the cause.

### SRT bonding relay

The relay exists to work around two constraints:

1. **ffmpeg cannot accept bonded SRT group connections.** ffmpeg's SRT handler does not set `SRTO_GROUPCONNECT=1` on its listener socket, so bonded connection attempts from encoders like AJA Bridge Live are rejected at the handshake level.

2. **SRS has no native SRT bonding support.** SRS accepts normal SRT publishers, but it does not accept bonded/redundant SRT groups directly.

**How it is fixed:** `srt-bonding-relay` starts as its own systemd service, listens on `10081` with `SRTO_GROUPCONNECT=1`, accepts each bonded source session, reads its incoming `streamid`, and opens a normal SRT publisher connection to SRS using the same `streamid`. It only connects to SRS after an encoder connects, so SRS's idle-publisher timeout is not triggered by an empty boot-time publisher.

### SRT-input output stalls are recovered by a watchdog

The input is pulled back over its own protocol, so an output on an **SRT input**
always pulls over SRT. When the destination rejects such a stream (e.g. a wrong
YouTube stream key) or drops the RTMP connection mid-publish, ffmpeg can get
stuck instead of exiting. An output on an **RTMP input** (pulled over RTMP)
usually exits ffmpeg immediately with a clear error (`Error opening output files:
Input/output error`).

The difference is timing: with RTMP pull, input stream info is available right
away, so ffmpeg opens the destination immediately and the rejection surfaces at
`write_header` time, exiting non-zero. With SRT pull, ffmpeg must first probe the
MPEG-TS input; by the time it connects, the destination accepts the handshake
then drops the connection mid-publish, and ffmpeg deadlocks — SRT's large input
buffers keep the input thread fed, so the broken-pipe error on the output write
may not propagate promptly. The process can stay alive while buffering input and
consuming RAM even though the external output is no longer uploading.

**How it is handled:** the output service tracks ffmpeg's `-progress pipe:1`
fields (`total_size`, `out_time_ms`, and `bitrate`) plus the stderr tail. It also
takes a single local TCP socket snapshot (`ss -H -tanp`) every watchdog interval
and maps RTMP/RTMPS destination sockets back to each ffmpeg pid. After a warmup
period, an output is marked yellow if its destination socket is missing or in a
closing state such as `CLOSE-WAIT`; if that persists past the socket grace
window, the watchdog records `last_error`, kills that ffmpeg process, and lets
the normal retry loop start a fresh output. The same retry path is used when the
input is live but ffmpeg output bytes/time stop advancing for a sustained window.
The dashboard shows the warning/restart reason and timestamp; the error details
include the pid, stall duration, last ffmpeg progress values, and stderr tail.

**Limitation:** the watchdog monitors aggregate ffmpeg output progress and
pid-level TCP socket state for the process. Local RTMP/RTMPS outputs are excluded
from the TCP socket check because ffmpeg's local input pull and local output push
both connect to local SRS and are ambiguous in `ss`; those relays are still
covered by the output-progress watchdog.

### A corrupt input can make an FFmpeg output leak memory (capped by a watchdog)

On a glitchy SRT input (real packet loss/corruption upstream, not a passphrase or
config issue — see the incident write-up below), FFmpeg's AAC decoder can
misparse a corrupted frame as a bogus multichannel layout (logged as `[SWR]
Full-on remixing from 22.2 has not yet been implemented!`). Reinitializing the
resampler for that bogus layout leaks memory instead of failing cleanly, and RSS
can grow unbounded — observed reaching 1.5-1.6GB before the kernel OOM-killer
stepped in.

That kernel-level kill is the actual danger, not the leak itself: FFmpeg output
processes share a cgroup with the `restream-srs` control-plane service, so
systemd treats any OOM kill inside that cgroup as the whole service failing and
restarts it — which cascades (via `Requires=`) into restarting SRS and the SRT
bonding relay too, forcing every stream on the box to reconnect simultaneously.
That mass reconnect can reintroduce the same corrupt-resync conditions on another
output, repeating the cycle. Full timeline and log evidence from the 2026-07-10
incident: [`fail-reports/2026-07-10-pipeline1-output-oom-cascade.md`](fail-reports/2026-07-10-pipeline1-output-oom-cascade.md).

**How it is handled:** two layers. `buildFfmpegArgs` passes `-fflags
+discardcorrupt -err_detect crccheck+bitstream` so packets already flagged
broken by the demuxer are dropped before reaching the decoder, reducing (but not
eliminating) the chance of the misparse happening at all. As a hard backstop,
the output memory watchdog (see the watchdogs table above) kills and restarts an
output once its RSS crosses `memory_limit_mb` (default 500MB — roughly 6-8x a
healthy output's normal 65-90MB baseline, and far below the 1.5GB+ range where
the kernel OOM-killer struck) — well before the kernel ever needs to get
involved, so the cascading restart doesn't happen.

### Why fail2ban is not used

This repo intentionally does not install or manage fail2ban. Earlier versions
used it as a narrow RTMP/app-hook protection, but it added root-owned config,
sudo helper scripts, dashboard whitelist/status UI, and extra test surface while
leaving the most important SRT gap uncovered.

Neither SRT listener logs a bad-passphrase rejection in a form fail2ban could
act on:

- SRS's own SRT server (port `10080`) rejects handshakes that fail its
  `passphrase` check — either the peer declares no encryption at all, or
  declares it but `SRTO_ENFORCEDENCRYPTION` fails the key exchange. Either
  way, the rejection happens *inside* the SRT handshake, before
  `srt_accept()` returns, so SRS's own log (`ERROR:UNSECURE` / "Password
  required or unexpected") never records the peer's IP.
- `srt-bonding-relay`'s listener (port `10081`) used to log a matchable
  `[srt-relay] rejected connection (bad passphrase) from <HOST>` line from
  its own `srt_accept()` KMSTATE check, and a dedicated `srt-bonding-relay`
  fail2ban jail watched it. As of `srt-bonding-relay` v2.1.0 that line is no
  longer logged, so a jail would have nothing left to match.

The app still logs rejected `on_publish` and `on_play` attempts (publish
rejections are throttled per key, so a jail would see fewer lines), which would be
enough for a fail2ban jail covering repeated bad RTMP stream-key attempts from
the same IP. That protection is intentionally not included because it is only a
partial defense: it does not cover SRT bad passphrases, does little against
distributed attackers, and is not a replacement for a proper edge/firewall
deployment for high-risk events.

This is not believed to be a practical brute-force risk: the configured
passphrase is a long random string, and each guess requires a live SRT handshake
round trip, so online guessing is computationally infeasible regardless of
banning. The real effect is possible log/CPU noise from a misconfigured device
or scanner retrying indefinitely. For small events, keep the deployment simple
and rely on strong stream keys, a strong SRT passphrase, and the non-default RTMP
port. For larger or higher-risk events, keep the origin private and put a
media-aware ingest edge or provider firewall/DDoS layer in front of it.
