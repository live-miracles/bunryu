# Outputs

An **output** forwards one pipeline to one destination. Each output is a separate
FFmpeg process, so a destination that fails or stalls never affects the others.
Outputs that need the same encode also share one more FFmpeg process, see
[Shared encodes](#shared-encodes).

## Destinations

An output URL can be `rtmp://`, `rtmps://` or `srt://`. The output editor has
presets for common platforms (for example YouTube RTMP), where you only paste
the stream key.

For safety, outputs never connect to link-local addresses such as cloud
metadata endpoints, and connect to loopback only on the server's own RTMP/SRT
ports. The latter allows pipeline-to-pipeline restreams, for example feeding a
second pipeline from an output of the first. See
[Security](../3-operations/1-security.md) for the full rules.

## Video encoding

| Encoding | What it does | CPU cost |
|----------|--------------|----------|
| `copy` | Passthrough: the video is forwarded as received | Negligible |
| `720p` | Scales to 1280×720, H.264 (`veryfast`, 3 Mbps) | About one core per encode |
| `1080p` | Scales to 1920×1080, H.264 (`veryfast`, 5 Mbps) | About one core per encode |
| `vertical_rotate` | Scales to 720 px wide and rotates 90° for vertical platforms (Shorts, Reels) | About one core per encode |

Keep almost all outputs in `copy` mode and only a few distinct encodes on a
transcoding profile. Ten outputs on `720p` with the same audio track are one
[shared encode](#shared-encodes), so they cost about one core, not ten; see
[Capacity and limits](../1-getting-started/1-introduction.md#capacity-and-limits).

## Audio

| Audio setting | Result |
|---------------|--------|
| `copy` | Forwards the input's default audio track unchanged |
| Track number (`0`, `1`, ...) | Forwards that track, re-encoded to AAC 128 kbps stereo 48 kHz. Outputs on the same track (and video encoding) share the encode |
| Several tracks (`0,1`) | Forwards each listed track; SRT destinations only, since RTMP carries a single audio track. Never shared: each output encodes on its own |
| `translation` | Mixes a translator pipeline's audio over the source; see [Translation outputs](3-translation.md). Never shared |

When an SRT input is forwarded to an RTMP destination, select a track instead of
`copy`: re-encoding absorbs the timestamp jitter that SRT inputs can carry, and
the dashboard warns on outputs that don't.

## Shared encodes

Outputs on the **same pipeline** that need the **same encode** share it: one
FFmpeg pulls the input, encodes once, and the outputs forward the result in copy
mode. Ten RTMP outputs on audio track 1 of an SRT input make one SRT pull and one
AAC encode, not ten. Operators used to loop an SRT pipeline into a second pipeline
to get this; that workaround is no longer needed.

```
pipeline input ──► shared encode "720p · track 1" (encodes once)
                      ├──► output A (copy) ──► destination A
                      └──► output B (copy) ──► destination B
               ──► output C (copy video, source audio): pulls the input directly
```

**What is shared.** Two outputs share when their *recipe* is identical: the same
video encoding and the same single audio selection.

| Output | Shared? |
|--------|---------|
| Video `copy` and audio `copy` (plain passthrough) | No: pulls the input directly, as before |
| Any video encoding (`720p`, `1080p`, `vertical_rotate`) with audio `copy` or one track | Yes, with outputs of the same recipe on this pipeline |
| Video `copy` with one audio track | Yes |
| Several audio tracks (`0,1`) | No: RTMP/FLV carries one audio track, so these keep their own encode |
| `translation` | No: owned by the translation mixer |

A recipe used by a single output is still shared: it costs one extra copy FFmpeg
(about 12–16 MB and a few percent CPU) in exchange for one code path.

**You don't manage them.** The server creates a shared encode when the first
output with that recipe is added, removes it when none is left, starts it with the
first running output, and stops it 15 seconds after the last one stops (so
stopping and restarting an output, or editing one, does not restart the encode
that its other outputs use). You cannot create, edit, delete, start or stop one,
and you cannot point an output at the server's internal `internal` RTMP app. They
do not count toward the 500-output limit.

**In the dashboard.** The pipeline's side column shows a **Shared encodes** card
with one row per encode: status, name, uptime, bitrate | CPU | memory, how many
outputs use it and how many are reading it right now, the failure count and the
last error. **History** opens its Error History and **Restart** restarts it after a
confirmation; its outputs reconnect. Outputs that use one show a **shared** badge,
and while their encode is not up they show a warning ("Waiting for shared
encode …", or "Shared encode … failed: …") rather than an error. The pipeline's
"N readers" counts only what reads the input itself, so it no longer includes
outputs that read a shared encode.

**When a shared encode fails,** every output that uses it is restarted and waits
for the encode to come back; each of them gets one Error History record "Shared
encode … failed: …" naming the cause, so its card explains the reconnect. Other
recipes, other pipelines and outputs that read the input directly are not
affected. See [Reliability](../3-operations/4-reliability.md#shared-encodes).

**Trade-offs.**
- Starting a shared output takes longer than a direct one when its encode is not
  running yet: the encode starts first and the output connects once it is writing
  data. Measured: about 5 s from the encode's start to its first output. With the
  encode already running an output starts at once, so an output stopped and started
  again within the 15 s grace, or a further output of the same recipe, reuses it.
- The encode is a single point of failure for its outputs: when it restarts, all
  of them reconnect at once.
- CPU is counted once per recipe per pipeline. Sharing is never across pipelines.
- Outputs get ids with gaps (the encode takes a number in the pipeline's sequence).

## Running outputs

Start and stop outputs individually or for the whole pipeline. **Start all**
starts them staggered at 200 ms intervals. An output's desired state is saved,
so outputs that were running are started again automatically when the input
comes back or the server restarts.

The output card shows status, uptime, bitrate, CPU and memory (and a **shared**
badge when it pulls a [shared encode](#shared-encodes)). Problems appear on
the card as warnings, and every crash, watchdog restart and finished warning
episode is kept in the output's **Error History** with the FFmpeg stderr tail.
See [Reliability](../3-operations/4-reliability.md) for what is detected and when
outputs are restarted.
