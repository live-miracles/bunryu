# Native install

The native install is the recommended way to run Bunryu in production. It
targets Debian/Ubuntu on x86_64 and sets up three systemd services:

| Service | Purpose |
|---------|---------|
| `srs.service` | Native SRS binary, started as `/usr/local/bin/srs -c /etc/bunryu/srs.conf` |
| `goryu.service` | Shared Goryu relay, started on UDP port 10081 |
| `bunryu.service` | Node.js dashboard/API, started from `/opt/bunryu/dist/index.js` |

The installer downloads the official SRS release binary and a pinned `goryu` binary from the standalone [`live-miracles/goryu`](https://github.com/live-miracles/goryu) GitHub releases.

Startup is ordered so the Node.js control plane is reachable before SRS accepts
publishes. `srs.service` waits for the unauthenticated readiness endpoint
`http://127.0.0.1:8080/api/ready` before starting; this prevents SRS publish
hooks from racing the dashboard/API process during boot. All three units restart
their process 2 s after it exits and never give up (`StartLimitIntervalSec=0`); see
[Reliability](../3-operations/4-reliability.md#watchdogs).

**Production install:**
```bash
sudo apt-get update -q && sudo apt-get install -y -q git  # in case git is not installed
sudo git clone https://github.com/live-miracles/bunryu /opt/bunryu
sudo BUNRYU_DASHBOARD_PASSWORD='choose-a-long-password' bash /opt/bunryu/scripts/server-install.sh
```

A fresh install needs the initial dashboard password. If the variable is missing
(and `/etc/bunryu/bunryu.json` has no `dashboard_password`), the installer stops
before changing anything and says so; it never generates or prints a password. A
re-run that keeps the existing database needs none.

**Set server timezone (optional, for readable log timestamps):**

SRS and journald log timestamps in the system's local timezone, which defaults to UTC on most fresh servers. Set it to your local timezone so log times make sense at a glance, e.g. for IST (Asia/Kolkata):
```bash
sudo timedatectl set-timezone Asia/Kolkata
```
List available timezone names with `timedatectl list-timezones`. No reboot is needed, but already-running services may have the old timezone cached in memory, so restart them to apply it to new log lines immediately:
```bash
sudo systemctl restart srs.service bunryu.service goryu.service
```

**Update an installed server:**
```bash
sudo bash /opt/bunryu/scripts/server-install.sh
```
The installer pulls the latest code before anything else and, if the installer
itself changed, restarts itself from the new copy, so one run applies the new
pinned versions, config and units. (An installer older than this behavior pulls
its own replacement halfway through and keeps running the old steps; run it a second
time once to move past it.)

If a release changed the database schema (there are no migrations), the installer
says so after pulling the code and stops before restarting anything; the running
server is untouched. Re-run it with `WIPE_DB=y` to wipe the database (a backup copy is
kept and pipelines have to be re-created); see
[Configuration](../3-operations/3-configuration.md#database-schema-version).

**Stop services:**
```bash
sudo bash /opt/bunryu/scripts/server-down.sh
```

Open the dashboard: `http://SERVER_IP:8080` — log in with the password you gave the installer (it is stored as `dashboard_password` in `/etc/bunryu/bunryu.json`; `scripts/server-reset-password.sh` re-applies it).

After the first login, set **Settings → Public Host** to the address your
encoders use, so the publish URLs shown in the dashboard are correct. To reach
the dashboard securely from outside, see [Remote access](../3-operations/2-remote-access.md).

## Firewall ports

Default ports from `srs.conf` and `goryu.json`:

| Port | Protocol | Purpose |
|------|----------|---------|
| 21935 | TCP | RTMP input (non-default port to avoid 1935 scanner noise) |
| 10080 | UDP | SRT input (passphrase required) |
| 10081 | UDP | SRT bonding input, also accepts plain SRT (passphrase required) |
| 8080 | TCP | Dashboard + API |

Do **not** expose 8080 if the dashboard is served through a tunnel, or 8081 (relay
status). The SRS HTTP API (1985) is bound to `127.0.0.1` in `srs.conf`, and SRS's
publish/play hooks go to the app's separate loopback-only hook port (`hook_port`,
default **8082**), so neither can be reached from outside even with a permissive
firewall. Neither port needs a firewall rule; check with `ss -tlnp` after install
that 1985 and 8082 listen only on `127.0.0.1`.

## SRS and SRT relay config

The repository copies both runtime config files during install:
- `/etc/bunryu/srs.conf`
- `/etc/bunryu/goryu.json`

The app's own `/etc/bunryu/bunryu.json` is rewritten on every install too (the unit sets `BUNRYU_CONFIG` to it); only its `dashboard_password` carries over.

SRS only reads its config at startup, and Goryu only reads its
JSON config file at startup.

The repo configs ship a public default SRT passphrase; on first install the
installer generates a random per-server secret and writes it to both files.
On reinstall it leaves each file's passphrase exactly as deployed — it
doesn't compare, regenerate, or sync the two. SRS rejects SRT connections
without the passphrase at the handshake, for publish and play alike; the
dashboard's SRT publish URLs include it.

To change or disable it, edit both files by hand and restart SRS and the
relay: `passphrase ;` in `srs.conf`, `"passphrase": ""` in
`goryu.json`. An empty value in both disables the passphrase
check entirely — SRS and the relay treat empty the same as unset.

Ingest is further locked down by SRS HTTP hooks handled by the app:
`on_publish` rejects unknown stream keys, and `on_play` rejects any play not
from loopback (only the app's own FFmpeg ever pulls streams), so the public
ports are ingest-only. See
[Security](../3-operations/1-security.md#why-fail2ban-is-not-used) for why rejected attempts are logged
but not converted into firewall bans.
