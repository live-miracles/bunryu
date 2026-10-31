# Security

**Dashboard/API auth is intentionally simple.** It's a single shared password
(see [Authentication](#authentication)) behind a session cookie — no
per-user accounts, no MFA, no CSRF token beyond `SameSite=Strict`, and the
app itself never terminates TLS (it's plain `app.listen` on 8080; the
cookie is only marked `Secure` when TLS is detected). That's a deliberate tradeoff, not an
oversight: this app is designed to be reached through a zero-trust tunnel
(e.g. Cloudflare Tunnel + Cloudflare Access; see [Remote access](2-remote-access.md)) rather than exposed to the raw
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
- **Logs are not redacted:** journald, the diagnostics files, the output History
  and the dashboard keep FFmpeg's stderr as-is, including full
  destination URLs, stream keys and SRT passphrases. They are private to the
  server and its operators; redact before copying any of it into a commit or
  issue.
- **FFmpeg gets a minimal environment:** output, preview and probe
  processes receive only `PATH`, `LANG`, `LC_ALL`, `TZ`, `SSL_CERT_FILE`,
  `SSL_CERT_DIR` and `LD_LIBRARY_PATH`. The app's own variables, such as
  `BUNRYU_DASHBOARD_PASSWORD`, stay out of the `/proc/<pid>/environ` of every
  FFmpeg process.
- **Output destinations:** the server will not connect to
  link-local/unspecified addresses (cloud metadata such as `169.254.169.254`), and
  loopback only on the app's own RTMP/SRT ports (pipeline-to-pipeline restreams).
  Hosts are resolved the way FFmpeg resolves them, so `2130706433` or `0x7f.1` are
  treated as loopback. Private LAN ranges and SRT `mode=listener` outputs are
  deliberately allowed. Outputs saved before the check existed are re-checked at
  startup and stopped, with the reason shown in the dashboard. DNS that changes between the check and FFmpeg's own lookup
  cannot be ruled out.
- **Restream loops are refused.** An output that publishes into `live/<key>` on this
  server's own RTMP/SRT port (loopback or one of the machine's own addresses) is
  rejected when the key is its own pipeline's input or when the chain of such
  outputs leads back to it. Outputs saved before the check existed are stopped at
  startup with the reason shown. A public address that is NAT-ed to this machine and
  is not on one of its interfaces looks like a remote host and is not recognised.
- **The `internal` RTMP app is reserved for shared encodes.** Outputs cannot
  target it (any host spelling that resolves to this machine, with a path under
  `/internal/`), and SRS's publish hook accepts that app only over RTMP from
  loopback and only for a running shared encode. A pipeline key published there,
  or any other name, is refused like an unknown key.
- **HLS previews** require the session cookie, and a preview nobody is fetching or
  keeping alive for 20s is stopped (closing the tab stops it at once). A dashboard
  tab left in the background for several minutes loses its preview and shows it
  stopped.
- **Input bounds:** names are at most 80 characters with no control characters;
  destination URLs are at most 2048 characters with no whitespace or `< > "`;
  audio track counts/indexes are 0–49 (preview `audioTrackCount` 1–50); `publicHost`
  must be a hostname or IP. The dashboard escapes everything it renders on top of
  this. Existing longer names are kept but must comply when edited.
- **Installer ownership:** `/opt/bunryu` is root-owned and read-only to the
  service user (root runs code from it on every update); the service user writes
  only to the data and config directories. `server-reset-password.sh` also signs
  out every existing session.
- **Hooks:** `/api/srs/*` is served only on `127.0.0.1:<hook_port>`; client IPs in
  hook bodies must be IP literals, so a request cannot forge log lines.

**RTMP/SRT ingest ports (21935, 10080, 10081) are different** — they have
to stay open to the raw internet so OBS/hardware encoders can reach them, so
they're hardened at the SRS/relay layer instead:
- SRT (`10080`, `10081`) requires a passphrase, checked at the handshake
  before a connection is accepted at all. It can be replaced from Settings; see
  [SRS and SRT relay config](../1-getting-started/3-install.md#srs-and-srt-relay-config).
- Every publish attempt (RTMP or SRT) is checked against a per-pipeline
  stream key via SRS's `on_publish` hook; unknown keys, and any app other than
  `live`, are rejected before any restream starts.
- `on_play` rejects any playback request not from loopback, so the public
  ports are ingest-only — nothing can pull a stream back out through SRS
  directly.
- RTMP listens on a non-default port (`21935`, not `1935`) to cut down on
  generic scanner noise.
- Rejected publish/play attempts are logged with the attempted stream name
  (repeated rejections of the same key are throttled to one line a minute),
  but this app does not install fail2ban; see [Don't ban abusive ingest clients with fail2ban](../4-reference/3-design-decisions.md#dont-ban-abusive-ingest-clients-with-fail2ban).
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

## Authentication

The dashboard is protected by a password. `dashboard_password` in `bunryu.json` is only the *initial* password: it is hashed into the database on first boot, and ignored whenever the database already has a password. The installer requires one on a fresh install (`BUNRYU_DASHBOARD_PASSWORD`, or `dashboard_password` in `/etc/bunryu/bunryu.json`) and fails before changing anything if there is none; it never generates or prints a password, so none ends up in install logs. A reinstall that keeps the database needs none. The Docker image works the same way, and the app itself exits with status 78 (not restarted by systemd) if it finds an empty database and no password; there is no default password. Change it in **Settings → Change Password** after logging in — that updates the database only, not `bunryu.json`.

To reset a forgotten password, set `dashboard_password` in `/etc/bunryu/bunryu.json`, then:
```bash
sudo bash /opt/bunryu/scripts/server-reset-password.sh
```
This clears the stored password and restarts the service, which re-seeds it from `dashboard_password` in `/etc/bunryu/bunryu.json`. The script refuses to run when that field is empty.
