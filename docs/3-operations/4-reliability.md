# Reliability

Bunryu is designed to keep running through long live events: failures are
isolated to one output, recovered automatically where it is safe, and recorded
so they can be explained afterwards. This page describes the recovery loops and
the failure modes they handle.

## Watchdogs

The app runs these recovery loops:

| Watchdog | Scope | Restart condition | Notes |
|----------|-------|-------------------|-------|
| Health poll / input recovery | SRS reachability, live pipeline inputs, desired running outputs | When SRS and the pipeline input become ready, outputs whose desired state is `running` are started or restarted with staggered timing | Computed once every 5s and shared by dashboard clients. Inputs become live from SRS publisher presence; ffprobe fills in media/track metadata and retries every `FFPROBE_FAILED_REFRESH_MS` until it succeeds, then stops for that publisher. |
| Output progress watchdog | Every running FFmpeg output process | After warmup, if the input is ready but FFmpeg `total_size` / `out_time_ms` stop advancing for the configured stall window | Protocol-agnostic backstop; covers SRT outputs and local RTMP relays |
| Remote RTMP socket watchdog | Running outputs with a remote RTMP/RTMPS destination | After socket warmup and grace, if the destination socket is missing or remains in a closing state such as `CLOSE-WAIT` | Uses one `ss -H -tanp` snapshot per watchdog interval; a local RTMP/RTMPS destination is ignored because local input/output sockets are ambiguous |
| Output memory watchdog | Every running FFmpeg output process, including translation mixers (checked every 5 s; a mixer over its limit is restarted with a `translation-mixer-restart` event, reason `memory limit exceeded`) | After warmup, if process RSS crosses `memory_limit_mb` (or its per-encoding override) | Reads `/proc/<pid>/status`; unconditional — a leaking process can still show advancing `total_size`/healthy sockets, so this doesn't wait on the other two. Once RSS crosses 70% of the limit the output surfaces a yellow "High memory usage" warning in the dashboard, before the watchdog actually restarts it at 100%. The limit is doubled for outputs on a 4K (≥3840px on either dimension) input — the 2x multiplier is a placeholder, not a measured baseline; see [#11](https://github.com/live-miracles/bunryu/issues/11) |
| Translator audio meter watchdog | Running translation-mixer outputs | After the same startup warmup grace as the output progress watchdog, if the translator audio meter has gone quiet for `translator_meter_stale_ms` (including a translator that never delivered a single sample) | Watches independently of the SRS live-state poll, so a translator that connects but sends a dead/silent track is still caught. Valid translator silence is not treated as a disconnect — FFmpeg continues emitting silent meter samples in that case — so this only fires when the meter itself stops updating. Restarts the mixer so it attaches to the current translator session. |

All output watchdogs above use the same restart path: they write a detailed
`last_error`, kill the stuck FFmpeg process, and let the normal retry loop start a
fresh process while the output's desired state remains `running`. The socket
watchdog is advisory: if `ss` fails or times out, it does not restart anything,
and a socket warning does not prevent the other watchdogs from acting.

Input media validation is separate from the output watchdogs. The health service
stays on the regular 5s poll, but ffprobe backs off once a publisher's probe
succeeds:

| Input check | Scope | Cadence | Notes |
|-------------|-------|---------|-------|
| Media validation | Connected RTMP/SRT inputs without a successful probe yet for this publisher | Immediate probe (staggered across pipelines), then retried every `FFPROBE_FAILED_REFRESH_MS` (30s) while it keeps failing | Stops re-probing once a probe succeeds for the current publisher; a new probe cycle starts on the next publisher change. Every failed probe is written to diagnostics as `media-probe-failed` (reason `timeout`/`exit`/`parse`/`unusable`, elapsed time, exit status, ffprobe stderr tail) and the first failure and the later recovery per publisher are added to the pipeline log (`probe_failed` / `probe_recovered`). Input liveness and output recovery do not wait for a valid ffprobe result — ffprobe fills in media/track details when available. |

## Input timestamp fault detection

The server detects when an input's audio/video timestamps become inconsistent
(for example after an encoder drops and reconnects with its audio and video
clocks out of step). FFmpeg reports this on every copy output as
`timestamp discontinuity` / non-monotonous or invalid DTS warnings, at up to tens
of lines per second per output, so the control plane groups them instead of
logging each line:

| Stage | Trigger | What is recorded and shown |
|-------|---------|----------------------------|
| Warning | First timestamp warning of a kind on an output | `ffmpeg-timestamp-warning` diagnostics event with the FFmpeg line (one per distinct kind per burst, at most 8); the output shows a yellow warning |
| Summary | Further warnings in the same burst | One `ffmpeg-timestamp-warning-summary` event every 30 s with the suppressed line count per kind, so the volume stays small while the total stays exact |
| Recovered | No timestamp warning for 30 s | `ffmpeg-timestamp-recovered` event with duration and total count. If the process exits mid-burst, the burst's duration and count are added to the `ffmpeg-exited` event instead |

