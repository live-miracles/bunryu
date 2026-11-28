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
- **Login rate limit:** 5 failures per minute per client, grouped per IPv6 /64. A wrong current
  password on a password change counts as a failure too.
  Behind a proxy set `trust_proxy`, or every user shares the proxy's address.
- **Headers:** `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`,
  `Referrer-Policy: no-referrer`, a `Permissions-Policy` that turns off camera,
  microphone, location and payment, `Cross-Origin-Resource-Policy: same-origin`,
  `Strict-Transport-Security` when the request came over TLS, and `Cache-Control:
  no-store` on every `/api` answer (they carry stream keys and the SRT passphrase). A
  full CSP is not possible until the dashboard's inline event handlers are removed.
- **Cross-site writes:** a `POST`/`DELETE` that the browser marks `Sec-Fetch-Site:
  cross-site` or `same-site` is refused with 403, on top of the `SameSite=Strict`
  cookie. Requests without that header (scripts, `curl`) are unaffected.
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
- **Restream loops are marked, not refused.** An output that publishes into `live/<key>` on
  this server's own RTMP/SRT port (loopback or one of the machine's own addresses) when
  the key is its own pipeline's input, or the chain of such outputs leads back to it, is
  saved and shows a warning on its card. SRS refuses a second publisher on a live key
  (observed for an output into its own pipeline's key), so such an output fails and
  retries without touching the input. Outputs of that kind that are running
  are stopped at startup with the reason shown. A public address that is NAT-ed to this
  machine and is not on one of its interfaces looks like a remote host and is not
  recognised.
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
  only to the data and config directories, and the installer reads and writes the
  files in them only as that user, so a symlink planted there cannot redirect a
  root write. It names any file there not owned by the service user (one edited
  with `sudo` and saved as a new file, say) instead of taking it over.
  `server-set-password.sh` also signs out every existing session.
- **Key Vault reports (optional):** once the link is set in Settings the app makes one
  outbound HTTPS request a minute, carrying the bearer token. The URL must be `https`
  (plain `http` only for localhost) and must not resolve to a link-local or unspecified
  address, no redirect is followed, and the token and hash secret (derived from the secret
  you enter, which is not itself stored) are kept in the
  database, never returned by the API or the dashboard and never logged. Destinations
  leave the server only as an HMAC hash, and error text has URLs, passphrases and
  keys removed (see [Configuration](3-configuration.md#key-vault-status-reporting)).
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

The dashboard is protected by a password, stored only as a salted scrypt hash in the database, never in a file. A fresh install asks for it (or takes `BUNRYU_DASHBOARD_PASSWORD` for an unattended install) and fails before changing anything if there is none; it never generates or prints a password, so none ends up in install logs. A reinstall that keeps the database needs none. The Docker image takes `BUNRYU_DASHBOARD_PASSWORD` on its first start, and the app itself exits with status 78 (not restarted by systemd) if it finds an empty database and no password; there is no default password. Change it in **Settings → Change Password** after logging in.

To set a new password when it has been forgotten:
```bash
sudo bash /opt/bunryu/scripts/server-set-password.sh
```
It asks for the new password, signs out every session and restarts the dashboard service. In Docker, run `docker exec -it -e BUNRYU_DASHBOARD_PASSWORD= bunryu node /app/dist/setPassword.js`, then `docker restart bunryu`.
