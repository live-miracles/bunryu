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
| `copy` | Passthrough: the video is forwarded as received | About 0.04 vCPU per 8 Mbps output |
| `720p` | Scales to 1280×720, H.264 (`veryfast`, 3 Mbps); meant for down-converting a 1080p input | About 2 vCPUs per encode (1080p50 input) |
| `1080p` | Scales to 1920×1080, H.264 (`veryfast`, 5 Mbps); meant for down-converting a 4K input | About 6 vCPUs from a 4K50 input (does not keep up on 4) |
| `vertical_rotate` | Scales to 720 px wide and rotates 90° for vertical platforms (Shorts, Reels); usually applied to a 1080p input | About 1.2 vCPUs per encode (1080p50 input) |

Keep almost all outputs in `copy` mode and only a few distinct encodes on a
transcoding profile. Ten outputs on `720p` with the same audio track are one
[shared encode](#shared-encodes), so they cost one encode, not ten. The costs are
measured on a GCP `n2` and depend on the content; see
[Sizing a server](../1-getting-started/4-sizing.md) and
[Capacity and limits](../1-getting-started/1-introduction.md#capacity-and-limits).

## Audio

| Audio setting | Result |
|---------------|--------|
| `copy` | Forwards the input's default audio track unchanged |
| Track number (`0`, `1`, ...) | Forwards that track, re-encoded to AAC 128 kbps stereo 48 kHz. Outputs on the same track (and video encoding) share the encode |
| Several tracks (`0,1`) | Forwards each listed track; SRT destinations only, since RTMP carries a single audio track. Never shared: each output encodes on its own |
| `translation` | Beta. Mixes a translator pipeline's audio over the source; see [Translation outputs](3-translation.md). Never shared |

When an SRT input is forwarded to an RTMP destination, select a track instead of
`copy`: re-encoding absorbs the timestamp jitter that SRT inputs can carry, and
the dashboard warns on outputs that don't.

For an RTMP input forwarded to an RTMP destination, keep `copy`: selecting Track 1
only adds the AAC re-encode (extra CPU) with no timing benefit, and the dashboard
warns on outputs that do it.

## Shared encodes

Outputs on the **same pipeline** that need the **same encode** share it: one
FFmpeg pulls the input, encodes once, and the outputs forward the result in copy
mode. Ten RTMP outputs on audio track 1 of an SRT input make one SRT pull and one
AAC encode, not ten. Operators used to loop an SRT pipeline into a second pipeline
to get this; that workaround is no longer needed.

```
pipeline input ──► shared encode "720p · T2" (encodes once)
                      ├──► output A (copy) ──► destination A
                      └──► output B (copy) ──► destination B
               ──► output C (copy video, source audio): pulls the input directly
```

**What is shared.** Outputs share when their *recipe* is identical (the same
video encoding and the same single audio selection) **and at least two outputs of
the pipeline are configured with it**, whether they are running or not.

| Output | Shared? |
|--------|---------|
| Video `copy` and audio `copy` (plain passthrough) | No: pulls the input directly, as before |
| Any video encoding (`720p`, `1080p`, `vertical_rotate`) with audio `copy` or one track | Yes, once a second output of the pipeline has the same recipe |
| Video `copy` with one audio track | Yes, once a second output of the pipeline has the same recipe |
| Several audio tracks (`0,1`) | No: RTMP/FLV carries one audio track, so these keep their own encode |
| `translation` | No: owned by the translation mixer |

A recipe used by a single output is **not** shared: that output encodes on its
own, as it always did, because an encode with one reader would only add a process
(about 28 MB), a few seconds to its start, and an extra hop. Usually all outputs are
configured before the event, so the rule is decided by the saved configuration.

**You don't manage them.** The server creates a shared encode when a second
output with the same recipe is configured, removes it when fewer than two are
left, starts it with the first running output, and stops it 15 seconds after the
last one stops (so stopping and restarting an output, or editing one, does not
restart the encode that its other outputs use). You cannot create, edit, delete, start or stop one,
and you cannot point an output at the server's internal `internal` RTMP app. They
are not counted among your outputs.

**In the dashboard.** The pipeline's side column has a **Shared encodes** card
with one row per encode, laid out like an output card: status, a restart button
(after a confirmation; its outputs reconnect), the encoding as badges (the video
encoding unless it is `copy`, and the audio track as `T1`, `T2`, …, where `T1` is
track 0), how many outputs use it and how many are reading it now ("2 outs · 1
read"), uptime, bitrate, CPU, memory, the failure count and **History**, followed by the last error. While an output's encode is not up, the
output shows a warning ("Waiting for Shared encode …", or "Shared encode failed:
…"), not an error. The pipeline's "N readers" counts only what reads the input
itself, not outputs that read a shared encode.

**When a shared encode fails,** every output that uses it is restarted and waits
for the encode to come back; each of them gets one History record "Shared
encode … failed: …" naming the cause, so its card explains the reconnect. Other
recipes, other pipelines and outputs that read the input directly are not
affected. See [Reliability](../3-operations/4-reliability.md#shared-encodes).

**Changing the configuration while outputs are running.** An output decides how it
runs when it *starts* and never switches while running. For that reason the
editor of a running output disables the destination, encodings and translation
settings and lets you change only its name; stop the output to change the rest.
- If an output was already running alone and you add a second output with the same
  recipe, the shared encode starts at once, but the first output keeps encoding on
  its own until it is next started or restarted; the new output reads the shared
  encode. Until then you run two encodes (the shared card shows "0 readers" if the
  second output is not started yet).
- If you delete or change an output so that only one with the recipe is left, a
  shared encode that outputs are still reading is kept until they stop or restart,
  so the output that is still running is not interrupted. When it next starts it
  runs on its own.

**Trade-offs.**
- A shared output starts slower than a direct one when its encode is not running
  yet: the encode starts first and the output connects once it is writing data
  (about 5 s measured). With the encode already running an output starts at once,
  so an output restarted within the 15 s grace, or a further output of the same
  recipe, reuses it.
- The encode is a single point of failure for its outputs: when it restarts, all
  of them reconnect at once.
- Sharing is per pipeline, never across pipelines.
- Output ids have gaps, because the encode takes a number in the pipeline's
  sequence.

## Running outputs

Start and stop outputs individually or for the whole pipeline. **Start all**
starts them staggered at 200 ms intervals. An output's desired state is saved,
so outputs that were running are started again automatically when the input
comes back or the server restarts.

### Overview

The dashboard's **Overview** lists every input and every output in two tables. The
**All**, **Active** and **Issues** tabs narrow both: Active hides what is offline or
stopped, and Issues keeps only warnings and errors, plus an offline input whose outputs
are affected, with the reason. The search box on each table's heading line filters it by
name as you type; an output matches on its own name or its pipeline's. The heading badge
shows how many rows are left ("20 of 500").

The output card shows status, uptime, bitrate, CPU and memory. When the output's speed
(media produced per second of wall time, 1.00x is realtime, measured over 30 s windows)
is below 0.95x the badge adds it in yellow ("0.88x"); above 1.05x it adds it in the
normal color, which is usually a backlog draining after a stall. In between, and
always, the badge's tooltip shows it. The speed is not shown for the first minute after a
start. An output that failed
shows its failed attempts since it was last started and, while it waits to try again,
when the next attempt is due ("retry in 8 s"). Problems appear on
the card as warnings, each with the time it began ("since 09:18"), and every crash, watchdog restart and finished warning
episode is kept in the output's **History** with the FFmpeg stderr tail,
together with every stop and every start you make with **Start** (a "started" record).
Both this history and the pipeline's **History** list the oldest entry first and open scrolled to the newest, like the logs.
A crash that repeats the same way (a different pid or uptime does not count as
different) is one record with a count ("×19"), its first and latest time and the
detail of the first. The History button and the card are red while the latest record
is a crash or watchdog restart. When the output has then run for a minute and is
writing data, the crash is marked **recovered** (with the time), the card and the
button return to the normal color and the retry count starts over; the record stays in
the History. A record that holds a long FFmpeg log shows only its error line (the last
line, as on the card) with **Show full log** to expand it, and its copy button puts the
whole log on the clipboard. After a stop, or with only warnings, the button keeps the normal color. The exception is an
output you stop after 5 failed attempts in a row: its card keeps a red "Stopped
after 5 failed attempts" line with the last error, and the History button stays red,
until you start the output again.
Under a known error or warning (connection refused, a rejected stream key, an
unresolvable host, a failed SRT handshake, an output falling behind realtime) the card
adds an info icon to the line; hover or focus it for a "Hint:" with what to check first.
The pipeline alerts show their hint as a muted line. An error it has no advice for is
shown as is.
See [Reliability](../3-operations/4-reliability.md) for what is detected and when
outputs are restarted.

### Alert sound

The dashboard beeps for 5 s when something goes wrong that needs attention: an output
crashes or is restarted by a watchdog, an input goes offline while its outputs are
running, a pipeline raises an error alert, the server, SRS or the SRT relay becomes
unreachable, or the host runs low on memory or disk space. It beeps when the problem appears, not while it lasts, and an output that
keeps failing beeps only when it starts failing. Warnings and the host CPU alert do not
beep; the host alerts are listed in Server Logs under Server events.

The bell in the navbar mutes and unmutes the beeps; hover it for the volume slider.
Both settings are kept in the browser and shared by tabs on the same site. The dashboard
tries to enable audio when it opens. Some browsers require a click or key press before
they allow sound; the bell still shows your saved mute setting. See [the design decision](../4-reference/3-design-decisions.md#alert-sound-beeps-for-new-problems-only-in-the-browser).
