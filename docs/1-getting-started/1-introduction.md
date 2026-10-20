# Introduction

Bunryu is a self-hosted restreaming server for long live events. It takes
live inputs over RTMP, SRT and bonded SRT, manages each one as a **pipeline**, and
forwards every pipeline to any number of RTMP, RTMPS or SRT destinations
(**outputs**), such as YouTube, Facebook, Twitch, a CDN or another server.

It is built for reliability first: one failing destination, input or FFmpeg
process never takes down the others, stuck outputs are restarted by watchdogs,
and every failure leaves enough evidence to explain it afterwards.

## How it works

```
OBS / ffmpeg  ──RTMP────────►  SRS (21935)  ──FFmpeg──►  YouTube / Facebook / ...
              ──SRT─────────►  SRS (10080)  ──FFmpeg──►  rtmp:// or srt://
              ──SRT bonding─►  goryu (10081) ──► SRS
```

| Component | Description |
|-----------|-------------|
| SRS | Ingest broker — accepts RTMP and SRT streams |
| goryu | Standalone bonded SRT relay (GitHub release in prod, sibling repo in dev) |
| Node.js app | REST API + dashboard on port 8080 |
| FFmpeg | One process per output, plus one per [shared encode](../2-usage/2-outputs.md#shared-encodes), spawned and managed by the app |
| SQLite | Persistent state for pipelines, outputs, stream keys, settings |

Each output is its own FFmpeg process that pulls the input from SRS over
loopback and pushes it to one destination, so outputs fail and recover
independently. Outputs of a pipeline that need the same encode instead copy from
one shared encode. See [Reliability](../3-operations/4-reliability.md) for the
watchdogs that supervise them.

## Capacity and limits

The server is built and operated for the envelope below. It has **not** been
tested or designed for anything beyond it — treat these as the supported ceiling,
not a target to exceed.

| Limit | Supported ceiling |
|-------|-------------------|
| Inputs (pipelines) | up to **50** |
| Outputs (forwards) | up to **500** total — enforced: creating a 501st returns `409` (shared encodes are not counted) |
| Distinct custom (transcoding) encodes | only **a few** at a time — see below |
| Parallel dashboard clients | up to **~10** |

Past these figures, expect host CPU/RAM/network and the number of concurrent
FFmpeg processes (one per output, plus one per shared encode) to become the limiting factors well before the
dashboard or API does.

**Keep almost all outputs in `copy` mode.** A `copy` output remuxes the input
without decoding it, but sending still costs CPU in proportion to the bitrate: on
production about 4% of a vCPU per 8 Mbps output, so 100 outputs take around 4 vCPUs
and 800 Mbps of egress (more with an SRT input). Selecting an audio track
re-encodes the audio and roughly doubles that per output, unless outputs share the
encode. A custom video encoding (`720p`, `1080p`, `vertical_rotate`) transcodes
the video, which is CPU-intensive: on a GCP `n2` with 50 fps feeds about 2 vCPUs
for `720p` and 1.2 for `vertical_rotate` from a 1080p input, and `1080p` from a 4K
input needs about 6 and does not keep up on 4. Outputs of a pipeline with the same
encode share **one** [shared encode](../2-usage/2-outputs.md#shared-encodes), so
CPU is counted once per distinct encode per pipeline, not once per output. Only a
handful of distinct custom encodes should run at once: more would saturate the CPU
long before the 500-output ceiling and starve the `copy` outputs and the
dashboard. [Sizing a server](4-sizing.md) has the measured costs and example VM
sizes.

**Previews** copy the input's video, so an open preview costs only a few percent
of one core, but each viewer receives the input's full bitrate. See
[Preview](../2-usage/1-publishing.md#preview).

**Parallel dashboard clients.** Health is computed once every 5 s and shared by
all clients, so extra browser tabs do not multiply SRS or ffprobe work, and
config changes from another session are picked up through the health poll. About
10 simultaneous clients is fine; more is not tuned or tested.

**Dashboard on a phone.** The dashboard is designed for a desktop browser. Below
1024 px wide the columns stack into one and wide tables scroll sideways. That is
enough to check state or start and stop an output from a phone, not to edit
(drag-to-reorder does not work on touch screens).

## Is it a good fit?

Good fit:

- Events that stream one or more feeds to many platforms at once.
- Encoders on unreliable links that need SRT or bonded SRT.
- Multi-language streams with live interpreters.
- Teams that want to self-host and keep their own logs.

Not designed for:

- Transcoding ladders or large numbers of encoded outputs.
- Serving viewers directly (it forwards to platforms and CDNs).
- Recording and VOD.
- More than about 50 inputs or 500 outputs on one server.