Decode-error lines (`non-existing PPS`, `decode_slice_header error`, `corrupt
input`) go through the same grouping, but are treated as less serious, since
they also appear briefly when an output joins mid-GOP: FFmpeg probes the
stream before the next keyframe has delivered SPS/PPS, so for a second or two
it cannot decode and prints these lines (even in copy mode). This is expected
and harmless. A decode-only burst shorter than 10 s is treated as this routine
join noise: it is not shown on the output card and not written to History (the
diagnostics events still record it). Longer ones are shown and recorded.

Warnings stay output warnings: there is deliberately no pipeline-level "input is
unstable" alert, and nothing is written to the pipeline **History** (which is for
input and pipeline issues only), because the cause (encoder, network, relay or the
output itself) cannot be told from the warnings alone. Each finished burst (a
timestamp burst, or a decode-only burst of 10 s or more; stopped after 30 s of
quiet, or ended with the ffmpeg exit) is recorded in the output's own **Error
History** (the error button on the output) as a `warning` record with the duration,
warning count and first line. Per output, each class of burst is recorded at most
once per 10 minutes, and the diagnostics events always carry every burst. That
history keeps the last 10 records per output, of which at most 5 may be warnings, so
warnings can never push crashes and stops out; warnings never count as the output's
current error. Crashes, watchdog restarts and stops are recorded there as before.

