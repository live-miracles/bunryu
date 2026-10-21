---
name: control-bunryu
description: Control a running Bunryu instance (local, test stack or production) through its REST API - log in, read pipeline/output state and health, create pipelines and outputs, start, stop and restart outputs, read an output's Error History. Use when the user asks to set up, change, start/stop or check streams on a running instance. NOT for server logs or deploys (use investigate-prod) and not for starting a local test stack (use run-bunryu).
---

# Control a Bunryu instance

Everything the dashboard does goes through the REST API
([reference](../../docs/4-reference/1-api.md)), so an agent drives the instance
with `curl`. There is no CLI and no API token: one dashboard password, one
session cookie.

## Rules

- **Production may be live.** Reads (`GET`) are always fine. Anything that
  stops, restarts, edits or deletes (stop, restart, update, delete, clear,
  regenerate keys) interrupts a destination, so do it on production only when the
  user asked for that action on that instance, and never during a live event
  unless they said so.
- **Never print or store secrets**: the password, stream keys, SRT passphrase and
  destination URLs (they embed the platform's stream key). Read the password from
  `$BUNRYU_PASSWORD`; when you summarize `/api/config`, drop `streamKeys`,
  `srtPassphrase`, each pipeline's `streamKey`/`*PublishUrl*` and each output's
  `url`.
- **Log in once**, reuse the cookie. 5 wrong passwords in a minute lock the client
  IP out for 5 minutes (`429`), so never retry a failed login in a loop.
- Check every response. Errors are `{ "error": "…" }` with a 4xx/5xx status;
  `curl --fail-with-body` (used below) makes the shell see them and still prints the message.

## Connect

`BUNRYU_URL` is the dashboard base URL: `http://localhost:8080` for `npm run dev`,
`http://localhost:18080` (password `admin`) for the
[test stack](../run-bunryu/SKILL.md), and the user's public dashboard address for
production. Ask the user for the password; do not guess it.

```bash
export BUNRYU_URL=http://localhost:8080          # no trailing slash
JAR=$(mktemp)                                    # cookie jar; delete when done
api() {  # api METHOD PATH [JSON_BODY]
  local args=(-sS --fail-with-body -b "$JAR" -X "$1" "$BUNRYU_URL$2")
  [ -n "$3" ] && args+=(-H 'content-type: application/json' -d "$3")
  curl "${args[@]}"
}
jq -n --arg p "$BUNRYU_PASSWORD" '{password:$p}' |
  curl -sS -f -c "$JAR" -H 'content-type: application/json' -d @- "$BUNRYU_URL/api/auth/login"
api GET /api/ready                               # {"ok":true}
```

Sessions last 7 days. A `401 Unauthorized` later means log in again. When done,
`api POST /api/auth/logout; rm -f "$JAR"`.

## Read state

```bash
# pipelines and outputs, secrets removed
api GET /api/config | jq '{pipelines: [.pipelines[] | {id, name, groupId}],
  outputs: [.outputs[] | {id, pipelineId, name, desiredState, videoEncoding, audioEncoding}]}'

# live status, refreshed every 5 s
api GET /api/health | jq '.pipelines | map_values({live: .input.live, mediaOk: .input.mediaOk,
  alerts: [.alerts[].code], outputs: (.outputs | map_values({status, warningReason, failures}))})'
```

- `input.live` is true while a publisher is connected and sending; `input.mediaOk`
  is the ffprobe result (`null` until probed, `false` with `mediaError` set).
- An output's `status` is `running`, `stopped` or `failed`. `desiredState` in
  `/api/config` is what the user wants; `status` in `/api/health` is what is
  happening. A `running` output with a `warningReason` is delivering but unhealthy
  (for example timestamp discontinuities).
- `alerts` are pipeline-level faults with `severity`, `code`, `message` and
  `sinceMs`.
- Outputs named `Shared encode …` (with `role: "rendition"`) are created and
  managed by the server; leave them alone.
- Why an output failed: `api GET /api/pipelines/<id>/outputs/<outId>/errors`.
  Input online/offline events: `api GET /api/pipelines/<id>/logs`.

## Common tasks

| Task | Call |
|---|---|
| Create a pipeline | `api POST /api/pipelines` → `{ id, name, streamKey, … }` (key auto-assigned) |
| Rename it | `api POST /api/pipelines/<id> '{"name":"Main"}'` |
| Publish URLs | `api GET /api/config`, the pipeline's `rtmpPublishUrl`, `srtPublishUrl` (contain the key: give them to the user, don't log them) |
| Add one output | `api POST /api/pipelines/<id>/outputs '{"name":"YouTube","url":"rtmp://…","videoEncoding":"copy","audioEncoding":"copy"}'` → `201` with the output |
| Add many outputs | `api POST /api/pipelines/<id>/outputs/bulk '{"outputs":[{…},{…}]}'` (all validated before any is created) |
| Rename a running output | `api POST /api/pipelines/<id>/outputs/<outId> '{"name":"New"}'` |
| Start / stop one | `api POST /api/pipelines/<id>/outputs/<outId>/start` (or `/stop`) |
| Start / stop all | `api POST /api/pipelines/<id>/outputs/start-all` (or `/stop-all`); start-all returns at once and staggers the starts, so poll `/api/health` |
| Restart a running output | `api POST /api/pipelines/<id>/outputs/<outId>/restart` |
| Change an output's destination or encoding | stop it, `api POST …/outputs/<outId> '{…fields to change…}'`, start it |
| Delete an output / pipeline | `api DELETE …/outputs/<outId>` / `api DELETE /api/pipelines/<id>` |

Output fields: `videoEncoding` is `copy` (default, almost always right) or one of
the encodings in `/api/config` `.encodings`; `audioEncoding` is `copy`, a track
number such as `1`, or a list such as `0,1` (SRT destinations only). For an RTMP
destination fed by an SRT input, pick a track instead of `copy`. See
[Outputs](../../docs/2-usage/2-outputs.md). Translation outputs need a
`translation` object, see the [API reference](../../docs/4-reference/1-api.md).

After a change that starts something, confirm it: poll `/api/health` every few
seconds until the output is `running` (or `failed`, then read its errors) instead
of assuming the `200` means it works.

An output started while its pipeline has no live input is not an error: `start`
returns `ok`, `desiredState` becomes `running` and `status` stays `stopped` (the
pipeline may be missing from `/api/health` altogether) until a publisher connects.
Check `input.live` before concluding anything is broken.

## Constraints that return 409 or 400

- Updating a **running** output allows only `{ name }`; stop it first.
- Deleting a pipeline, clearing its outputs or reassigning its stream key is
  refused while any of its outputs is running.
- `restart` needs a running output and at least 5 s since its last restart.
- A shared encode can't be created, edited, started, stopped or deleted.
- At most 500 outputs in total; bulk create is capped too.
- A destination that resolves to a link-local address, or to this host on a port
  that isn't its own RTMP/SRT port, is refused (`400`).

## What the API can't do

It can't restart or reconfigure SRS, Goryu or the services, and it shows no
journald or diagnostics files. For those, use
[investigate-prod](../investigate-prod/SKILL.md) (read-only) or ask the user.
