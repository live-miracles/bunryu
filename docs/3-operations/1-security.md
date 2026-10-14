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
  [SRS and SRT relay config](../1-getting-started/3-install.md#srs-and-srt-relay-config).
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
  but this app does not install fail2ban; see [Why fail2ban is not used](#why-fail2ban-is-not-used).
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

The dashboard is protected by a password. `dashboard_password` in `restream.json` is only the *initial* password: it is hashed into the database on first boot, and ignored whenever the database already has a password. The installer generates a random one on first install and keeps it on reinstall; if the field is absent (e.g. a dev checkout) the initial password is `admin`. Change it in **Settings → Change Password** after logging in — that updates the database only, not `restream.json`.

To reset a forgotten password:
```bash
sudo bash /opt/restream-srs/scripts/server-reset-password.sh
```
This clears the stored password and restarts the service, which re-seeds it from `dashboard_password` in `restream.json` (`admin` if unset).

## Why fail2ban is not used

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
