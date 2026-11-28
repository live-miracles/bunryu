# Security review

This page is the security assessment of Bunryu for reviewers. It states what the system
exposes and what protects it, then lists the points a review is likely to raise, each
with the reason it is accepted, what limits the risk and when to revisit it. The controls
themselves are described in [Security](1-security.md); this page links to them instead of
repeating them.

Scope: the Node.js control plane (REST API and dashboard), its use of SRS, the Goryu SRT
relay and FFmpeg, the native installer and the Docker evaluation image. Version 3.1.0,
reviewed November 2026.

## System and trust boundaries

| Listener | Exposure | Protection |
|---|---|---|
| Dashboard and API, `8080/tcp` | Not opened by the installer. Meant to be reached through a zero-trust tunnel ([Remote access](2-remote-access.md)) | Tunnel identity check, then the dashboard password and a session cookie |
| RTMP ingest, `21935/tcp` | Public, so encoders can reach it | Per-pipeline stream key checked by SRS's `on_publish` hook; playback refused |
| SRT ingest, `10080/udp` and `10081/udp` | Public | Passphrase checked at the handshake, then the same stream key check |
| SRS HTTP API, `1985/tcp` | Loopback only | Bound to `127.0.0.1` in `srs.conf` |
| SRS hooks, `8082/tcp` | Loopback only | Bound to `127.0.0.1`; a separate listener from the dashboard |
| Relay status, `8081/tcp` | Loopback only | Goryu binds it to `127.0.0.1`; read by the app only |

Outbound connections: one FFmpeg per output to the destinations the operator configures,
and, if set up, one HTTPS report a minute to Key Vault.

What an attacker would want, in order of value: the stream keys and destination URLs
(a destination URL can contain a platform's own stream key, which lets someone broadcast
as the organisation), the SRT passphrase, the dashboard password, and the ability to
interrupt a live stream.

| Actor | What they can reach | Main limit |
|---|---|---|
| Internet scanner | Ingest ports, and the dashboard port if it is exposed | Unknown keys and apps are refused before any stream starts; login is rate limited |
| Publisher with a valid key | One pipeline's input | The key only authorises publishing to its own pipeline; the public ports cannot play streams back |
| Holder of the dashboard password | Everything in the dashboard | One role by design (see the first point below) |
| Compromised media component (SRS, Goryu, FFmpeg) | The service user's files | See the installer point below |

## Controls in place