The warnings that otherwise only show on the output card are recorded the same way,
once per episode: high memory usage (70 % or more of the output's limit), an
unhealthy destination socket, and the FFmpeg media clock running fast. An episode
logs an `ffmpeg-warning-started` diagnostics event, and when it clears (or the
process exits) an `ffmpeg-warning-ended` event with the duration plus one `warning`
record in the output's Error History. These share the 5 warning slots and the
10-minute-per-kind limit above. A warning that escalates to a watchdog restart
therefore appears twice: the build-up as a `warning`, then the restart as a crash.

This is detection and reporting only: outputs are not restarted automatically,
because the offset originates in the incoming stream and restarting would drop
the destination connections during a live event. The fix is on the encoder side; in the
observed incident, reconnecting the encoder cleared the condition.

## Encoder restarts do not restart outputs

When an encoder stops and reconnects (for example a manual ffmpeg restart), the
pipeline's input reconnects but its **outputs keep running and are not restarted**.
If the encoder's timeline restarted (timestamps back near 0), the running outputs
see a discontinuity and may log timestamp warnings until the condition clears (see
[Input timestamp fault detection](#input-timestamp-fault-detection)); restarting the
outputs by hand clears it, at the cost of dropping the destination connections.

Restarting outputs automatically whenever the input restarts is **not implemented**
because the server cannot reliably tell an encoder restart from a network
interruption, and restarting after a mere network drop would add downtime to a line
that would otherwise have recovered on its own. This was tested (SRS 6.0.184 and the
Goryu, RTMP, SRT and bonded SRT inputs; network faults simulated with a
userspace proxy that silently drops traffic, not kernel firewall rules, so RST/ICMP
failures and NAT remapping were not covered) and **no deterministic signal exists**:

- **Source ports do not distinguish them.** Every new connection gets a fresh
  ephemeral source port — on every bonded leg too — whether the encoder was restarted
  or reconnected after an outage. A port only survives when the connection never
  broke (an SRT outage shorter than about 5 s causes no disconnect and no event).
- **SRS hooks carry no cause.** `on_publish` / `on_unpublish` / `on_close` include the
  client id, IP, stream and `tcUrl`, but no port and no reason.
- **A killed or crashed encoder looks like a network loss.** For SRT the server sees
  about 5 s of silence followed by `6002 SrtTimeout` in both cases. (Over RTMP a
  killed process still closes its TCP connection, so it looks like a clean stop, while
  a network loss is only detected after about 18 s.)
- **Behind Goryu SRS sees nothing useful.** The relay always closes its
  downstream side gracefully, so SRS logs the same `6001 SrtIo` for every end of a
  bonded stream. Only the relay's own data differs.

Only weak, heuristic signals exist: a graceful stop closes within about a second
whereas a network loss or kill closes after about 5 s (SRT) or about 18 s (RTMP) of
silence, and on a bonded input a single leg disappearing from the relay's `/status`
while the group stays up points to a network problem on that leg rather than a
restart. These are not reliable enough to trigger an output restart on. A more
dependable basis for any future automatic restart would be the media timeline itself
(did timestamps jump or reset on reconnect?) rather than guessing the cause.

## SRT-input output stalls

The input is pulled back over its own protocol, so an output on an **SRT input**
always pulls over SRT. When the destination rejects such a stream (e.g. a wrong
YouTube stream key) or drops the RTMP connection mid-publish, ffmpeg can get
stuck instead of exiting. An output on an **RTMP input** (pulled over RTMP)
usually exits ffmpeg immediately with a clear error (`Error opening output files:
Input/output error`).

The difference is timing: with RTMP pull, input stream info is available right
away, so ffmpeg opens the destination immediately and the rejection surfaces at
`write_header` time, exiting non-zero. With SRT pull, ffmpeg must first probe the
MPEG-TS input; by the time it connects, the destination accepts the handshake
then drops the connection mid-publish, and ffmpeg deadlocks — SRT's large input
buffers keep the input thread fed, so the broken-pipe error on the output write
may not propagate promptly. The process can stay alive while buffering input and
consuming RAM even though the external output is no longer uploading.

**How it is handled:** the output service tracks ffmpeg's `-progress pipe:1`
fields (`total_size`, `out_time_ms`, and `bitrate`) plus the stderr tail. It also
takes a single local TCP socket snapshot (`ss -H -tanp`) every watchdog interval
and maps RTMP/RTMPS destination sockets back to each ffmpeg pid. After a warmup
period, an output is marked yellow if its destination socket is missing or in a
closing state such as `CLOSE-WAIT`; if that persists past the socket grace
window, the watchdog records `last_error`, kills that ffmpeg process, and lets
the normal retry loop start a fresh output. The same retry path is used when the
input is live but ffmpeg output bytes/time stop advancing for a sustained window.
The dashboard shows the warning/restart reason and timestamp; the error details
include the pid, stall duration, last ffmpeg progress values, and stderr tail.

**Limitation:** the watchdog monitors aggregate ffmpeg output progress and
pid-level TCP socket state for the process. Local RTMP/RTMPS outputs are excluded
from the TCP socket check because ffmpeg's local input pull and local output push
both connect to local SRS and are ambiguous in `ss`; those relays are still
covered by the output-progress watchdog.

## FFmpeg memory leaks on corrupt input

On a glitchy SRT input (real packet loss/corruption upstream, not a passphrase or
config issue — see the incident write-up below), FFmpeg's AAC decoder can
misparse a corrupted frame as a bogus multichannel layout (logged as `[SWR]
Full-on remixing from 22.2 has not yet been implemented!`). Reinitializing the
resampler for that bogus layout leaks memory instead of failing cleanly, and RSS
can grow unbounded — observed reaching 1.5-1.6GB before the kernel OOM-killer
stepped in.

That kernel-level kill is the actual danger, not the leak itself: FFmpeg output
processes share a cgroup with the `bunryu` control-plane service, so
systemd treats any OOM kill inside that cgroup as the whole service failing and
restarts it — which cascades (via `Requires=`) into restarting SRS and
Goryu too, forcing every stream on the box to reconnect simultaneously.
That mass reconnect can reintroduce the same corrupt-resync conditions on another
output, repeating the cycle. Full timeline and log evidence from the 2026-07-10
incident: [`fail-reports/2026-07-10-pipeline1-output-oom-cascade.md`](../../fail-reports/2026-07-10-pipeline1-output-oom-cascade.md).

**How it is handled:** two layers. `buildFfmpegArgs` passes `-fflags
+discardcorrupt -err_detect crccheck+bitstream` so packets already flagged
broken by the demuxer are dropped before reaching the decoder, reducing (but not
eliminating) the chance of the misparse happening at all. As a hard backstop,
the output memory watchdog (see the watchdogs table above) kills and restarts an
output once its RSS crosses `memory_limit_mb` (default 200 MB for `copy`
outputs, about 2-3x a healthy output's normal 65-90 MB baseline, with higher
per-encoding limits for transcoding profiles; far below the 1.5 GB+ range where
the kernel OOM-killer struck) — well before the kernel ever needs to get
involved, so the cascading restart doesn't happen.

## Why Goryu exists

The relay exists to work around two constraints:

1. **ffmpeg cannot accept bonded SRT group connections.** ffmpeg's SRT handler does not set `SRTO_GROUPCONNECT=1` on its listener socket, so bonded connection attempts from encoders like AJA Bridge Live are rejected at the handshake level.

2. **SRS has no native SRT bonding support.** SRS accepts normal SRT publishers, but it does not accept bonded/redundant SRT groups directly.

**How it is fixed:** `goryu` starts as its own systemd service, listens on `10081` with `SRTO_GROUPCONNECT=1`, accepts each bonded source session, reads its incoming `streamid`, and opens a normal SRT publisher connection to SRS using the same `streamid`. It only connects to SRS after an encoder connects, so SRS's idle-publisher timeout is not triggered by an empty boot-time publisher.
