# Outputs

An **output** forwards one pipeline to one destination. Each output is a separate
FFmpeg process, so a destination that fails or stalls never affects the others.

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
| `720p` | Scales to 1280×720, H.264 (`veryfast`, 3 Mbps) | About one core |
| `1080p` | Scales to 1920×1080, H.264 (`veryfast`, 5 Mbps) | About one core |
| `vertical_rotate` | Scales to 720 px wide and rotates 90° for vertical platforms (Shorts, Reels) | About one core |

Keep almost all outputs in `copy` mode and only a few on a transcoding profile;
see [Capacity and limits](../1-getting-started/1-introduction.md#capacity-and-limits).

## Audio

| Audio setting | Result |
|---------------|--------|
| `copy` | Forwards the input's default audio track unchanged |
| Track number (`0`, `1`, ...) | Forwards that track, re-encoded to AAC 128 kbps stereo 48 kHz |
| Several tracks (`0,1`) | Forwards each listed track; SRT destinations only, since RTMP carries a single audio track |
| `translation` | Mixes a translator pipeline's audio over the source; see [Translation outputs](3-translation.md) |

When an SRT input is forwarded to an RTMP destination, select a track instead of
`copy`: re-encoding absorbs the timestamp jitter that SRT inputs can carry, and
the dashboard warns on outputs that don't.

## Running outputs

Start and stop outputs individually or for the whole pipeline. **Start all**
starts them staggered at 200 ms intervals. An output's desired state is saved,
so outputs that were running are started again automatically when the input
comes back or the server restarts.

The output card shows status, uptime, bitrate, CPU and memory. Problems appear on
the card as warnings, and every crash, watchdog restart and finished warning
episode is kept in the output's **Error History** with the FFmpeg stderr tail.
See [Reliability](../3-operations/4-reliability.md) for what is detected and when
outputs are restarted.
