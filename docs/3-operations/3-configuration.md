# Configuration

The app reads runtime settings from `bunryu.json`. A dev checkout reads the one
in the app root; the native install keeps it at `/etc/bunryu/bunryu.json` next to
`srs.conf` and `goryu.json` (outside the git checkout, which every update resets)
and the unit points the app at it with `BUNRYU_CONFIG`. The Docker image keeps it
in the `/data` volume. The installer and the Docker entrypoint set only `port` and the
file paths; every other setting you add stays when you update. The dashboard password
is not in this file (see `BUNRYU_DASHBOARD_PASSWORD` below).

The app reads `bunryu.json`, `srs.conf` and `goryu.json` once, when it starts:
restart the app after changing any of them. SRS and Goryu read their own file only
at startup too. If one of the three is missing or is not valid JSON, the app prints
which file and exits with status 78, which systemd does not restart (see
[Reliability](4-reliability.md)).

`bunryu.json`:

| Field | Default | Description |
|-------|---------|-------------|
| `port` | `8080` | App HTTP port |
| `hook_port` | `8082` | Loopback-only port for SRS's `on_publish`/`on_play` hooks. Must match the hook URLs in `srs.conf` |
| `trust_proxy` | `0` | Reverse-proxy hops whose `X-Forwarded-For` is trusted for client IPs (login rate limit, logs). Set `1` behind cloudflared/nginx on this host. The header is used only when the connection comes from loopback, so a client reaching the port directly cannot set its own address, and a proxy on another machine is treated as the client |
| `database_path` | `./db.sqlite` | SQLite database path |
| `srs_config_path` | `./srs.conf` | SRS config path |
| `ffmpeg_path` | `ffmpeg` | FFmpeg binary for outputs and previews |
| `ffprobe_path` | `ffprobe` | FFprobe binary for input media probing and validation |
| `stream_key_count` | `100` | Stream keys generated for pipelines to publish with. One pipeline uses one key, so this is also the most inputs the server accepts. A whole number from 1 to 10000; anything else gives 100. Raising it adds keys at the next start; lowering it removes the unassigned keys above it (keys a pipeline uses stay). The inputs and outputs recommended in the [introduction](../1-getting-started/1-introduction.md#capacity-and-limits) are not enforced |
| `output_watchdog.warmup_ms` | `90000` | Warmup before stall checks, used by the output progress watchdog |
| `output_watchdog.stall_ms` | `45000` | Output progress stall window before restarting FFmpeg |
| `output_watchdog.interval_ms` | `5000` | Output watchdog polling interval |
| `output_watchdog.socket_warmup_ms` | `15000` | Socket watchdog warmup before socket-state checks |
| `output_watchdog.socket_grace_ms` | `30000` | Socket warning grace window before restarting FFmpeg |
| `output_watchdog.memory_limit_mb` | `200` | FFmpeg RSS limit (MB) before an output is killed and restarted; applies to `copy` and any `videoEncoding` not listed below |
| `output_watchdog.memory_limit_mb_by_encoding` | `{vertical_rotate: 450, "720p": 650, "1080p": 950}` | Per-`videoEncoding` RSS limit override (MB); libx264 transcode profiles run at a much higher legitimate baseline than `copy` |

Relative file paths are resolved from the directory of `bunryu.json`. Command names like `ffmpeg`
and `ffprobe` are left as command names.

SRS values are inferred from `srs.conf`:
- RTMP pull/publish port from top-level `listen`
- SRT pull/publish port from `srt_server { listen ... }`
- SRS HTTP API port from `http_api { listen ... }`
- SRS log tail path from `srs_log_file`, if present — otherwise the dashboard
  falls back to `journalctl -u srs.service` (production's `srs.conf` logs to
  console/journald instead of a file; only local dev's still sets `srs_log_file`)

The dashboard's own log and the relay's log are always read via
`journalctl -u bunryu.service` / `-u goryu.service` — both only
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
limit, CPU and RSS for the Node control plane
(plus its V8 heap), SRS and the SRT relay (the same samples the dashboard
shows, up to ~10 s old), host total/available memory and swap, host CPU pressure
(`cpuPressure`: the share of the last 10 s and 60 s in which a runnable task waited for a CPU,
from `/proc/pressure/cpu`, null where the kernel has none) and the kernel's UDP counters
(`udp`: datagrams dropped host-wide for a full receive buffer, how many since the previous
snapshot, and the receive queue and drops of the SRS and relay SRT ingest sockets).
The snapshot also records the free space of the filesystem holding the database
(`dataDisk`). Separately, the host resource alerts are logged on transition (see
[Host resource alerts](4-reliability.md#host-resource-alerts)): `host-memory-high` / `host-memory-critical`,
`host-cpu-high` / `host-cpu-critical` / `host-cpu-saturated`, `host-disk-high` /
`host-disk-critical`, and their recoveries.

Other things the diagnostics record so an incident can be pieced together:

- **Restarts:** `server-started` (version, pid, a random `instanceId` per start, the
  kernel release, and the `net.core.rmem_max`/`wmem_max` ceilings the process started
  under, so a kernel change or an unapplied sysctl file shows up between two starts),
  `server-shutdown` (signal, uptime, the outputs it killed — their own
  `ffmpeg-exited` events are not written during a shutdown) and
  `server-start-failed` (for example the dashboard port already in use).
- **One output run:** every output event carries `outputId`, `pipelineId`, the
  FFmpeg `pid` and a `runId` (`<outputId>#<n>`, counted from the server start),
  so grepping a `runId` gives that run's start, warnings, restart, exit and the
  retry that followed. `ffmpeg-exited` also has `ranMs`. When an exit's stderr
  tail is identical to the previous exit's (a retry loop against a dead
  destination), it is replaced by `stderrTailSameAsPrevious: true`.
- **Pipeline alerts:** `pipeline-alert-started` and `pipeline-alert-ended`
  (duration, number of polls it was active, last message). An alert absent for
  six polls (~30 s) ends its episode, so a flickering condition is one episode. The
  dashboard shows how long ago the episode started ("since 3 min ago") next to the alert.
- **Publisher address:** `publisher-source` when a publisher connects, with the
  encoder's address (`rtmp from <ip>`, `srt from <ip>`, `srt via relay from <ip>:<port>`);
  the pipeline log gets the same line. A bonded input has none: its legs are logged
  as they join and leave.
- **Leg health:** `bonded-leg-health` when a leg's (or a plain SRT input's) health goes
  between `ok`, `warn` and `error`, with the reason; the pipeline log gets a
  `leg_degraded`, `leg_failed` or `leg_recovered` line, at most 4 a minute per pipeline.
- **Publish hooks:** `publish-allowed`, and `publish-rejected` for each rejection
  that is logged. Repeats are throttled to one journal line per minute per key.
  The number not logged goes on the next line, or, if the attempts stopped, on a
  summary line once the minute is over (written on the next hook call or
  dashboard refresh).
- **Control-plane errors:** a background loop (health poll, output watchdog)
  that throws writes `<loop>-failed` on its first failure or a new
  error, and `<loop>-recovered` with the count; an error nothing else caught is
  written as `uncaught-exception` or `unhandled-rejection`. The process keeps
  running in both cases. A shutdown step or a staggered restart that throws is
  written as `step-failed` (with the step name) and the rest still run.
- **Stopped outputs are left out** of the per-minute snapshot.

Writing diagnostics is best effort and never stops the control plane: if a write
fails (disk full, directory unwritable) events are dropped for a minute and the
file is reopened; past 16 MB of unwritten events in memory, new events are
dropped. In both cases the next record written is `diagnostics-events-dropped`
with the count and the error. A shutdown waits up to 2 s for the file to flush.

Files are
rotated daily or at 100 MB, whichever comes first, with a 5 GB total diagnostics
cap that removes the oldest rotated files first. The installer configures
persistent journald with a seven-day retention limit, 1 GB system journal cap,
256 MB runtime cap, and one-day journal file rotation.

### Key Vault status reporting

Key Vault colours each stream key from what Bunryu says about the outputs that use it, and
shows whether the signal of each input is arriving from what it says about the pipelines.
Set the link in the dashboard, under **Settings > Key Vault**, and Bunryu sends a report
once a minute, and at once when an output or an input changes status (at most one every
10 s). It applies when you save, with no restart, and a report is sent at once.

| Field | What to enter |
|---|---|
| Link | Key Vault's ingest endpoint, such as `https://<project>.supabase.co/functions/v1/ingest`. `https`, or `http` only for `localhost` (a test receiver); no credentials in it, and not a link-local or unspecified address |
| Secret | The secret Key Vault shows its owners (its `KEY_VAULT_SECRET`). At least 32 characters of printable ASCII, no spaces |

One secret is all the link needs: Bunryu derives from it the bearer token it sends
(`Authorization: Bearer <token>`) and the hash secret for the destination hashes, the same
way Key Vault does, so the two always agree.

A wrong value is refused when you save it, so the saved link always works as far as its
format goes. The secret is never shown again: leave it empty to keep the saved one (a link to
another host needs it again, so the token is never sent to a host it was not entered for), and
clear the link to turn the reports off (this also forgets it). The token and hash secret
derived from it are stored in the database, like the server name (the secret itself is
not), and the dashboard and [API](../4-reference/1-api.md) return only whether it is set.

Under the fields, Settings shows whether the reports get through: **Connected** with the
time of the last report, or **Not reaching Key Vault** with the reason (a refused secret, a
link whose host does not exist, Key Vault down) and how long it has lasted. A report is sent
as soon as you save, and the line updates every few seconds while Settings is open. When Key
Vault says it left entries out of a report because it could not use them, the line says how
many; the reasons are in Key Vault's function logs.

Key Vault tells servers apart by the report's `instance`, which is this server's
**Server Name** (**Settings > General**). Give each server that reports to the same Key Vault
its own name. A rename shows in the next report, within a minute.

The report is a JSON `POST` with the token as a bearer token:

```json
{
    "version": 1,
    "instance": "prod",
    "sentAt": "2026-11-01T10:00:00.000Z",
    "outputs": [
        {
            "hash": "9cd8fc4d3e06aafeb1aa71d4e7310d38",
            "pipeline": "Hindi",
            "output": "YouTube main",
            "status": "running",
            "message": "",
            "failures": 0,
            "stoppedAfterFailures": false,
            "sinceMs": 1730455200000
        }
    ],
    "inputs": [
        {
            "pipeline": "Hindi",
            "status": "running",
            "message": "",
            "sinceMs": 1730455100000
        }
    ]
}
```

- **`status`** is `running`, `warning`, `error` or `stopped`: the dashboard's output status
  (green, amber, red, grey) with its "Problems" rule for errors. A stop after repeated
  failed attempts is `error` with `stoppedAfterFailures: true` (the dashboard shows it only as a yellow
  line on the output's card); a stop an operator chose is plain `stopped`. Advice about the configuration (an output that shares a destination
  with another, encoding tips) is not a warning here.
- **`hash`** identifies the destination without revealing it: the first 32 hex characters of
  HMAC-SHA256 (keyed with the hash secret derived from the secret) of the URL, trimmed, with a lowercase scheme and host and
  no trailing `/`. Key Vault matches its own server and key to the same hash. The
  test vectors both sides check are in
  [`test/fixtures/key-vault-hash-vectors.json`](../../test/fixtures/key-vault-hash-vectors.json).
- **`message`** is the output's current error or warning, one line, at most 300 characters.
  URLs, `streamid=`, `passphrase=`, `key=` values and long token-like strings are removed
  first, because FFmpeg's text names the destination. The URL itself is never sent.
- **`sinceMs`** is when the output entered this status (milliseconds since the epoch);
  `failures` counts the failed starts since it last started.
- Shared-encode rows, which Bunryu manages itself, are not reported.

`inputs` has one entry for every pipeline, also one with no outputs. It is the state of the
signal coming in, from the same rules as the input's dot on the dashboard:

| Dashboard input | Reported `status` | Key Vault shows |
|---|---|---|
| Good | `running` | Receiving |
| Warning (no audio, low bitrate, still probing, an alert about the input) | `warning` | Unstable |
| Error (the probe failed, an error alert) | `error` | Not arriving |
| Off, and at least one output of the pipeline is set to run | `error`, "No signal is arriving." | Not arriving |
| Off, and no output of the pipeline is set to run | `stopped` | Idle |

- **`pipeline`** is the pipeline's name exactly as it is typed. Key Vault matches it to the
  input of the same name, ignoring case, leading and trailing spaces and repeated spaces
  ("Hindi", "hindi" and " Hindi " are one), so **name each pipeline the same as its input
  in Key Vault**. A pipeline whose name matches no input there is ignored. A blank name is
  not reported, and a name is cut at 200 characters.
- **`message`** is the first problem, redacted like an output's, and empty for `running` and
  `stopped`. **`sinceMs`** is when the input entered this status.
- Key Vault also compares an output's `pipeline` with the input its stream was filed under,
  and warns when they differ. That needs nothing more from Bunryu.

What the reporter does when Key Vault is unreachable is under
[Reliability](4-reliability.md#key-vault-status-reporting).

### UDP buffer ceiling

The installer writes `/etc/sysctl.d/90-bunryu.conf`, which raises
`net.core.rmem_max` and `net.core.wmem_max` to 16 MB (default 212992). libsrt asks
for a 12 MB UDP buffer per socket and the kernel caps the request at that
ceiling; sockets that ask for nothing keep the default size. The services read it
when they create their sockets, so a change needs a restart of SRS and goryu.
The current ceilings are shown in Settings under Server information (UDP buffer cap), and the
ones the control plane started under are in its `server-started` diagnostics event.
The ingest sockets are the ones to check: `sudo ss -uanmp` shows each socket's
buffer as `rb` (24576000 for SRS on 10080 and goryu on 10081) and its drops as
`d`, and `nstat -az UdpRcvbufErrors` counts drops host-wide. In Docker the
container uses the host's kernel setting; set it on the Docker host.

### Database schema version

The SQLite database carries a schema version (`PRAGMA user_version`, `SCHEMA_VERSION`
in `src/db/schema.ts`). There are no migrations, so a change to a table or column
bumps it, and a database stamped with another version is refused at startup with a
message saying so, instead of failing later on a query. The fix is to recreate the
database. The installer checks this first: after it pulls the new code it compares the
database's stamp with the build's, and when they differ it says so and stops before it
changes anything or restarts a service, so a running server keeps running. Only then does
it ask, in a terminal, "Wipe it and start with an empty database? [Y/n]": Enter wipes, and
`n` or no terminal stops the install (`WIPE_DB=y` wipes without asking). A
`db.sqlite.<timestamp>.bak` copy is kept to re-create pipelines from. A database with the
current version is kept without any prompt. A database that has tables but no stamp
counts as another version; an empty one is stamped.

Relay ports, status polling and the SRT passphrase are read from `goryu.json`, located beside `srs_config_path`.

Installer/development overrides:

| Variable | Used by | Description |
|----------|---------|-------------|
| `REPO_URL` | `server-install.sh` | Repository URL cloned into `/opt/bunryu` on first install |
| `SRT_RELEASE_TAG` | `server-install.sh` | Relay GitHub release tag to install |
| `SRT_URL` | `server-install.sh` | Custom relay release archive URL |
| `SRT_SHA256` | `server-install.sh` | Expected SHA256 for the relay archive; blank skips verification |
| `BUNRYU_DASHBOARD_PASSWORD` | the app, `server-install.sh`, `server-set-password.sh`, Docker entrypoint | Initial dashboard password, required when the database is empty (first install, a wipe, or an empty `/data` volume); the installer asks for it when it is unset and it runs in a terminal. Only its hash is stored, in the database. There is no default: with an empty database and no password the server does not start (exit status 78). `npm run dev` uses `admin` when it is unset |
| `BUNRYU_CONFIG` | the app | Path of `bunryu.json`; unset reads `./bunryu.json`. Set by the installer's unit |
| `WIPE_DB` | `server-install.sh` | Set `y` to wipe the existing SQLite DB without asking (needed when its schema changed and there is no terminal); `n` never wipes. A wipe first copies it to `db.sqlite.<timestamp>.bak` (owner-only, it holds stream keys and destination URLs) |
| `SRS_LOCAL_BIN` | `dev-server-install.sh` | Local executable SRS binary to copy into `./objs/srs` |
