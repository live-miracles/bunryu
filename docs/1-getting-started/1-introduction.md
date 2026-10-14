# Introduction

Restream SRS is a self-hosted restreaming server for long live events. It takes
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
              ──SRT bonding─►  srt-bonding-relay (10081) ──► SRS
```

| Component | Description |
|-----------|-------------|
| SRS | Ingest broker — accepts RTMP and SRT streams |
| srt-bonding-relay | Standalone bonded SRT relay (GitHub release in prod, sibling repo in dev) |
| Node.js app | REST API + dashboard on port 8080 |
| FFmpeg | One process per output, spawned and managed by the app |
| SQLite | Persistent state for pipelines, outputs, stream keys, settings |

Each output is its own FFmpeg process that pulls the input from SRS over
loopback and pushes it to one destination, so outputs fail and recover
independently. See [Reliability](../3-operations/4-reliability.md) for the
watchdogs that supervise them.

## Capacity and limits

The server is built and operated for the envelope below. It has **not** been
tested or designed for anything beyond it — treat these as the supported ceiling,
not a target to exceed :)

| Limit | Supported ceiling |
|-------|-------------------|
| Inputs (pipelines) | up to **50** |
| Outputs (forwards) | up to **500** total — enforced: creating a 501st returns `409` |
| Outputs using custom (transcoding) encoding | only **a few** at a time — see below |
| Parallel dashboard clients | up to **~10** |

Past these figures, expect host CPU/RAM/network and the number of concurrent
FFmpeg processes (one per output) to become the limiting factors well before the
dashboard or API does.

**Keep almost all outputs in `copy` mode.** A `copy` output is a passthrough — it
remuxes the input and forwards it with negligible CPU cost, so hundreds can run on
modest hardware. A custom encoding (`720p`, `1080p`, `vertical_rotate`, …) makes
FFmpeg transcode the video, which is CPU-intensive: each such output consumes
roughly a full core's worth of work. **Only a handful of outputs should use custom
encoding at any one time**; everything else should be `copy`. Putting many outputs
into custom-encoding mode will saturate the CPU long before the 500-output ceiling
and starve the `copy` outputs and the dashboard alike.

**Parallel dashboard clients.** Health is computed once every 5s and shared by
all clients, so extra browser tabs do not multiply SRS/SRT-FFprobe work. API
responses are gzip-compressed, and config changes from another session are
picked up automatically via the health poll's config revision. Around 10
simultaneous dashboard clients is fine; higher counts are not tuned or tested.

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