| Area | Control | Detail |
|---|---|---|
| Authentication | scrypt password hash (the password is never stored in a file), 12-character minimum when set or changed, 7-day sessions stored as SHA-256 hashes, revoked on password change and logout | [Security](1-security.md#authentication) |
| Brute force | 5 failures a minute per client (IPv6 grouped by /64), then a 5-minute block; scrypt runs off the event loop | [Security](1-security.md) |
| Cross-site requests | `SameSite=Strict` cookie, JSON-only bodies, and a browser-declared cross-site write is refused | [Security](1-security.md) |
| Browser hardening | Frame, sniffing, referrer, device-feature and cross-origin-embedding headers; HSTS over TLS; API answers are `no-store`; the dashboard escapes everything it renders | [Security](1-security.md) |
| Input validation | Bounded names, URLs and counts; destination schemes limited to `rtmp`, `rtmps` and `srt`; arguments passed to FFmpeg as an argument list, never through a shell | [Security](1-security.md) |
| Outbound policy | Link-local, unspecified and loopback destinations refused by what the host resolves to, with the same host parsing FFmpeg uses; the reserved `internal` app refused; restream loops marked on the output card (SRS refuses the second publisher) | [Security](1-security.md) |
| Process isolation | FFmpeg gets a minimal environment; the three services run as an unprivileged user; the application tree is root-owned | [Security](1-security.md) |
| Ingest | Per-server random SRT passphrase, per-pipeline stream keys of 128 random bits, publish and play hooks, non-default RTMP port | [Security](1-security.md) |
| Data access | One embedded SQLite database; every query is parameterised and the only dynamic SQL is a column list built from constants | `src/db/index.ts` |
| Secrets at rest | No secret has a default on a production install; the database is mode 600 and the configuration directory mode 750 | [Install](../1-getting-started/3-install.md) |
| Supply chain | SRS, Goryu and FFmpeg pinned with SHA-256 checks; `npm ci` with integrity hashes; Dependabot for npm, GitHub Actions and the Docker base images; CodeQL; every GitHub Action pinned to a commit | `.github/` |
| Resilience | A malformed request, a failed output or an uncaught error does not stop the server; restart and watchdog loops are bounded | [Reliability](4-reliability.md) |

Unauthenticated routes are `/api/ready` (a bare `{"ok":true}`), `/api/auth/login`, the
login page and the static dashboard files, which contain no secrets. Every other `/api`
route, and the HLS previews, require a session.

## Points a review may raise

### One shared password, no accounts, roles or MFA

The dashboard has a single password and every signed-in user can do everything. This is
intended for a small crew running one live event, where per-user accounts would add
a user store to maintain and a way to lock the team out mid-event. The identity layer is
the zero-trust tunnel, which provides per-person authentication, MFA and audit; the
password is a second factor behind it. Sessions can be revoked all at once by
changing the password. Revisit if the dashboard must be operated by people with different
privileges.

### The application does not terminate TLS

The server listens on plain HTTP. TLS is provided by the tunnel or reverse proxy in front
of it, and the session cookie gets `Secure` and HSTS is sent when the request arrived over
TLS. A direct exposure of port 8080 without a proxy would send the password in clear text,
which is why the installer does not open it and the documentation says to keep it closed.

### No script Content-Security-Policy

The dashboard uses inline event handlers in its static markup, so `script-src` cannot yet
exclude inline script. Mitigations: every value from the server (names, URLs, FFmpeg and
SRS log lines, publisher addresses, codec names) goes through an escaping helper before it
reaches HTML, none is placed in an inline handler, there is no `eval`, and secrets are
not stored in browser storage. The handlers carry only fixed strings. Moving them to
listeners and adding a CSP is planned as hardening, not a known hole.

### Defaults in the repository

`npm run dev` seeds a fresh development database with the password `admin`, and
`srs.conf` and `goryu.json` ship a public SRT passphrase. They exist so a first run from a checkout works without
setup, and the password can be changed straight away in Settings. Neither reaches a
production system:

- The installer and the Docker image refuse to start without a dashboard password you
  supply, and never generate, print or default one.
- The installer replaces the SRT passphrase with a per-server random value; the Docker
  entrypoint does the same.
- A production start that still has the public or an empty passphrase logs a warning.

### Ingest over RTMP is not encrypted and its only credential is the stream key

RTMP carries the key and the video in clear text, as the protocol does. Each pipeline has
its own key, an unknown key or an app other than `live` is refused before anything is
forwarded, and a key can be replaced by moving the pipeline to another one. For links that
cross an untrusted network the same input accepts SRT, which is encrypted with a
per-server passphrase checked at the handshake. The RTMP port is a non-default one to keep
scanner noise out of the logs.

### RTMPS output certificates are not verified

FFmpeg's default for `rtmps://` destinations is not to verify the server certificate, and
Bunryu keeps that default. The risk is an attacker who can intercept the connection
between the server and a streaming platform and read the stream key sent to it. It is
accepted because the destinations are platforms the operator chose, from a server in a data
centre, and turning verification on without a tested trust store would make live outputs
fail on a host without a certificate bundle, which is the worse failure in the middle of an
event. The output environment already passes `SSL_CERT_FILE` and `SSL_CERT_DIR` so
verification can be switched on later. Revisit when it can be tested against the
platforms in use. See [Design decisions](../4-reference/3-design-decisions.md#give-up-on-a-blocked-rtmprtmps-destination-with-an-output--rw_timeout).

### The server connects to destinations an operator types in

An output URL makes the server open a connection, so a stolen session could aim it at
internal hosts. Link-local addresses (cloud metadata), the unspecified address and
loopback outside the server's own ingest ports are refused, judged by what the name
resolves to and with the host parsed as FFmpeg parses it. Private LAN ranges are
allowed on purpose, because pushing to a venue encoder or a local media server is a
real use. DNS that changes between the check and FFmpeg's own lookup cannot be ruled out. Key Vault
reports use the same host check and refuse redirects. The connection speaks RTMP or SRT,
not HTTP, and only FFmpeg's own error text comes back, so it cannot be used to read the
content of internal services.

### Secrets visible to a signed-in user and in the logs

The dashboard shows publish URLs and the SRT passphrase to any signed-in user, because
configuring an encoder needs them (they are masked by default and revealed for a few
seconds). Logs, the output History and the diagnostics files keep FFmpeg's error text
as it is, including destination URLs. This is deliberate: a redacted log cannot explain
why an output failed during an incident. The logs are private to the server and to its
operators, are rotated and size-capped, and the documentation says to redact before
copying any of them elsewhere. The report sent to Key Vault is the exception: destinations
leave the server only as an HMAC hash and error text is redacted.

### Secrets in process arguments

An FFmpeg process receives the input URL (with the SRT passphrase when the input is SRT)
and the destination URL as arguments, so any local account on the host can read them from
the process list. There is no way to pass them through an option file or environment
variable to FFmpeg's network protocols without losing the URL-based configuration, and the
server is meant to be a dedicated machine with no untrusted local users. The installer
and the Docker entrypoint also pass the SRT passphrase to short-lived helper commands, for
seconds. The dashboard password only ever travels in the environment, never in arguments.

### Services share one user and the units are lightly hardened

SRS, the relay and the dashboard run as the same unprivileged user, with
`NoNewPrivileges`, `ProtectSystem=full`, `PrivateTmp` and write access limited to the data
and configuration directories. SRS and Goryu parse network input, so a flaw in either would
give an attacker that user's files, including the database and `bunryu.json`. This is
accepted for the first release because the three services must share the diagnostics
and configuration files, the binaries are pinned by checksum and run at the version the
installer was tested with, and the host is dedicated to this application. Splitting users
and adding further systemd restrictions (capability bounding, kernel and namespace
restrictions, system call filtering) would need testing on a production host with every
media component and is the planned next step. The service user can also read the system
journal, which is how the dashboard shows the three services' logs.

### The installer runs as root and trusts what it fetches

The installer is run by an administrator. It installs Node.js from the NodeSource
repository, updates the application from the repository's default branch, installs the
npm dependencies and does file operations in the configuration and data directories, which
the service user owns. The media binaries are fetched at pinned versions and verified by
SHA-256, and `npm ci` runs with install scripts disabled apart from the one native module the
application needs. The remaining trust is in the project's own repository and in the
NodeSource script, the same trust a package-manager install of any server software places
in its source. Misusing the directories would first need code execution as the service
user. Revisit with the service-user split above.

### The Docker image publishes the dashboard on every interface

`compose.yaml` publishes port 8080 as Docker does by default. The image is an evaluation
tool for trying the product on a laptop or a test machine, not for production, and it
refuses to start without a password. For anything reachable from a network, bind it to
the loopback address (`127.0.0.1:8080:8080`) or put the tunnel in front of it, as in
production.

### The login limit is per client address

The five-failure limit is keyed on the client address. Behind a proxy with
`trust_proxy` unset, everyone shares the proxy's address and a few mistyped passwords
lock the dashboard for five minutes. This is the safer failure: a guessing flood cannot
be spread across spoofed headers, and ingest and the running outputs are not affected.
The remote-access guide sets `trust_proxy` for the tunnel.

### Sessions last seven days and have no idle timeout

A session is valid for seven days from login so an operator is not signed out during a
multi-day event. Sessions are stored only as hashes, are revoked by logout and by a
password change, and the cookie is `HttpOnly` and `SameSite=Strict`.

### The database is not encrypted

The SQLite database holds the stream keys, destination URLs and the password hash. It
is readable only by the service user and root. Encryption at rest is the job of the
host's disk encryption, which cloud virtual machines provide by default; an application-level key
would have to be stored on the same machine.

### Denial of service

The unauthenticated surfaces are bounded. The ingest ports are limited by SRS's connection
cap, and a flood of refused publishes is counted in a fixed-size structure and logged once
a minute per key. Login attempts are rate limited and their hashing does not block the
event loop. Request bodies are capped at 1 MB. The dashboard is sized for about ten
clients; authenticated API calls are not rate limited because the users are the operators.

### Third-party components

The application has three runtime npm dependencies (Express, compression and
better-sqlite3), and `npm audit --omit=dev` reports no known vulnerabilities. The dashboard
ships one vendored library, hls.js, which only parses playlists produced by the
application's own FFmpeg on the same origin. SRS is an official static build, so it
receives no distribution patches; it is updated by changing the pinned version in the
installer and the Docker image. Both are tracked in [Install](../1-getting-started/3-install.md).
