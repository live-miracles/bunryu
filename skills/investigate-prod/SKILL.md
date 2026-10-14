---
name: investigate-prod
description: Inspect the production Bunryu VM (read-only) to investigate an incident, a warning or a user report - journald logs, structured diagnostics JSONL, the deployed version, service state. Use when the user asks what happened on the server, why an output/input misbehaved, or to check logs or diagnostics there. NOT for deploying, restarting services or changing server config.
---

# Investigate production (read-only)

Production is one GCP VM running three systemd services. Treat it as live: a
stream may be running. Look, don't touch.

## Rules

- **Read-only.** No `systemctl restart/stop`, no installs, no edits under `/opt`,
  `/etc`, `/var/lib`, no `kill`, no DB writes. Deploying or restarting is a
  separate request the user must make explicitly, and never during a live event
  unless they say so.
- **Never copy secrets into the repo, chat summaries or reports**: stream keys,
  SRT passphrases, destination RTMP/SRT URLs (they embed the platform's stream
  key), customer/encoder IPs. Redact as described in `skills/write-fail-report`.
  Don't `cat` the DB, `srs.conf`, `srt-bonding-relay.json` or env files; query
  only what the question needs.
- Keep output small: filter on the VM (`grep`, `tail`, `cut -c1-600`) rather than
  pulling whole files into the conversation.

## Access

```bash
gcloud compute ssh bunryu --zone=asia-south1-b --tunnel-through-iap --command '<read-only command>'
```

If it fails with "Reauthentication failed", the user must log in themselves;
suggest they run `! gcloud auth login` in the prompt (it needs a browser).

## Layout

| Thing | Where |
|---|---|
| Services | `srs.service` (SRS), `srt-bonding-relay.service` (UDP 10081), `bunryu.service` (Node dashboard/API) |
| App checkout / build | `/opt/bunryu` (`dist/index.js`) |
| Config | `/etc/bunryu/srs.conf`, `/etc/bunryu/srt-bonding-relay.json` (contain secrets) |
| Database | `/var/lib/bunryu/db.sqlite` |
| Diagnostics | `/var/lib/bunryu/diagnostics/diagnostics-YYYY-MM-DD.jsonl` (file date is the host's local date, with a `.N` suffix when a file passes 100 MB; 7 days, 5 GB total) |

`ts` inside the diagnostics is UTC ISO, while file names, journald and the
older fail reports use the host's local time (IST, UTC+05:30) - convert before
comparing.

## Recipes

```bash
# Deployed version and service state
sudo -u bunryu git -C /opt/bunryu log --oneline -3; grep '"version"' /opt/bunryu/package.json
systemctl is-active srs.service srt-bonding-relay.service bunryu.service

# Journals (all three only log to journald)
sudo journalctl -u bunryu.service --since '-2 hours' --no-pager | tail -100
sudo journalctl -u srs.service -u srt-bonding-relay.service --since '-1 hour' --no-pager | tail -100
sudo journalctl -k --since '-1 day' --no-pager | grep -i -E 'oom|killed process'   # OOM kills
```

The diagnostics directory is not world-readable and a bare `sudo grep ... *.jsonl`
fails because the glob expands *before* sudo. Wrap it in a shell:

```bash
# Events of one kind, newest file
sudo sh -c 'grep "\"event\":\"ffmpeg-exited\"" /var/lib/bunryu/diagnostics/diagnostics-$(date +%F).jsonl' | cut -c1-900 | tail
# Everything about one output (e.g. 3-1) without the per-minute snapshots
sudo sh -c 'grep "\"outputId\":\"3-1\"" /var/lib/bunryu/diagnostics/diagnostics-2026-10-06.jsonl' | grep -v health-snapshot | cut -c1-600
# Event counts for a day, to spot floods
sudo sh -c 'grep -o "\"event\":\"[a-z-]*\"" /var/lib/bunryu/diagnostics/diagnostics-2026-10-06.jsonl' | sort | uniq -c | sort -rn | head
```

Pull a file locally only when a deeper look needs it (`gcloud compute scp ... --tunnel-through-iap`),
into the scratchpad - never into the repo (it holds keys and IPs).

## Event names (`event` field)

`ffmpeg-started`, `ffmpeg-exited` (includes the stderr tail), `ffmpeg-restart`
(watchdog action), `ffmpeg-retry-scheduled`, `ffmpeg-timestamp-warning` /
`-summary` / `-recovered` (one burst per output), `ffmpeg-warning-started` /
`-ended` (memory, socket, media-clock episodes), `input-transition`,
`input-publisher-transition`, `srs-transition`, `relay-transition`,
`relay-input-transition`, `bonded-leg-transition`, `media-probe-failed` /
`-recovered`, `host-memory-low` / `-recovered`, `translation-mixer-*`, and a
`health-snapshot` once a minute (SRT counters, per-output RSS/CPU/bitrate, host
memory). This list can drift: `grep -rhoE "event\('[a-z-]+'" src` is the truth.

## Method

1. Pin the time window and the object (pipeline / output id like `3-1`).
2. Check what version is deployed (`git log`) - the VM often lags `master`, so a
   behaviour you see in logs may already be fixed or changed in the repo.
3. Read the transitions around that window first (input, SRS, relay, output
   start/exit/restart), then the `health-snapshot`s on either side.
4. Separate what the logs show from what you infer; say what you could not see.
5. If the finding should be written up, use `skills/write-fail-report`.
