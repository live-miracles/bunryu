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
| Remote RTMP socket watchdog | Running outputs with a remote RTMP/RTMPS destination | After socket warmup and grace, if the destination socket is missing or remains in a closing state such as `CLOSE-WAIT` | Uses one `ss -H -tanp` snapshot per watchdog interval; a local RTMP/RTMPS destination is ignored because local input/output sockets are ambiguous. A missing socket on an output that has written nothing yet is reported as "No input data" instead (see below) |
| Output memory watchdog | Every running FFmpeg output process, including translation mixers (checked every 5 s; a mixer over its limit is restarted with a `translation-mixer-restart` event, reason `memory limit exceeded`) | After warmup, if process RSS crosses `memory_limit_mb` (or its per-encoding override) | Reads `/proc/<pid>/status`; unconditional — a leaking process can still show advancing `total_size`/healthy sockets, so this doesn't wait on the other two. Once RSS crosses 70% of the limit the output surfaces a yellow "High memory usage" warning in the dashboard, before the watchdog actually restarts it at 100%. The limit is doubled for outputs on a 4K (≥3840px on either dimension) input — the 2x multiplier was checked against measured 4K baselines (RSS: copy with AAC audio 56 MB and 129 MB at start, `vertical_rotate` 472 MB, `720p` 608 MB, `1080p` 940 MB), so the doubled limits sit about 3x above copy and 1.9–2.1x above the encodes |
| Shared encode reconciler | One row per recipe (video encoding + single audio selection) that at least two outputs of a pipeline are configured with | Every second: creates missing rows, removes rows no output uses, starts a shared encode with its first running output, stops it 15 s after the last one | See [Shared encodes](#shared-encodes) below. Start is only requested on the stopped-to-running edge, so it never resets the output's retry back-off; a failing start is retried at most every 30 s |
| Translator audio meter watchdog | Running translation-mixer outputs | After the same startup warmup grace as the output progress watchdog, if the translator audio meter has gone quiet for `translator_meter_stale_ms` (including a translator that never delivered a single sample) | Watches independently of the SRS live-state poll, so a translator that connects but sends a dead/silent track is still caught. Valid translator silence is not treated as a disconnect — FFmpeg continues emitting silent meter samples in that case — so this only fires when the meter itself stops updating. Restarts the mixer so it attaches to the current translator session. |

All output watchdogs above use the same restart path: they write a detailed
`last_error`, kill the stuck FFmpeg process, and let the normal retry loop start a
fresh process while the output's desired state remains `running`. The socket
watchdog is advisory: if `ss` fails or times out, it does not restart anything,
and a socket warning does not prevent the other watchdogs from acting.

**No input data.** FFmpeg opens its destination only after it has read enough of its
input. An output that has written nothing and never connected to its destination
is therefore waiting for its input, not blocked by the destination, and the socket
watchdog says so: "No input data: ffmpeg has written nothing and never connected to
the destination". Before the socket or progress watchdog restarts an output, it reads
that output's stream from SRS (waiting at most 2 s) and adds `input_source`,
`srs_stream` (publisher, readers, bitrate, frames, codecs) and, for a shared output,
`shared_encode` (process state, readiness, uptime, bitrate) to the Error History
record, and an `inputSource` object to the `ffmpeg-restart` diagnostic event. If SRS
does not answer, the line says so and the restart goes ahead. Why:
[the 2026-10-25 shared-encode incident](../4-reference/3-design-decisions.md#an-output-that-never-connected-is-reported-as-waiting-for-input-and-restarts-record-the-input-source).

**Blocked destinations.** Every RTMP/RTMPS output carries `-rw_timeout 10000000`
(10 s) before its destination URL, so FFmpeg ends a connection to a destination that
stopped answering instead of waiting for the progress watchdog: a connect that never
completes ends after 5 s (FFmpeg's own timeout), a destination that never answers
after 10 s, and one that stops reading mid-stream after 30 s for RTMP (three times
the value) or about 10 s for RTMPS. The socket watchdog cannot see these, because
the socket stays ESTABLISHED. The exit shows in the Error History as "Connection
timed out" (or "Error closing file: Input/output error" for RTMPS mid-stream) and
the retry loop takes over. SRT destinations need no such option: libsrt ends a
destination that never answers after about 4 s and one that goes silent mid-stream
after about 6 s (its 5 s peer idle timeout), and the output retries. A receiver that
stays connected but stops reading is not detectable and does not stall the output
(see [the design decision](../4-reference/3-design-decisions.md#srt-destinations-need-no-output-timeout)).
The RTMP measurements and
why 10 s are in
[the design decision](../4-reference/3-design-decisions.md#give-up-on-a-blocked-rtmprtmps-destination-with-an-output--rw_timeout).

**Retries.** An output retries indefinitely. The wait grows with the number of
failed attempts in a row that never stayed up for 60 s: 1, 2, 4, 8, then 16 s. A
run that lasted at least 60 s starts the sequence over, so a drop late in a long
event is retried after about a second. Each wait is shortened by up to a quarter
at random, so outputs that fail together (a platform ingest blip) do not respawn
in lockstep.

Every 30 s a backstop also looks for outputs that should be running on a live
input but have no process, no pending retry and no start in progress, and starts
them (staggered, with an `output-restarted-by-backstop` diagnostics event). An
output has to look that way on two checks in a row, so it does not race the
normal staggered start when an input comes online. Normally nothing matches; it
exists for unexpected errors, such as a start that threw. Such a start leaves
"Start failed: <error>" in the output's Error History (shown in red), and a backstop
start leaves "Watchdog: nothing was starting this output; starting it", each once
until the output spawns again, so a start that keeps failing does not fill the
history. However a start is triggered (API, retry, health poll or backstop), the
spawn itself refuses to run a second FFmpeg for an output that already has one
(`output-start-skipped` event), so overlapping triggers cannot leave an orphaned
process.

**Outputs that never stay up.** If an output is stopped after 5 failed attempts in a
row, none of which stayed up for 60 s, the stop is recorded with the count and the
last failure ("Stopped after 5 failed attempts. Last error: Connection refused"),
the output's card keeps showing that line in red, and its History button stays red,
until the output is started again. A plain stop, or a run that lasted at least 60 s,
leaves no such mark. The stop also writes an `output-stopped-after-failures`
diagnostics event.

Input media validation is separate from the output watchdogs. The health service
stays on the regular 5s poll, but ffprobe backs off once a publisher's probe
succeeds:

| Input check | Scope | Cadence | Notes |
|-------------|-------|---------|-------|
| Media validation | Connected RTMP/SRT inputs without a successful probe yet for this publisher | Immediate probe (staggered across pipelines), then retried every `FFPROBE_FAILED_REFRESH_MS` (30s) while it keeps failing | Stops re-probing once a probe succeeds for the current publisher; a new probe cycle starts on the next publisher change. Every failed probe is written to diagnostics as `media-probe-failed` (reason `timeout`/`exit`/`parse`/`unusable`, elapsed time, exit status, ffprobe stderr tail) and the first failure and the later recovery per publisher are added to the pipeline log (`probe_failed` / `probe_recovered`). Input liveness and output recovery do not wait for a valid ffprobe result — ffprobe fills in media/track details when available. |

**Control-plane errors.** The health poll and the output watchdog
each catch errors from their own tick and run again on the next one. They log the
first failure (and any new error) and a recovery event with the count, not one line
per tick. An error that escapes everything else is logged as
`uncaught-exception` / `unhandled-rejection` and the process keeps running, because
exiting would stop every output. A startup failure is the exception: if the hook or
dashboard port cannot be bound, the app writes `server-start-failed` and exits so
systemd restarts it, instead of running without a dashboard. A diagnostics write
failure (disk full, directory unwritable) drops and counts events instead of
crashing; see
[Configuration](3-configuration.md). On SIGTERM each shutdown step runs on its own,
so one that throws cannot stop the others or the exit. An output whose stored Error
History cannot be read is treated as having none (logged once as `[db] unreadable
output Error History`) instead of failing every output listing; its next error
replaces it.

**Service restarts.** The three systemd units restart a process 2 s after it exits
(`Restart=always`, `RestartSec=2`) and set `StartLimitIntervalSec=0`. Without it,
systemd's default start limit (5 starts in 10 s) marks a unit that keeps failing
right after it starts as failed and stops restarting it until someone runs
`systemctl start`. With it, the unit keeps retrying every 2 s until the cause is
gone. The Docker image's supervisor behaves the same way.

The exception is a failure that needs an operator. If the database was written by a
build with another schema version (`PRAGMA user_version`; see
[Configuration](3-configuration.md#database-schema-version)), `bunryu.service` prints
why and exits with status 78, and `RestartPreventExitStatus=78` leaves it failed
instead of restarting it every 2 s. SRS and the relay `Require` it, so they do not
start either, which keeps the server from accepting publishes it cannot authorize. The
installer catches this before it restarts anything. The Docker supervisor stops the same
way: it logs the error once, starts neither SRS nor the relay, and leaves the container
running but unhealthy until it is stopped; remove `/data/db.sqlite` and start it again.

The same applies to the three config files. At startup, before anything else, the app
reads `bunryu.json`, `srs.conf` and `goryu.json`; one that is missing or is not valid
JSON (`srs.conf` only needs to exist) makes it print which file and exit with status 78,
so it is fixed or restored before the next start. Any other read error (an I/O error, say) is
not treated that way: the process crashes and is restarted after 2 s like any crash.

**FFmpeg build check.** At startup the app runs the configured `ffmpeg` with
`-protocols`, `-encoders` and `-filters`, and `ffprobe -version`, and checks for
everything it uses: RTMP, RTMPS and SRT for both input and output, the `aac` and
`libx264` encoders, and the `amix` and `azmq` filters (translation mixing). The result
goes to the journal and to diagnostics as `ffmpeg-check`, with the version and what is
missing. Unlike a schema mismatch this is not fatal: ingest, the dashboard and every
output that does not need the missing piece keep working. Without the check, a missing
or incomplete build (an OS package replacing the pinned one, or a wrong `ffmpeg_path`)
would show up only as each affected output failing with its own error.

## Host resource alerts

The health poll (every 5 s) watches the host itself, because an overloaded or full host
degrades every pipeline at once and no single output's error explains it. Each alert
has a start and an end threshold that differ, so a reading hovering near the line is
one episode, and each start and end is written three ways: a journal line
(`[host] ...`), a diagnostics event with the numbers, and a row in the **Server events**
table of the dashboard's Server Logs view (the last 200 rows, kept in memory, so the
diagnostics are the record that survives a restart).

| Alert | Starts when | Ends when | Events |
|---|---|---|---|
| CPU | CPU pressure (10 s average) is 50% or more for 30 s | below 30% for 60 s | `host-cpu-high`, `host-cpu-recovered` |
| Memory | available memory under 15% of total | back at 20% | `host-memory-low`, `host-memory-recovered` |
| Disk | free space under 10% of the filesystem | back at 15% | `host-disk-low`, `host-disk-recovered` |

- **CPU pressure** is the share of the last 10 s in which a runnable task waited for a
  CPU (`/proc/pressure/cpu`, "some"). It measures starvation, not busyness: a host that
  runs its encodes at 100% with nothing waiting reads low, which is healthy. The start
  event names the busiest managed processes (SRS, the control plane, the outputs'
  FFmpeg); the end event has the peak and how long it lasted. On a kernel without PSI
  there is no CPU alert.
- **Memory** is `MemAvailable` (free plus reclaimable cache). The start event names the
  five largest processes by RSS.
- **Disk** checks the filesystem holding the database (which also holds the
  diagnostics and HLS previews) and the root filesystem (journald, SRS logs), once
  each when they are the same one. The event carries the path, so it says which filled.

The open alerts are listed in `/api/health` as `hostAlerts`, and the dashboard beeps
once when the memory or disk alert opens (not CPU, whose thresholds are not yet proven
on production, so a beep on a healthy event would get the sound muted). They are
reporting only: nothing is stopped or restarted for them. Why these
thresholds: [Host resource alerts](../4-reference/3-design-decisions.md#host-resource-alerts-cpu-pressure-memory-and-disk).

## Falling behind realtime

An output that processes media slower than realtime falls further behind live every
second: a slow encode or destination, or an input delivering slowly. The output
service measures the output's media clock (`out_time` from FFmpeg's progress) against
wall time over windows of 30 s, and when two windows in a row run below 0.9x the card
shows "Output is running at 0.62x realtime and falling behind live". One good window
clears it. It is a warning only: nothing is restarted, and it is recorded like the
other card warnings (an `ffmpeg-warning-started` / `ffmpeg-warning-ended` pair of
diagnostics events with `kind: falling-behind`, and an Error History record when it
ends). The card shows when the warning began ("since 09:18"). The last finished
window's speed is also in the health data (`speed`) and on the card's badge when it is
below 0.95x or above 1.05x; the first window after a start is not reported, because
FFmpeg reads its probe data faster than realtime and it would read high on every start.

- **Why not FFmpeg's own `speed=` or `fps=`:** both are averages over the whole run,
  so after hours of healthy output a sudden slowdown would barely move them.
- **Why two windows:** one slow window is what a brief input hiccup looks like, and
  the warning would flicker. A gap with no progress at all (more than 10 s) restarts
  the measurement instead, because a stall is the progress watchdog's case.
- **Many outputs at once:** when the input itself delivers slowly, every output of
  that pipeline reads slowly and each shows the warning; for an RTMP input the
  pipeline's `input-low-framerate` alert says which side it is.

## Shared encodes

Outputs on one pipeline that need the same encode share one FFmpeg, a *shared
encode* (see [Outputs](../2-usage/2-outputs.md#shared-encodes)). It is an ordinary
output row, so it is supervised exactly like one: the same retry back-off
(see [Retries](#watchdogs)), output progress, memory and socket
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

## Input frame rate

The health poll watches the video frame counter SRS keeps for an RTMP input. When
the rate over the last 2 minutes is more than 10 % below the frame rate ffprobe
reported for that input (an encoder dropping frames while the bitrate still looks
normal), the pipeline gets an `input-low-framerate` warning alert; more than 10 %
above gives `input-high-framerate` (bursts after a stall, or an encoder sending
more frames than it declares). It is reporting only, like the other alerts: it shows
in the dashboard and as `pipeline-alert-started` / `pipeline-alert-ended`
diagnostics events, and nothing is restarted.

Limits: SRS 6.0 adds frames to the counter in batches of about 5 s and starts
counting roughly 20 s after the publish begins. A window is therefore off by up to
5 s of frames at each end (about ±4 % over 2 minutes), which is why the window is
long and the band is ±10 %; a shorter window or a tighter band would raise false
alarms on a steady encoder. The first alert can come about 2 minutes after the
publish, and a new publisher restarts the measurement. SRT inputs are not checked:
with `srt_to_rtmp off` SRS does not count their frames (`frames` stays 0). An SRT
input through Goryu has loss, drop and retransmission alerts from the relay; one
sent straight to SRS port 10080 has no link-quality alerts today.

## Flapping inputs

When an input disconnects 3 or more times within 5 minutes (a bad uplink, a
crashing encoder), the pipeline gets an `input-flapping` warning alert saying how
many times. It is reporting only, like the other alerts, and it clears once fewer
than 3 disconnects remain inside the window. Each disconnect is still its own line in
the pipeline log; the alert is what makes a pattern visible without reading it.

Input alerts (`input-flapping`, `input-low-framerate`, `input-high-framerate`) belong
to the input itself, so they show on every input, RTMP included: the pipeline's
status icon and the Inputs table's status and Issues column turn to warning, with the
time the alert began. The SRT link-quality alerts (loss, drops, retransmissions,
latency, forwarding) stay with the SRT relay views.

## Encoder restarts do not restart outputs

When an encoder stops and reconnects (for example a manual ffmpeg restart), the
pipeline's input reconnects but its **outputs keep running and are not restarted**,
unless the format changed (see below). If the encoder's timeline restarted (timestamps back near 0), the running outputs
see a discontinuity and may log timestamp warnings until the condition clears (see
[Input timestamp fault detection](#input-timestamp-fault-detection)); restarting the
outputs by hand clears it, at the cost of dropping the destination connections.

**Exception: a changed format.** When the encoder reconnects with a different video
codec, resolution or number of audio tracks, the running outputs cannot carry it (an
output copying the stream cannot change its codec parameters mid-stream), so they are
restarted. This needs no guess about why the encoder reconnected: the ffprobe result of
the new publisher is compared with the last successful one for that pipeline.

- Only outputs that were already running before the new publisher connected are
  restarted, 200 ms apart; one that started afterwards already reads the new stream.
  Readers of a shared encode restart with it.
- A failed probe restarts nothing, and the comparison keeps the last good format. The
  first probe after a server start only records one.
- Frame rate and bitrate changes do not count.
- At most one such restart per pipeline per minute, so an encoder that alternates
  formats cannot start a restart storm; a change inside that window is only reported.
- Each restart is an `input-format-changed` diagnostics event (outputs restarted,
  `suppressed`), a line in the pipeline log, and a "Restarted: input format changed
  from … to …" record in each output's Error History (a deliberate stop, not a crash).

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
