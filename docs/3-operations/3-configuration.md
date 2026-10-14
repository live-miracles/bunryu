# Configuration

The app reads runtime settings from `bunryu.json` in the app root.

`bunryu.json`:

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
`journalctl -u bunryu.service` / `-u srt-bonding-relay.service` — both only
ever log to the journal. All three require `bunryu.service`'s
`SupplementaryGroups=systemd-journal` (set by `server-install.sh`); without it,
the Server Logs view shows no output for whichever service's journal it can't read.

The control plane also writes structured diagnostics to
`/var/lib/bunryu/diagnostics/` in production. The rotated JSONL files keep
output starts/exits/restarts, SRS and relay transitions, input and bonded-leg
transitions, and FFmpeg timestamp/media-clock warnings for seven days (the last
ffmpeg stderr tail at exit is included on the exit event; raw stderr isn't
streamed to diagnostics to keep incident volume from crowding out the window;
timestamp warnings are aggregated as described under
[Input timestamp fault detection](4-reliability.md#input-timestamp-fault-detection)).
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
| `REPO_URL` | `server-install.sh` | Repository URL cloned into `/opt/bunryu` on first install |
| `SRT_RELEASE_TAG` | `server-install.sh` | Relay GitHub release tag to install |
| `SRT_URL` | `server-install.sh` | Custom relay release archive URL |
| `SRT_SHA256` | `server-install.sh` | Expected SHA256 for the relay archive; blank skips verification |
| `WIPE_DB` | `server-install.sh` | Set `y`/`n` to force or skip wiping the existing SQLite DB |
| `SRS_LOCAL_BIN` | `dev-server-install.sh` | Local executable SRS binary to copy into `./objs/srs` |
