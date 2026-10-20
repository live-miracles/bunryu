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
| Output memory watchdog | Every running FFmpeg output process, including translation mixers (checked every 5 s; a mixer over its limit is restarted with a `translation-mixer-restart` event, reason `memory limit exceeded`) | After warmup, if process RSS crosses `memory_limit_mb` (or its per-encoding override) | Reads `/proc/<pid>/status`; unconditional — a leaking process can still show advancing `total_size`/healthy sockets, so this doesn't wait on the other two. Once RSS crosses 70% of the limit the output surfaces a yellow "High memory usage" warning in the dashboard, before the watchdog actually restarts it at 100%. The limit is doubled for outputs on a 4K (≥3840px on either dimension) input — the 2x multiplier was checked against measured 4K baselines (RSS: copy with AAC audio 56 MB and 129 MB at start, `vertical_rotate` 472 MB, `720p` 608 MB, `1080p` 940 MB), so the doubled limits sit about 3x above copy and 1.9–2.1x above the encodes |
| Shared encode reconciler | One row per recipe (video encoding + single audio selection) that at least two outputs of a pipeline are configured with | Every second: creates missing rows, removes rows no output uses, starts a shared encode with its first running output, stops it 15 s after the last one | See [Shared encodes](#shared-encodes) below. Start is only requested on the stopped-to-running edge, so it never resets the output's retry back-off; a failing start is retried at most every 30 s |
| Translator audio meter watchdog | Running translation-mixer outputs | After the same startup warmup grace as the output progress watchdog, if the translator audio meter has gone quiet for `translator_meter_stale_ms` (including a translator that never delivered a single sample) | Watches independently of the SRS live-state poll, so a translator that connects but sends a dead/silent track is still caught. Valid translator silence is not treated as a disconnect — FFmpeg continues emitting silent meter samples in that case — so this only fires when the meter itself stops updating. Restarts the mixer so it attaches to the current translator session. |

All output watchdogs above use the same restart path: they write a detailed
`last_error`, kill the stuck FFmpeg process, and let the normal retry loop start a
fresh process while the output's desired state remains `running`. The socket
watchdog is advisory: if `ss` fails or times out, it does not restart anything,
and a socket warning does not prevent the other watchdogs from acting.

**Outputs that never stay up.** An output retries indefinitely (back-off 1, 2, 4, 8
then 16 s). If it is stopped after 5 failed attempts in a row, none of which stayed
up for 60 s, the stop is recorded with the count and the last failure ("Stopped
after 5 failed attempts. Last error: Connection refused"), the output's card keeps
showing that line in red, and its History button stays red, until the output is
started again. A plain stop, or a run that lasted at least 60 s, leaves no such
mark. The stop also writes an `output-stopped-after-failures` diagnostics event.

Input media validation is separate from the output watchdogs. The health service
stays on the regular 5s poll, but ffprobe backs off once a publisher's probe
succeeds:

| Input check | Scope | Cadence | Notes |
|-------------|-------|---------|-------|
| Media validation | Connected RTMP/SRT inputs without a successful probe yet for this publisher | Immediate probe (staggered across pipelines), then retried every `FFPROBE_FAILED_REFRESH_MS` (30s) while it keeps failing | Stops re-probing once a probe succeeds for the current publisher; a new probe cycle starts on the next publisher change. Every failed probe is written to diagnostics as `media-probe-failed` (reason `timeout`/`exit`/`parse`/`unusable`, elapsed time, exit status, ffprobe stderr tail) and the first failure and the later recovery per publisher are added to the pipeline log (`probe_failed` / `probe_recovered`). Input liveness and output recovery do not wait for a valid ffprobe result — ffprobe fills in media/track details when available. |

**Control-plane errors.** The health poll, the output watchdog and the host probes
each catch errors from their own tick and run again on the next one. They log the
first failure (and any new error) and a recovery event with the count, not one line
per tick. An error that escapes everything else is logged as
`uncaught-exception` / `unhandled-rejection` and the process keeps running, because
exiting would stop every output. A startup failure is the exception: if the hook or
dashboard port cannot be bound, the app writes `server-start-failed` and exits so
systemd restarts it, instead of running without a dashboard. A diagnostics write
failure (disk full, directory unwritable) drops and counts events instead of
crashing; see
[Configuration](3-configuration.md).

## Shared encodes

Outputs on one pipeline that need the same encode share one FFmpeg, a *shared
encode* (see [Outputs](../2-usage/2-outputs.md#shared-encodes)). It is an ordinary
output row, so it is supervised exactly like one: the same retry back-off
(1, 2, 4, 8, then 16 s, without limit), output progress, memory and socket
watchdogs (with the memory limit of its video encoding), Error History and
diagnostics. The outputs that read it are ordinary outputs that copy from it.

- **When an encode exists.** Only when at least two outputs of a pipeline are
  configured with the same recipe (running or not). An output decides at start
  whether it reads the encode and never switches while running, so configuration
  changes settle the next time an output starts: a running output that was alone
  keeps its own encode (the new encode starts at once and may run with no reader
  until the second output is started), and an encode that outputs are still reading
  is kept when the count drops below two (diagnostics event
  `rendition-removal-deferred`, once) and removed when they stop, so editing or
  deleting one output never interrupts another. A lone output pulls the input
  directly and is not affected by anything below.
- **Blast radius: one recipe on one pipeline.** A failing shared encode restarts the
  outputs that read it, and nothing else: not other recipes, other pipelines,
  outputs reading the input directly, or the input.
- **Readiness is local.** A shared encode is ready when its FFmpeg is running and
  has written data (`total_size` above 0), which also means SRS accepted its
  publish. Outputs that read it wait for that, re-checking every second without
  counting a failure or spawning anything, and also wait while the input is down,
  like direct outputs. The first outputs therefore start a few seconds after the
  encode does.
- **When it exits on its own** (crash, a watchdog restart, a refused publish), each
  output that reads it that is running is stopped and rescheduled through the normal
  retry path and waits for the encode; each such output, running or already
  waiting, gets one Error History record "Shared encode … failed: …" with the exit
  status or the watchdog reason and the stderr tail, and no second crash record for
  its own stop. The diagnostics event `rendition-dependents-restarted` lists them.
  A deliberate stop does not do this: an idle stop happens only when no reader is
  running, and a restart by the user restarts the readers on purpose (below).
- **While the input is down** the encode and its outputs are left running, as for
  direct outputs, and their watchdogs do not act: an output's watchdog also pauses
  while its shared encode is not ready, because a missing feed is then not that
  output's fault. One consequence: SRS closes a publisher that sends nothing for 5 s
  (`rtmp: publish timeout 5000ms`), so an input outage longer than that makes SRS
  drop the shared encode's internal publish. The FFmpeg process stays up and fails
  with `Broken pipe` when data returns, which restarts it and its outputs (the
  "exits on its own" case above, so each output records "Shared encode … failed: …
  Broken pipe"). Measured with an RTMP input stopped for 40 s: nothing restarted
  during the outage, and the outputs were reading again 4 s after the input came back.
  Direct outputs are not affected, since they only read.
- **Idle stop with a 15 s grace.** The encode runs while at least one output that
  uses it is desired running and stops 15 s after the last one stops. The timer is
  in memory: after an app restart an encode with no running output stops 15 s later.
- **Restart from the dashboard** (or `POST …/outputs/:outId/restart`) stops the
  outputs that read the encode first, then the encode, all recorded as deliberate
  stops ("Shared encode restarted by user" / "Restarted by user", not failures), and
  starts them again in the same order. The same action refuses a second restart of
  one output within 5 s.
- **Observability.** Diagnostics events: `rendition-created`, `rendition-deleted`,
  `rendition-idle-stop`, `rendition-removal-deferred`, `rendition-start-error`,
  `rendition-reconcile-error`
  (repeats throttled to one per 30 s per message) and
  `rendition-dependents-restarted`. `ffmpeg-started`, `ffmpeg-exited` and
  `ffmpeg-restart` carry `role` (`rendition` or `output`) and, for an output that
  reads one, `renditionId`; the once-a-minute `health-snapshot` has `role`,
  `renditionId` and `ready` per output.
- **Recovery after a restart.** The rows live in the database, so a shared encode and
  its Error History survive an app restart for as long as two outputs use its recipe. An
  encode left behind by a crashed app is killed at startup with the other orphaned
  FFmpeg processes.

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
