# Design decisions

Why Bunryu is built the way it is, and why some obvious alternatives are not
used. Each entry gives the decision, the reasons, the evidence behind them, and
what would make it worth revisiting. Most of the evidence comes from tests run
in October 2026 against SRS 6.0-r2, MediaMTX v1.21.2 and the pinned FFmpeg 7.1.

## Current architecture in one paragraph

SRS accepts RTMP and plain SRT publishes and authorizes them through its HTTP
hooks. Bonded SRT goes through `goryu`, which merges the legs and
forwards one SRT stream to SRS. Every output is its own FFmpeg process that
pulls its input from SRS over loopback, in the input's own protocol, and pushes
to one destination (outputs that need the same encode pull one shared encode
instead). The diagram is in the
[Introduction](../1-getting-started/1-introduction.md#how-it-works).

## Media server

### Use SRS for ingest, from the official release

**Decision:** SRS handles RTMP ingest, plain SRT ingest, the publish/play hooks,
the stream API and the local fan-out to outputs. The installer pins the official
release binary (currently v6.0-r2) by SHA-256.

**Why:**
- These are SRS's core features: widely deployed, and stable in production here.
- v6.0-r2 bundles libsrt 1.5.6, which fixes CVE-2026-55868/55869.
- A custom build was tried (a 6.0 branch with one patch, built by CI). It was
  dropped once its only patch turned out to be in a feature Bunryu doesn't use
  (`srt_to_rtmp`, below).

**Revisit when:** Bunryu needs an SRS change before upstream releases it, for
example per-client SRT stats (ossrs/srs#4769). The release pipeline for a
patched build still exists (`bunryu/6.0` in `live-miracles/srs`).

### Keep SRS's `srt_to_rtmp` off; FFmpeg converts SRT inputs

**Decision:** SRT inputs stay native MPEG-TS inside SRS. Anything that needs RTMP
from an SRT input gets it from FFmpeg, not from SRS's built-in bridge.

**Why:** the bridge failed in several independent ways (tested on the official
v6.0-r2):
- **Video frames dropped.** A plain H.264 + AAC SRT stream came out at about
  13 fps instead of 25, with regular gaps over 200 ms. The same stream pulled
  over SRT, and the same source published over RTMP, both kept 25 fps.
- **Multiple audio tracks are interleaved** into the single RTMP audio track,
  producing garbage audio. They aren't reduced to one track.
- **Non-AAC audio** (MP2, as many hardware encoders send) gives a silent RTMP
  side, and SRS logs about 8 warnings a second for as long as the input is live.
- **48 kHz AAC got wrong frame timestamps**, which broke the audio. A fix was
  submitted upstream (ossrs/srs#4765, backport #4774) but isn't in a release.

FFmpeg's MPEG-TS demuxer handled all of these cases correctly, including
HEVC and a 33-bit timestamp wrap.

**The bridge looks immature.** These aren't corner cases: a 48 kHz AAC track, a
second audio track or MP2 audio are ordinary encoder output.
- The 48 kHz bug has been present since the SRS 5.0 SRT rewrite.
- Its audio is only audibly broken where players place audio by timestamp (HLS in
  a browser, YouTube ingest). Players such as ffplay and the HTTP-FLV web player
  hide it.

This suggests few people run the bridge in production. FFmpeg's MPEG-TS demuxer,
by contrast, handles damaged broadcast streams every day, in Bunryu's own outputs
too.

**Revisit when:** a release fixes the issues above and passes the same tests:
frame count, two audio tracks, MP2/AC-3, HEVC, timestamp wrap.

### Don't use SRS's built-in forwarding for outputs

**Decision:** outputs are FFmpeg processes, not SRS `forward` destinations.

**Why:**
- SRS 6.0 can't add or remove a forward destination on a live stream without
  kicking the publisher, which cuts every other destination. A runtime API was
  proposed upstream (ossrs/srs#4760) and declined.
- A forward runs inside the SRS process, so a bug there affects every stream.
  An FFmpeg output can only fail on its own.

### Don't use MediaMTX for SRT ingest or SRT→RTMP conversion

**Decision:** MediaMTX isn't in the ingest path.

**Why:**
- **Its SRT stack is gosrt,** which is much less used and maintained than
  Haivision's libsrt (used by SRS, FFmpeg and the relay). On public ingest, SRT's
  loss recovery is the part that matters most.
- **Its SRT→RTMP conversion was tested behind the libsrt relay**, so MediaMTX
  only ever saw a clean loopback connection. Results:
  - **Readers are disconnected under realistic loss.** With 80 ms one-way delay
    and 5–10% loss, MediaMTX closed the RTMP reader within seconds (`too many
    reordered frames`). It rebuilds DTS from the H.264 bitstream for RTMP output,
    and missing frames break that calculation. Every output of the pipeline would
    reconnect at once. The FFmpeg path stayed connected through 10% loss.
  - **HEVC video is dropped** for RTMP readers that don't announce enhanced-RTMP
    codecs. FFmpeg 7.1 can't announce them when reading.
  - **An MP2 audio track makes the whole RTMP read fail**, video included.
  - It cleanly kept the first of two audio tracks and handled a timestamp wrap.
- **Less mature than FFmpeg on damaged input.** With realistic packet loss, holes
  remain in the MPEG-TS stream after SRT's retransmissions; this is common for
  SRT over real networks. MediaMTX's conversion did worse than FFmpeg's in every
  loss test:
  - it disconnected readers under random loss, where FFmpeg kept going;
  - after long outages it passed on more out-of-order timestamps (9 against 1);
  - it logged nothing about the holes.

### Don't build on datarhei Restreamer

**Decision:** Restreamer was tried first and was not adopted as the base.

**Why:**
- **Its SRT server is gosrt, not libsrt.** Restreamer's Core uses datarhei's own Go
  implementation ([gosrt](https://github.com/datarhei/gosrt), v0.6.0 in its `go.mod`).
  On a flaky network we saw heavy pixelation in streams passing through it that did not
  appear through libsrt under the same conditions. This was an observation in a trial;
  it was not measured and no recording was kept. The MediaMTX entry above is the
  measured counterpart.
- **The interface did not suit many outputs.** Adding an output took many clicks, the
  output list grew long, and each output's bitrate and health were not shown beside it,
  so an output with a problem or one that had restarted was hard to find. A judgement
  from a trial, not a benchmark.
- **Upkeep (checked October 2026):** the UI repository (`restreamer-ui`) has had one
  commit since January 2025 and its last release is v1.13.0 (June 2024). Core is more
  active, with 19 commits in the same period.

**Revisit when:** its SRT server moves to libsrt, or a controlled test (packet loss and
delay on the same stream through both) shows gosrt matching libsrt, and its overview
shows each output's bitrate, health and restarts at 50 inputs and 500 outputs.

### Don't build our own media server

**Decision:** no in-house RTMP/SRT server, and no adoption of new projects as the
core server until they have production history.

**Why:** a small server is feasible in line count, but the cost is in encoder
compatibility (RTMP handshake and command variants, chunking, extended
timestamps, enhanced RTMP) and behavior on bad networks, which only show up in
real use. A new server carries every input at once, so its bugs reach every
stream.

**Growing `goryu` into that server was considered (October 2026)** to drop SRS,
have one fewer process and remove the loopback SRT hop on bonded inputs. It was
rejected:
- **It moves code in-house rather than removing it.** Goryu would grow from about
  2,000 to an estimated 9,000 to 12,000 lines of C: SRT fan-out, an RTMP server,
  publish authorization, kick and stream stats. The control plane would barely
  shrink, because it still needs the same stream registry, stats, hooks and kick
  from goryu instead of SRS.
- **SRS's code can't be lifted into goryu.** The RTMP stack, AMF0, handshake,
  FLV and SRT connection code in SRS 8.0 is about 13,000 lines of C++ built on
  SRS's own classes and its state-threads coroutines. Goryu is C with a thread per
  session, so reusing it means a rewrite or a fork of SRS.
- **The hop it removes isn't where bonded inputs fail.** goryu to SRS is loopback;
  bonded inputs fail on the public legs. The hop costs about 200 ms (see
  [Outputs pull from SRS, not from the relay](#outputs-pull-from-srs-not-from-the-relay)),
  which doesn't matter for the platform outputs Bunryu serves.

**Tradeoffs:** every output is an FFmpeg process, so a copy output costs about 65 to
90 MB of RAM, where a MediaMTX forwarding hub used about 10x less (and about 1.5x more
CPU; see [One FFmpeg process per output](#one-ffmpeg-process-per-output)). That is
acceptable at the tested 500 outputs. In return the control plane stays small
(about 11,000 lines of TypeScript) and FFmpeg and libsrt handle the damaged-input
cases.

## SRT ingest

### A separate relay accepts bonded SRT, because neither FFmpeg nor SRS can

**Decision:** bonded SRT (several network links carrying one stream, as cellular
bonding units and AJA Bridge Live send it) goes to `goryu`, its own service on
`10081`. It listens with `SRTO_GROUPCONNECT=1`, accepts each bonded session, reads
its `streamid` and publishes a normal SRT stream to SRS with the same `streamid`.
It connects to SRS only after an encoder has connected, so SRS's idle-publisher
timeout is not triggered by an empty publisher at boot.

**Why a relay at all:**
- FFmpeg's SRT handler does not set `SRTO_GROUPCONNECT=1` on its listener socket,
  so bonded connection attempts are rejected at the handshake.
- SRS accepts normal SRT publishers but not bonded groups.

**Revisit when:** SRS accepts SRT groups natively (filed upstream as ossrs/srs#4771),
which would make the relay unnecessary.

### Plain SRT goes directly to SRS by default; the relay also accepts it

**Decision:** encoders publish plain SRT to SRS's SRT port by default. The
relay's listener accepts a plain single-link SRT caller as well as a bonded
group, so an operator can choose to send plain SRT through the relay. The
dashboard shows such an input as a single link with the encoder's address
(`input.peer` in the relay's `/status`), without the bonded-leg redundancy
warnings.

**Why direct stays the default, and what choosing the relay costs:**
- SRS's SRT is also libsrt, so a bad network is handled by the same retransmission
  code either way.
- Through the relay, SRS would only see `127.0.0.1`. That hides the encoder's IP
  from the publish hook, the dashboard and rejected-publish tracking, and turns
  SRS's per-client SRT stats into stats of the loopback hop.
- It would add ~200 ms of latency and a second process every SRT input depends on;
  a relay restart would drop all SRT inputs instead of only the bonded ones.

### Link stats for a direct SRT input are not read from SRS's log

**Decision:** not implemented. A direct SRT input (port 10080) has no loss, retransmit
or drop stats or alerts, and its card says to use the SRT relay port for them. The
only source in SRS 6.0 is its log, which would need `srs_log_level trace`, and that
is too risky for the journal.

**What was tried:** SRS logs `<- SRT_CPB Transport Stats # pktRecv, pktRcvLoss,
pktRcvRetrans, pktRcvDrop` for each SRT publisher. A prototype followed
`journalctl -u srs.service -f -g ...`, matched the line's `[cid]` to `publish.cid`
(also the hook's `client_id`; verified on SRS 6.0-r2) and fed the input card and the
relay's `srt-packet-loss`, `srt-retransmissions` and `srt-packets-dropped` alerts. It
worked end to end, including a reader that could not affect a stream (bounded buffers,
a malformed line only counted, a dead `journalctl` restarted with backoff).

**Why it was dropped:**
- **Needs `trace`.** At `srs_log_level warn`, the setting since 2026-06-14, there are
  no such lines (0 in 60 s with an SRT input connected). The setting came with the log
  rotation commit and records no reason; log volume is the likely one.
- **Steady state is acceptable** (measured on the test stack with one input and four
  outputs, the rest from SRS's source). About 4 lines/s (~40-60 MB/day) at idle, mostly
  SRS logging each of the app's own API polls (about 5 lines per request). SRS's
  periodic lines are limited to about one per stage per 10 s however many clients
  share the stage, so 50 inputs and 500 outputs should not change it. That was not
  run at that scale.
- **Failure storms are the problem.** Measured per rejected publish on the test
  stack (10 attempts each): `warn` already logs 9 lines (1.4 KB) for RTMP and 5.7
  (1.2 KB) for SRT; `trace` logs 30 (4.3 KB) and 19 (2.8 KB), about 3 times as much.
  The app already throttles rejected publishers that retry every 10-40 ms (seen in
  production; that rate is from a code comment, not measured here), i.e. 25-100
  attempts/s. Either mode can then reach journald's default rate limit (about 333
  lines/s per service, which the installer does not change), after which it drops
  lines, warnings and errors included, and can fill the 1 GB journal in about 6 hours
  and push out the history of an earlier incident. `warn` reaches that limit at about
  37 attempts/s, `trace` at about 11, and below it `trace` fills the journal about 3
  times faster.
- **No safe mitigation verified.** A journald `LogFilterPatterns` rule could drop
  the `INFO` lines and keep warnings, errors and the stats lines, but it needs
  systemd 253 or newer (Debian 12 has 252), and a test with a user unit did not filter
  anything; a system unit could not be tested without root. Docker would also need
  `warn` pinned: it has no journal and `docker logs` is not rotated by default.
- **Little gained.** Counters only (no RTT, bandwidth or latency), one sample per input
  about every 10 s times the number of SRT inputs (50 inputs: ~8 min), and a stalled
  connection logs nothing.

**Revisit when:** SRS 8 with per-client SRT stats in its API (ossrs/srs#4769, PR #4770)
is deployed: read the API, which needs no log level. Or when a journald filter is
verified on the production OS, if a stats line is wanted sooner. Meanwhile an operator
who needs link stats for an input sends it through the relay port.

### A lost bonded leg is found by counting legs, because the relay drops it instead of reporting `broken`

**Decision:** the health poll remembers the most legs a bonded input has had since it
connected (`expectedLegs`). Fewer legs than that is a down leg: a `bonded-leg-down`
alert, a warning on the input, and "N of M bonded legs down" in the dashboard. The
count resets when the input goes away.

**Why:** the relay's `/status` documented a `broken` leg state but never sent it. It
skips broken group members, and with that filter removed a pulled LAN cable still
never showed `broken`: libsrt dropped the leg from the group within the relay's
one-second sample (2026-10-21, bonded stream over two legs, polled every 0.25 s). The
dashboard's broken-leg checks therefore never fired, and only a group down to one leg
raised a warning, so a three-leg group that lost one showed nothing.

**Why a count and not the leg's address:** cellular legs change IP often, so a leg that
comes back on a new address would stay "lost" if tracked by address.

**The history does name addresses.** The alert counts legs, but the pipeline log and
the diagnostics record which link changed, because "which one" is what an operator
needs after the fact: `Bonded legs went from 2 to 1: lost 198.51.100.7:49152 (now: ...)`
in the pipeline log, and a `bonded-legs-changed` diagnostics event with the legs
before and after. A leg that returns from a new port is logged as one lost and one
joined; that is accurate, and it does not touch the alert. The pipeline log keeps only
100 entries, so a link that flaps would push the online/offline history out of it: it
gets 4 lines a minute and one "N more changes not shown" line afterwards, while every
change still goes to the diagnostics (one per 5 s poll at most). A bonded input that
disconnects resets the remembered legs, so reconnecting is "connected with N legs", not
a run of lost legs. The relay logs the same changes itself with one-second timing
(`Bonded leg joined|left` in its journal); this view is the 5 s sample of it.

**Plain inputs log their address too.** Each new publisher writes one pipeline-log line
(`Publisher: rtmp from 198.51.100.4`) and a `publisher-source` diagnostics event, so the
history says who connected, not only that someone did. SRS reports the address for RTMP
and for SRT sent to port 10080, but an SRT input through Goryu reaches SRS over loopback
(SRS sees 127.0.0.1), so its address is taken from the relay's `peer`
(`srt via relay from 203.0.113.9:40123`). The relay status can lag SRS by a poll or two,
so the line waits up to 15 s for the peer and then logs the loopback address (an encoder
on the same host). It is one line per publisher, the same rate as the online/offline
lines, so it needs no throttle of its own.

**An idle leg is not a fault while another leg runs.** In a main/backup group the relay
reports the standby leg as `idle` (carrying nothing) and the main leg as `running`; when
the main leg fails the standby becomes `running` (checked 2026-10-22 against the relay with
a 4 Mbps stream: main 4.4 Mbps, standby 0.000 Mbps, and no gap when the main leg was
closed). The leg health used to mark every idle leg as a warning, which turned a healthy
backup group's pipeline status to warn permanently. An idle leg is now a warning only when
no other leg is running, and `pending` still is one.

**Cost, and when to revisit:** an encoder deliberately run with fewer legs keeps the
warning until the input reconnects. Revisit if the relay starts reporting lost legs
itself.

### SRT loss, retransmit and drop figures cover the last 10 minutes, not the session

**Decision:** the SRT Relay card and the Overview table show loss / retransmit / drop
as growth over the last 10 minutes (`recent` in `/api/health`, computed from the 5 s
poll's cumulative counters). The totals since connect stay in the
details dialog. A bonded group shows only its Drop, marked when above zero; per-leg
drops are not marked.

**Why:** the relay's counters only grow, so on a long event they say nothing about the
link now. The bonded stream on the production VM (2026-10-25, two legs, about 9 Mbit/s,
10.4 h of per-minute snapshots) showed 10.1 k lost and 3 k dropped packets on one leg,
which reads as a bad link, while most minutes had no loss at all and the rest came in
bursts.

**Why 10 minutes and not 1:** over those 623 minutes, 39 % had loss on a leg and 8 %
had a leg drop, in bursts. A 1-minute figure is zero most of the time and a burst is
gone from it a minute later, so an operator glancing at the card misses it; 10 minutes
keeps a burst on screen long enough to see, and matches the dialog's 10-minute history
step. The alerts keep their own 1-minute window, which is for
reacting, not for looking back.

**Why the group's Drop is the one marked:** a leg's drop is a packet that leg did not
deliver in time, and the other leg usually did. Leg drops happened in 52 of the 623
minutes but the group's only in 2 (286 packets in total), and only those reached the
stream.

**Revisit when:** operators ask for another window (the window is `SRT_RECENT_WINDOW_MS`
in `src/utils/srtRecent.ts`), or the dialog's cumulative graphs are changed to rates.

### Outputs pull from SRS, not from the relay

**Decision:** the relay stays a byte-level pipe (one input, one downstream SRT
connection) and doesn't serve readers.

**Why:**
- Serving pulls would make the relay a media server. It would need fan-out with
  isolation for slow readers, play authorization, a stream registry for health
  checks, and the ability to kick publishers.
- RTMP inputs would still be on SRS, so the control plane would track streams in
  two places.

**Cost of the SRS hop:** about 200 ms per SRT hop, and CPU in SRS. One 3 Mbps
stream with 50 copy readers measured 17% CPU and 68 MB for SRT readers, against
5% and 30 MB for RTMP readers.

**Revisit when:** SRT fan-out in SRS becomes a measured bottleneck. The cheaper
fix is then one FFmpeg remux per SRT input published back into SRS as RTMP, not a
relay fan-out.

### Keep `goryu` in its own repository

**Decision:** the relay stays a separate repository with its own releases, and
Bunryu pins a release binary like it pins SRS and FFmpeg.

**Why:**
- It's a different toolchain (C, libsrt, a Docker build) from Bunryu's Node.js
  and TypeScript.
- It's useful on its own as a standalone SRT relay.
- It changes much less often than Bunryu.
- Each release bundles its own libsrt (v3.0.6 and later have 1.5.6, which fixes
  CVE-2026-55868/55869), so a libsrt security fix needs a relay release and a
  pin bump here.

The coupling is the relay's config file and its `/status` JSON. Treat `/status`
as a contract: add fields, and bump the relay's major version for anything
else.

### Raise the kernel UDP buffer ceiling, but don't alert on it

**Decision:** the installer sets `net.core.rmem_max` and `wmem_max` to 16 MB. There is
no health alert or startup check for the value.

**Why:**
- libsrt requests a 12 MB UDP buffer per socket. Prod had the Linux default
  ceiling of 212992, so SRS (10080) and goryu (10081) ingest sockets ran with
  `rb425984` (the kernel doubles the capped value), about 70 ms of a 50 Mbps feed.
  A stall longer than that, such as an encode starving the ingest thread, drops
  packets and costs SRT retransmits.
- Raising a ceiling is cheap. It changes nothing for sockets that don't ask for
  more, and memory is only used while a queue is full (bounded by `udp_mem`).

**Evidence:** no drops were observed, so this is headroom, not an incident fix.
A 2 vCPU / 2 GB prod VM (outputs stopped, host about 85% idle) receiving a
bonded SRT feed at 6.6k then 11k packets/s over 33 minutes showed
`UdpRcvbufErrors` 0 and every ingest socket's `d` 0. The default ceiling was
enough at that load, but nothing ran under CPU contention. With the 16 MB ceiling
the same sockets got `rb24576000` (12 MB doubled) after a restart and again
after a reboot, so the sysctl file is applied at boot.

**Why no alert:** an alert needs a recorded incident to justify it. Without drops
there is nothing to calibrate it against.

**Revisit when:** `UdpRcvbufErrors` rises or an ingest socket shows `d` above 0
(the per-minute `health-snapshot` records both as `host.udp`, with `host.cpuPressure`
to tell whether the host was starved at the time; then add a health check for the
ceiling and the counter), or inputs carry
4K SRT at 50 Mbps or more with encodes running on the same host.

## Outputs and preview

### One FFmpeg process per output

**Decision:** each output runs in its own FFmpeg process with its own watchdogs.

**Why:**
- A stalled destination, a corrupt input frame or a memory blow-up affects only
  that output, and it can be restarted on its own (see
  [Reliability](../3-operations/4-reliability.md)).
- FFmpeg also does every transcode, audio-track selection and translation mix.

**Cost:** about 35 MB of RAM and, on production, about 4% of a vCPU per 8 Mbps
copy-mode output (0.4% per Mbps sent), and about 1.2–2 vCPUs per custom video encoding of a
1080p50 input, far more for 4K (once per
distinct encode on a pipeline, since outputs with the same encode share one: see
[Outputs with the same encode share one FFmpeg](#outputs-with-the-same-encode-share-one-ffmpeg-shared-encodes)).
That's acceptable within the supported envelope
([Introduction](../1-getting-started/1-introduction.md#capacity-and-limits)).

**Not planned: a MediaMTX forwarding hub for copy outputs.** It used about 10x
less RAM but about 1.5x more CPU than FFmpeg for RTMP→RTMP copy outputs. It
would mean a second media server in the output path, while FFmpeg would still be
needed for every transcode, SRT destination and translation mix. Outputs stay on
FFmpeg.

### Outputs with the same encode share one FFmpeg (shared encodes)

**Decision:** outputs on the same pipeline that need the same encode, meaning the
same video preset and the same single audio track, share one upstream FFmpeg, the
*rendition* (the dashboard calls it a "shared encode"). It encodes once and
publishes into SRS as an internal RTMP stream on loopback
(`rtmp://127.0.0.1:<port>/internal/r<pipelineId>_<video>_a<audio>`); the sharing
outputs pull that stream in copy mode.

**Why:**
- Before, every output with a track selection or a video preset ran its own
  encode: ten RTMP outputs on track 1 of an SRT input meant ten SRT pulls and ten
  identical AAC encodes, and ten 720p outputs meant ten x264 encodes (about a
  core each). Operators worked around it by looping the SRT pipeline into a second
  pipeline.
- RTMP readers are cheap for SRS: 50 RTMP readers measured 5% CPU against 17% for
  50 SRT readers (SRS 6.0-r2).

**How it's built:**
- **A rendition is an output row** of the same pipeline, recognised by its URL
  (`rtmp://127.0.0.1:<port>/internal/r<id>_<video>_a<audio>`). It reuses the output
  service's supervision, watchdogs, retry back-off, History, stats and
  health unchanged. A reconciler (one tick per second) creates, removes, starts and
  idle-stops the rows.
- **No schema change and no config option,** so the production database is not
  wiped. A hidden pipeline or a new table would have needed new supervision,
  health and history paths for the same behaviour.
- **Which outputs share:** not plain copy, not multi-track (`0,1`, since RTMP/FLV
  carries one audio track) and not translation (owned by the mixer). And only when
  at least two outputs of the pipeline are configured with the same recipe (desired
  state does not matter, so the rule is a pure function of the saved configuration).
  A first version shared even a lone output, for one code path; a lone output then
  paid an extra process (about 28 MB, 0.4% CPU), about 5 s of extra start-up (0.02 s
  direct, measured), an extra SRS hop, and the input-outage restart cycle (see
  Known issues) for nothing. The rule is evaluated when an output starts and by the
  reconciler; a running output never switches mid-run, so a changed configuration
  settles the next time an output starts. Two consequences are accepted because
  outputs are normally all configured before an event: adding a second output while
  the first runs direct starts the shared encode at once (two encodes, and an idle
  one if the second is never started); and removing the second leaves the encode in
  place while any output still reads it, so a live output is never interrupted by an
  edit to another.
- **The internal app is reserved:** users cannot create, edit, start, stop or
  delete renditions or point an output at the app; SRS's publish hook accepts it
  only over RTMP from loopback for a running rendition row.
- **Readiness is local** (process running and data written), not the 5 s health
  poll. When a rendition exits on its own its readers are restarted and wait for it;
  each gets a History record naming the cause. After 15 s with no running
  reader it stops, so a quick stop/start does not restart the shared encode.

**Evidence** (local isolated stack, 2026-10-17, SRS 6.0-r2, FFmpeg 7.1.4, one
1280×720 SRT input with two audio tracks, two outputs on track 1, CPU summed over 60 s):

| | Processes | CPU | RSS |
|---|---|---|---|
| Before: each output pulls SRT and encodes AAC | 2 | 29.5% of a core (14.6% + 14.8%) | 74 MB |
| Shared: one encode (12.3%) and two copy readers (0.4% each) | 3 | 13.1% of a core | 93 MB |

CPU more than halves with two outputs and the saving grows with each further
output (a reader costs 0.4%); memory is slightly higher for few outputs, from the
extra process. In the same stack the end-to-end behaviour matched the design:
killing an encode restarted its readers after one back-off step with one record
each (about 6 s outage); a restart from the dashboard did not count a failure; the
encode idle-stopped at 15.0 s; a crashed app's orphaned encodes were swept at
startup and everything was running 7 s later; and stop-all then start-all
restarted each encode exactly once. An input outage over 5 s costs one failure
cycle (SRS drops the idle internal publish; see
[Known issues](../3-operations/5-known-issues.md)).

**Tradeoffs:**
- A failed rendition affects every output that shares it. The blast radius is one
  recipe on one pipeline.
- Starting a shared output takes a few seconds longer (the encode must be writing
  first).
- Output ids have gaps, since a rendition takes a number in the pipeline's sequence.

**Not done:** sharing across pipelines; shared multi-track encodes (they would need
an SRT/MPEG-TS internal stream); GOP or bitrate tuning (a rendition uses the same
encoder settings as before and joiners start at SRS's cached GOP).

**Revisit when:** a shared encode's blast radius becomes a problem in practice
(then split by destination group), or multi-track outputs need sharing.

### Preview copies the video; only audio is encoded

**Decision:** the dashboard preview is an HLS stream made by FFmpeg that copies
the input's video unchanged and re-encodes only the audio to AAC (one rendition
per audio track). Only Chrome is supported. Previews are stopped automatically
when no viewer remains.

**Why:**
- **CPU:** the previous 480p video transcode took about 80% of a core per open
  preview for a 1080p input, which made previews unusable on a 2 vCPU server.
  With video copy the same preview takes about 9% (3% for a single-track input).
- **Audio is still encoded** because it's cheap and keeps the timestamp
  smoothing for SRT inputs, MP2/AC-3 inputs playable in the browser, and audio
  track switching.
- **Same pipeline for RTMP and SRT inputs,** played by the existing hls.js player.
- **No SRS feature needed:** SRS's native HLS was used briefly but depended on
  `srt_to_rtmp` for SRT inputs.

**Costs:**
- **Bandwidth:** each viewer receives the source bitrate (e.g. 6 Mbps for a
  1080p input instead of ~1 Mbps).
- **Keyframe interval:** HLS segments can only start on a keyframe, so an input
  with a long keyframe interval starts slower and runs further behind live.
- **HEVC** inputs preview only where Chrome can decode HEVC; there is no
  transcode fallback.

### Give up on a blocked RTMP/RTMPS destination with an output `-rw_timeout`

**Decision (October 2026):** every RTMP and RTMPS destination gets `-rw_timeout
10000000` (10 s) as an output option, placed directly before the destination URL
(`buildFfmpegArgs` and the translation mixer). SRT destinations do not.

**Why:** a destination that accepts the TCP connection and then goes quiet leaves the
socket ESTABLISHED. The socket watchdog treats that as healthy, and FFmpeg waits
forever, so only the progress watchdog (45 s without progress, after a 90 s warmup)
ends it. Measured with the pinned FFmpeg n7.1.4 on loopback, 100-110 s cap per run:

| Case | Without | With 10 s |
|------|---------|-----------|
| Connect never completes (accept queue full) | 5.2 s | 5.2 s |
| Accepts, never answers (RTMP and RTMPS, also a completed TLS handshake) | never | 10.2-10.3 s |
| Frozen mid-stream, RTMP (SRS `SIGSTOP`; `ss` showed ESTAB with 2.7 MB queued) | never | 30.8 s |
| Frozen mid-stream, RTMPS (TLS proxy in front of the frozen SRS) | never | 10.6 s |
| Healthy destination, 70 s at real pace, RTMP and RTMPS | publishing | publishing (also at 3 s) |

- **How each case was produced** (all on loopback, FFmpeg copying a local file with
  Bunryu's real arguments, runs in parallel):
  - *connect never completes:* a listener with a full accept queue, so the kernel
    drops further SYNs;
  - *accepts, never answers:* a listener that accepts and sends nothing; for RTMPS
    also a TLS server (self-signed certificate) that completes the handshake and then
    says nothing;
  - *frozen mid-stream:* SRS as the destination, stopped with `SIGSTOP`, so the
    kernel keeps accepting until the socket buffers are full and then advertises a
    zero window. For RTMPS a TLS proxy sat in front of the frozen SRS. FFmpeg ran
    unthrottled so the buffers fill at once and the block starts right away;
  - *healthy:* SRS behind the same proxy, FFmpeg paced at real time (`-re`).
- **Scaling:** for RTMP mid-stream the give-up time is three times the value (5 s gave
  15.6 s, 10 s gave 30.9 s twice, 20 s gave 60.9 s).
- **10 s is a compromise:** 30 s of fully blocked writes is under the progress
  watchdog's 45 s, so it adds no new kind of restart, only an earlier one. A smaller
  value would restart outputs sooner on a platform that merely pauses reading.
- **The connect case needs nothing:** FFmpeg's own connect timeout already ends it
  after 5 s, long before the 45 s socket watchdog.
- **Regression test:** `test/outputTimeout.test.js` runs real FFmpeg on the arguments
  Bunryu builds against a destination that never answers (RTMP and RTMPS, no
  certificate needed), plus a control without the option; it passed on FFmpeg 7.1.4
  and the development machine's 8.0.1.

**Not adopted:**
- **`-timeout`.** It is not a TCP timeout for RTMP: it implies listen mode and
  FFmpeg tries to bind the destination port ("Address already in use").
- **SRT destinations.** The option is a different setting for `srt://`; they need no
  timeout, see [below](#srt-destinations-need-no-output-timeout).
- **A shorter progress-watchdog stall.** It would also restart outputs fed by an
  idle input, which the watchdog deliberately ignores.

**Not tested:** a real platform ingest, and RTMPS certificate verification (FFmpeg's
default does not verify).

**Revisit when:** outputs restart with "Connection timed out" against a healthy
platform (raise the value), or FFmpeg is upgraded (the regression test checks the
mechanism).

### An output that never connected is reported as waiting for input, and restarts record the input source

**Decision (October 2026):** when the socket watchdog finds no destination socket on
an output that has written nothing, it reports "No input data" instead of "Destination
socket unhealthy". Before the socket or progress watchdog restarts an output, it reads
the output's stream from SRS (at most 2 s, `/api/v1/streams`) and, for a shared
output, the shared encode's state, and puts both in the History record and the
`ffmpeg-restart` diagnostic event. The input's `-rw_timeout` stays at 10 minutes.

**Incident (2026-10-25, pipeline 12):** a shared encode ran and wrote at 2.4-2.5 Mbps
for 25 minutes (its health snapshots) while the YouTube output reading it from SRS
failed 19 times in a row; a second key on the same pipeline failed the same way. Every
attempt ended with an empty stderr but `Error opening input file
rtmp://127.0.0.1:21935/internal/r12_copy_a0`, and its only socket was the one to SRS:
it never connected to YouTube. The watchdog blamed the destination ("RTMP socket
missing") because that is the only thing it checked. Three other pipelines started in
the same 15 s with the same settings worked. Once the outputs were stopped and the
shared encode idle-stopped, the next start worked. SRS ran at log level `warn` and
logged nothing about the stream, so the state inside SRS was not recorded.

**Why these changes:** the misleading wording sent the investigation to YouTube; and
the one fact that would have told an input fault from a destination fault (what SRS
held for the stream at that moment) was not captured.

**Where the evidence is recorded:** in each output's own History and in the
diagnostics, per output. Recording it once per source stream (in the pipeline History,
with the other outputs pointing at it) would stop the repeats and the SRS calls, and
is the same fault for outputs that read the input directly; it was left out for now
because the 3 s shared request already bounds the load and per-output records are
enough while this has been seen once. It would relax the convention that outputs do
not write to the pipeline History. Revisit if many outputs failing together make the
repeats a problem.

**Why not a shorter input `-rw_timeout`:** it also bounds every read while running, so
a brief gap in the input would restart outputs and eat their 5-attempt budget. The
10 minutes exist for publisher-less pulls (see the entry on blocked destinations
above); the watchdogs end a stuck open after about 45-50 s anyway.

**Not done (a possible feature):** restarting the shared encode automatically after
repeated failed reads, which is what fixed this by hand and would have cut 25 minutes
to about 2. It is held back because the cause is unknown and the fix has been seen
to work once. If it is built, the design to start from:

- **Act only when all of these hold:** the reader wrote nothing and failed twice in
  a row; its shared encode is running and has written data; no other reader of that
  encode is producing data (restarting would cut a healthy output); SRS lists the
  stream as publishing and has sent nothing to that reader (this separates a broken
  path from a destination problem such as a DNS hang, which looks the same from
  outside).
- **Bound it:** at most one automatic restart per shared encode per 10 minutes, with
  a diagnostics event and a History record on every affected output.
- **Copy the manual recovery, not a quick restart:** stop the failing readers and the
  shared encode, wait about 20 s, start the encode and let the readers follow. The
  manual fix included a gap with no readers; if SRS keeps its stream object alive
  while a reader keeps reconnecting, a plain restart of the encode could leave the
  fault in place.
- **Test the mechanics only:** the fault cannot be reproduced on the test stack, so
  fault tests can cover the conditions, the bound, the sequence and that a healthy
  sibling blocks it, not whether it cures the fault.

**Revisit when:** the fault happens again and the new History records (SRS stream
state, shared encode state) show where the bad state is. Build the restart then if it
is in SRS or the encode, and fix it at the source if it is something else.

### A repeated crash is one History record, and recovery is a field on it

**Decision (October 2026):** an output's History keeps at most 10 records. A crash
with the same signature as the previous crash record (first and last line, numbers and
addresses blanked, nothing but warnings in between) increments `count` and `lastTs`
on that record instead of adding one. When an output with a current crash has run for
60 s and is writing data, the crash gets `recoveredTs`, which ends its time as the
current error. No separate "recovered" record is written.

**Why:** a failure that repeats gets one slot instead of up to ten: on 2026-10-25
the first output failed 19 times in a row the same way, which with one record per
attempt leaves only the last ten copies and none of the records before them. And an
output that restarted by itself stayed red until someone stopped and started it,
because nothing but a stop or a start supersedes a crash. A separate recovery record
would have taken a slot per episode for no information the crash does not carry.

**Choices:** the first crash keeps its message (nearest the onset, the most useful),
and later ones are in the diagnostics events; `lastTs` is what the card shows as the
time of the error. 60 s is the limit that already ends a failed-attempt streak, so an
output that crashes again seconds after restarting does not flash normal in between.
The retry count starts over at recovery. A crash after a recovery is a new record even
with the same text, so a flapping output is still visible as separate episodes.

**Translation outputs** run in the translation mixer's own process and only report
their status and progress to the output service, so the watchdog tick visits them
separately (by what they reported) and applies the same recovery rule.

**Revisit when:** distinct failures are being merged (widen the signature) or a
flapping output fills the History with episodes.

### Don't add an `ss -ti` ack-progress check; `-rw_timeout` is the knob

**Decision (October 2026):** the socket watchdog keeps reading only the socket state
from `ss -tanp`. It does not read `ss -ti` to notice a connection that stays
ESTABLISHED but stops being acknowledged. How fast a blocked RTMP destination is
given up on is set by `-rw_timeout` (see the entry above).

**Measured** on the production VM (Ubuntu 22.04, FFmpeg n7.1.4) with a 4.2 Mbps copy
push of a looped clip to a destination SRS on a private loopback port, with the
output's `-rw_timeout 10000000`. The fault started at t=20 s; "ack stall" is the time
`bytes_acked` has not advanced while data is queued. The silent drop was one
`iptables` DROP rule on the destination port.

| Fault | First ack stall of 3 s | 10 s | Exit by FFmpeg |
|-------|------------------------|------|----------------|
| Silent drop (nothing delivered) | +3.2 s | n/a | +34.6 s |
| Frozen receiver (SRS `SIGSTOP`, zero window) | +9.8 s | +16.9 s | +40.1 s |
| 8% of packets dropped, still working | never | never | never |
| 30% of packets dropped, still working | +22.0 s | never (max 6.1 s) | never |

**Why not:**
- **The gain is about 25 s on a rare failure.** A rule of "10 s without ack progress"
  would end a dead connection at about +10 s instead of +35 s. That is more aggressive
  than the 30 s of blocked writes the `-rw_timeout` decision accepts, so it would
  restart sooner on a platform that merely pauses reading. A threshold that respects
  that decision (about 25 s) gains 10-15 s.
- **The same trade-off is already one constant.** `-rw_timeout 5000000` gives up
  after about 15.6 s on mid-stream RTMP (measured above), with no new code.
- **It cannot see the other cases.** A destination that never answers has an empty
  send queue, and SRT destinations are UDP.
- **The signals overlap.** The 30% loss run stalled acks for 6.1 s while the stream
  kept flowing, and the frozen receiver and a lossy path are not cleanly separable
  from the ack counters alone.
- **Cost:** multi-line `ss -ti` parsing across up to 500 sockets and per-socket ack
  state in the highest-risk loop.

**Seen in the same runs:** after about 4.6 s the destination SRS closed its side
(probably its idle-publisher timeout; not checked), leaving the output's socket in `CLOSE-WAIT` with
1.78 MB queued, which the existing socket watchdog already acts on.

**Not tested:** a real platform ingest. Everything above ran on loopback, so how
long YouTube or Facebook pause reading before they resume is unknown.

**Revisit when:** a silently dead connection costs more than the current give-up
time in a real incident, or outputs need to give up in under 15 s without the
false restarts that a shorter `-rw_timeout` risks.

### SRT destinations need no output timeout

**Decision (October 2026):** SRT destinations get no equivalent of the RTMP
`-rw_timeout`. FFmpeg's libsrt already ends a dead one within seconds.

**Measured** on the production VM (Ubuntu 22.04, FFmpeg n7.1.4) with a 4.2 Mbps copy
push of a looped clip, `-c copy -f mpegts srt://127.0.0.1:<port>?streamid=…`, no extra
options, to a private loopback port:

| Destination | What ffmpeg did |
|-------------|-----------------|
| Never answers (a bound UDP socket that replies to nothing) | exit after 4 s with "Connection … failed: Input/output error" |
| SRS as the SRT listener, `SIGSTOP`'d mid-stream | exit 6 s later (`Error writing trailer: Input/output error`) |
| SRS as the listener, every packet of the port dropped in both directions mid-stream | exit 6 s later, the same error |
| A libsrt receiver (FFmpeg) whose output pipe nobody drains, so it stops consuming the stream mid-stream | kept sending for 150 s: progress advanced, no stall, RSS flat at 35 MB, no exit |

- **Why 6 s:** libsrt's peer idle timeout (5 s by default) closes a connection that
  hears nothing from its peer, and a send on it fails. That is far tighter than the
  30 s that RTMP needed `-rw_timeout` for, so the retry loop takes over on its own.
- **A receiver that stays connected and stops reading** is not a hang. The sender
  keeps sending (probably because live mode drops at the receiver instead of blocking
  the sender; not checked), so the output looks healthy and nothing restarts it. No sender-side signal tells that
  case apart from a working destination, as with an RTMP destination that
  acknowledges data it never uses.
- **A destination URL that sets `timeout=`** (or another libsrt timeout) changes
  these numbers; the runs used no options.

**Regression test:** `node scripts/test-faults.mjs srt` reproduces the first, second and
last rows on the local stack (the silent path needs `iptables` and root, so it was only
measured on the VM).

**Not tested:** a real SRT platform, a one-way loss (packets dropped in one direction
only), and a libsrt version other than the one built into the pinned FFmpeg.

**Revisit when:** SRT outputs hang or restart late against a real destination.

## Sizing

### Sizing guidance is a measured table, not a calculator

**Decision:** [Sizing a server](../1-getting-started/4-sizing.md) gives per-item CPU
and RAM costs, a formula and example GCP machine sizes. There is no calculator in
the dashboard, and no cost model for individual machine families.

**Why:**
- **The inputs are few.** CPU is dominated by the number of distinct video encodes.
  Copy outputs and audio re-encodes are small, so a table answers "which VM?" as
  well as a form would.
- **A single number would imply precision the data does not have.** An encode's CPU
  varies by about 1.5x with the content (1080p: 1.5 vCPUs on a clean test pattern,
  2.5 on noisy motion), and only one machine family was measured. The table shows
  ranges and a headroom rule instead.
- **Less to maintain.** A dashboard widget is code to test, ships in every install
  and reaches only people who have already installed it; the audience is the person
  choosing a VM.
- **Docs are plain Markdown,** rendered by GitHub and the org site, so an
  interactive widget has nowhere to live in them.

**Evidence:** two sources, both on the production VM (GCP `n2`, 4 vCPU, 4 GB,
FFmpeg 7.1.4). The benchmark ran on 2026-10-18 in an idle window. A private SRS pair on loopback ports with copies of
the production binaries was fed a generated 1080p30 ~6 Mbps stream. FFmpeg ran with
the application's own arguments, each case 15 s warm-up and 45 s measured, CPU from
`/proc/<pid>/stat`, `nice 19`, aborting if production FFmpeg or a live stream
appeared. It ran as two per-origin scripts, now merged into
`skills/benchmark-sizing/sizing-benchmark.py` (the `benchmark-sizing` skill), which
is how to repeat it.
- Copy output: 0.005 vCPU on an RTMP input, 0.02 on SRT (plus 0.01 in SRS); 30
  outputs: 0.16 and 0.93 vCPU.
- Audio re-encode: +0.03 (RTMP) and +0.04 (SRT).
- Encodes at 30 fps (clean / noisy): `720p` 1.1 / 1.7, `1080p` 1.5 / 2.5,
  `vertical_rotate` 0.6 / 0.8 vCPUs. The production feeds are 50 fps, so these
  understate the real use (below).
- Saturation: four `720p` encodes ran at 0.52x real time, three `1080p` at 0.48x.

Observed on production from the per-minute health snapshots (10 to 19 October 2026,
read-only, before shared encodes were deployed there):
- Copy output at 7–10 Mbps on an RTMP input: 0.039 vCPU to an RTMP destination and
  0.036 to RTMPS, 34 MB, against 0.005 in the benchmark. The extra is sending, not
  TLS: about 0.004 vCPU per Mbps sent, which with the benchmark figures reproduces
  the observations to within about 0.04 vCPU.
- Audio re-encode on an SRT input: 0.077 at under 4 Mbps, 0.072 at 7–10 Mbps and
  0.167 on a 4K feed (about 20 Mbps); 47–61 MB. These come from
  `skills/benchmark-sizing/observe-prod.py`.
- Ingest: a 4K (19.9 Mbps) and a 1080p (9.1 Mbps) SRT feed cost SRS 0.10 and the
  relay 0.20 vCPU, about 0.01 vCPU per Mbps; Node 1% and 217 MB.
- A dry run on 2026-10-19 sent the 4K feed to YouTube primary and backup (copy video,
  audio track re-encoded): 0.181 and 0.185 vCPU, 56 MB (129 MB at start), 19.95 Mbps
  at 1.0x for 4 minutes; SRS rose 0.058 vCPU for the two readers and the relay did
  not change. Two 4K encodes were run for memory on a development machine (FFmpeg 8,
  synthetic 20 Mbps input): `vertical_rotate` 472 MB and `720p` 608 MB. With the
  production figures for copy and for `1080p` (940 MB, below) they confirmed the 4K
  memory limit of twice the HD limit (3x above copy, 1.9–2.1x above the encodes), so
  it was left unchanged.
- The encodes in their real use, on the live 1080p50 and 4K50 feeds with the
  application's arguments: `720p` from 1080p 2.05 vCPU and 270–280 MB (60 s, 1.0x),
  `vertical_rotate` from 1080p 1.19 vCPU and 175 MB (90 s, 1.0x). `1080p` from 4K
  ran at 0.53–0.58x on the 4-vCPU `n2` and the SRT pull then broke after about 20 s,
  while decoding alone kept up at 1.83 vCPU (1.1x), so a 4-vCPU host cannot do it. On
  the same VM resized to 8 vCPUs (2026-10-19, 24 Mbps feed) it ran at 1.0x for 90 s at
  5.94 vCPU and 930–940 MB, leaving the host about 90% busy.
- The 2026-10-18 event (21 outputs on average, 17 Mbps in): all processes together
  averaged 1.07 vCPU, peaked at 2.40, and the host used 1.15 GB of RAM on average,
  1.28 GB at the peak.

This replaces the earlier "about one core per encode", "negligible" copy cost and
"hundreds of outputs on modest hardware" statements, which did not match these
measurements.

**Costs:** the numbers are for one machine family. `720p` and `vertical_rotate` were
measured on the production feeds, `1080p` from 4K only for speed and memory (it does
not keep up on 4 vCPUs), and the benchmark input was 1080p30. Copy outputs on an SRT
input and audio re-encodes on an RTMP input have no clean production observation.
They exclude previews and translation mixers.

**Revisit when:**
- FFmpeg, x264 or an encoding profile changes, since every cost above depends on
  them.
- Other machine families (`c3`, `n4`) are measured.
- People keep asking for an interactive tool: a spreadsheet linked from the page is
  the cheapest next step before a dashboard feature.

### No hard cap on inputs or outputs; the stream key count is a setting

**Decision:** the server refuses neither a pipeline nor an output because of a
count. The 50 inputs and 500 outputs in the
[introduction](../1-getting-started/1-introduction.md#capacity-and-limits) are the
tested envelope, as a recommendation. The number of stream keys is
`stream_key_count` in `bunryu.json` (default 100), and since each pipeline uses one
key it is the most inputs there can be.

**Why:**
- **The machine is the limit, and the operator knows it.** Whether 500 outputs fit
  depends on bitrate, protocol and audio re-encodes (about 4 vCPUs per 100 copy
  outputs at 8 Mbps, see [Sizing a server](../1-getting-started/4-sizing.md)). A fixed
  number is too high for a small VM and needlessly low for a large one.
- **A cap refuses work during an event.** The old output limit (500, enforced in the
  database layer) answered the 501st with `409`, and the bulk create refused a
  request of more than 500 outputs, on a server that might have had room.
- **The stream keys needed a number anyway.** 99 keys were generated whatever the
  deployment; a setting lets a small server have fewer and a large one more, and it
  adds no API field or dashboard control.

**Behavior:** on startup the missing keys up to the count are generated. Lowering
the count removes the keys above it that no pipeline uses; a key a pipeline already
uses stays, and new pipelines only get keys within the count. A value that is not a
whole number from 1 to 10,000 falls back to 100: the upper bound only stops a typo
from generating a million keys at startup. A request body is still limited to 1 MB,
which bounds a bulk create.

**Costs:** nothing stops an operator from adding more than the host can run. The
protection against that is the sizing guidance and the output and host-memory
watchdogs, not a refusal.

**Revisit when:** a deployment overloads itself with outputs added in good faith, and
a warning in the dashboard (rather than a refusal) would have helped.

## Dashboard

### Installable as an app with a manifest only, no service worker

**Decision:** `public/manifest.webmanifest` and the icons in `public/icons/` let
Chrome and Edge install the dashboard as a standalone window. There is no service
worker.

**Reasons:**

- Chrome does not require a service worker to offer install on desktop.
- The server sends `no-store` on every JS and CSS file so a deploy never leaves a
  browser on an old module graph (see `src/index.ts`). A service worker is a
  second cache that could undo that.
- An offline shell would be useless: the dashboard is only meaningful with the
  live API.
- The manifest link uses `crossorigin="use-credentials"`. Production sits behind
  Cloudflare Access, and a manifest request without the Access cookie is
  redirected to the Access login and silently ignored.

**Revisit** if push notifications or an offline page are wanted; both need a
service worker and a cache policy that keeps deploys from going stale.

### The Overview filters in the browser, and searches names, keys and URLs

**Decision:** each Overview table has its own search box on its heading line, matching
as plain, case-insensitive text: an input's name, stream key and publish URLs, an output's
own name, its pipeline's name and its destination URL. It filters the rows already in the
browser and combines with the All/Active/Issues tabs. The Issues tab also lists an
offline input when outputs of its pipeline are in trouble, and the heading badges show
"shown of total".

**Why:**

- **At 50 inputs and 500 outputs the Overview is about 32 screens**
  ([Sizing](../1-getting-started/4-sizing.md#the-dashboard-at-the-supported-ceiling)), and
  finding one output meant scrolling. The page already holds all 500 rows (about 18 KB
  gzipped each refresh), so a server-side search would add an API route for nothing.
- **Two boxes, not one:** the tables have different rows and an output matches on its
  pipeline's name too, so one box would filter two lists by different rules.
- **An offline input stays "off" everywhere else.** An idle pipeline before a show is
  normal, so marking it a warning would turn the sidebar yellow for every unused
  pipeline. It is an issue only where an operator is looking for causes: the Issues view
  with affected outputs. Before, that view listed 20 affected outputs and "No input
  issues" while two inputs were down.
- **A heading that says 500 above a list of 20** hid how much a filter had removed.

- **URLs and keys were added at the operators' request (October 2026).** The first
  version matched names only, because a destination URL can hold a platform stream key.
  But finding "the output that sends to this URL" or "the input with this key" is what
  operators search for, and the search shows nothing new: the rows still display what
  they did, and anyone who can type in the box can already open the output or input to
  read the same URL. The match is local to the browser; nothing is sent.

**Not adopted:** matching statuses, regular expressions, and a search that also covers
the SRT Relay table.

**Tested:** 50 pipelines and 500 outputs on the test stack, typing during the 5 s
refresh (focus, text and caret survive it).

**Revisit when:** operators ask to search by status, or the output limit rises.

### The Outputs list has a filter bar, and a pipeline's Problems filter means what the card shows

**Decision (October 2026):** above a pipeline's outputs sit a filter box (name or
destination URL), a **Problems** toggle and badges counting errors, warnings, running and
stopped, with "8 of 44" while a filter hides outputs. **Problems** keeps an output with an
error or any warning its card shows: a crash being retried, a stop after repeated
failures, a warning from the running output, "Same destination as …" and the encoding
advice. The filter is per browser, starts empty for each pipeline, and cards cannot be
dragged while it hides any.

**Why:**

- **A failing output among 100 meant scrolling about 6 screens** (a healthy card is 56
  px). The Overview already filters, but only across pipelines and without the card's
  warnings.
- **The sidebar's counts are not enough.** They count each output's live status, so they
  leave out the card-only warnings (a same-destination warning on a running output, advice
  on a stopped one). The badges and the filter use the card's rule, so what is yellow or
  red is what Problems keeps. The two sets of counts differ for that reason.
- **Running and stopped are the outputs' own state, and errors and warnings overlap
  them.** A first version put each output in its most severe bucket only, so the badges
  added up to the total, but a stopped output with a warning was missing from "stopped".
  That read as lost outputs; the overlap is easier to read than the sum.
- **No dragging while filtered:** the saved order lists every output, so a drag of only
  the visible cards would drop the hidden ones from it.

**Not adopted:** a one-line row mode (a healthy output is already one row in a normal
width; the height is in warning lines), and a sort that puts problems first (the saved
manual order stays).

**Revisit when:** repeated warnings across many outputs keep filling the list (grouping
identical warning lines was left out), or the sidebar counts confuse operators.

### An output's bitrate is shown only when it is off the input's

**Decision (October 2026):** the output badge (and a shared encode's) leaves out the
bitrate while it is between 60% and 140% of the pipeline input's, when the output copies
the video and the input's rate is known. Below 200 kbps it always shows, and an output
with a video encode or without an input rate always shows it. The speed is shown only
outside 0.95x to 1.05x, with no mention in the tooltip.

**Why:**

- **Every healthy copy output printed the same "8.0 Mbps"**, which carried no
  information until it differed, and it was clutter on 100 rows.
- **The band is wide because the numbers differ for normal reasons.** On an SRT input
  SRS reported 8.9 Mbps and the goryu legs 9.2 (libsrt counts 44 header bytes in each
  1316-byte packet, +3.3%), while copy outputs read 8.2 and 8.0: FLV carries less
  container overhead than MPEG-TS. FFmpeg's `bitrate=` is also an average since the
  output started, not the current rate.
- **A faulty output is caught elsewhere too:** below the 200 kbps minimum or with no
  bitrate the card warns, and the stall watchdog restarts a frozen output.

**Limit:** because the figure is a lifetime average, a drop in a long-running output
moves it slowly and may not leave the band. A rate over the last 30 s (the delta of
`total_size`, as the speed already uses `out_time`) would react in seconds but changes
what `bitrateKbps` means in the API, the Overview and the low-bitrate warning, so it was
not done.

**Revisit when:** operators miss a slow drop (switch to the windowed rate), or the band
hides a real fault.

### Alert sound beeps for new problems only, in the browser

**Decision:** the dashboard beeps once a second for 5 s when a problem appears that was
not there at the previous 5 s poll:
- the server, SRS or the SRT relay becoming unreachable;
- an error-level pipeline alert;
- the host running low on memory or disk space (the host alerts in `hostAlerts`);
- an input going offline while its outputs are meant to run;
- an output crashing or being restarted by a watchdog.

A problem that lasts stays silent. The bell in the navbar mutes it, and its slider sets
the volume (0–500%); both are kept in browser local storage and shared by tabs on the
same site. The page tries to resume audio on startup; if browser autoplay policy blocks
it, the bell still reflects the saved mute setting. The beep and control are ported from
live-gallery's alert beeps, so both tools sound alike.

**Why:**

- **Beeping while a problem lasts gets the sound muted.** A destination that is down
  for an hour retries every 16 s. A crash within 60 s of the same output's previous
  one counts as the same episode (the server's `STABLE_RUN_MS`), so a failing output
  beeps when it starts failing, not on every retry. Tested on the test stack: an output
  to a destination refusing connections beeped once and stayed silent through its next
  five attempts.
- **The first poll after opening the page only records what is already wrong**, so a
  reload does not beep for problems already on screen.
- **In the browser, not the server.** The dashboard is on a visible screen during
  events, so its sound reaches the operator without push permissions, Do Not Disturb or
  a phone. The 5 s poll already carries everything needed, so the server is unchanged.
- **Warnings do not beep** (timestamp floods, falling behind, SRT loss): they are
  frequent and usually recover on their own.
- **Host memory and disk beep, host CPU does not.** Low memory ends with the kernel
  killing FFmpeg or SRS, and a full disk breaks the database, diagnostics and journal,
  and neither clears on its own. The CPU alert's thresholds come from a desktop
  measurement, not production (see [Host resource alerts](#host-resource-alerts-cpu-pressure-memory-and-disk)),
  so a beep on a healthy event would get the bell muted. It still shows in Server events.

**Not adopted:** a "silence for N minutes" button (mute is simpler, and the operator
decides when to unmute); keeping a background tab's polling unthrottled (the dashboard
is on top during events); push notifications.

**Revisit when:** operators mute it because it beeps too often, a problem worth a
beep reaches the dashboard only as a warning, or the CPU alert has fired only on real
trouble in production (then add `cpu` to the beeping host alerts).

### Don't probe platform hosts from the server

**Decision (October 2026):** the host connectivity probes were removed: a dashboard
tab that opened a TCP connection every 5 s from the server to up to 10 configured
`host:port` targets (for example a platform's RTMP ingest) and charted the latency.
Destination failures are diagnosed from the outputs themselves.

**Why:**
- **It left no evidence.** The samples were kept only in memory (6 h) and never
  written to the diagnostics, the journal or the pipeline log, so a service restart
  erased them and nothing could be read back after an incident. Only someone with the
  tab open at the time saw them.
- **It raised no alert.** Nothing in the health poll, the alerts or the beeps used
  the result, so it could not warn during a live event.
- **The outputs already say the same.** A destination that refuses or times out
  shows in that output's History (FFmpeg's stderr tail and exit reason), in the
  socket watchdog's findings and in its retry state, per output and with a
  timestamp. The probe added only "is the platform down or just this output?", and
  only for someone who looked.
- **It has not helped.** The one incident it could have explained was a live event
  where a platform's RTMP ingest was unreachable, and no fail-report cites it. General
  network problems are watched by a separate monitor (Ping Monitor), which does not
  cover the path from this VM to the platforms.
- **Cost:** a service and loop, a settings form, a dashboard tab and chart, two API
  routes, a database table and several hundred lines of tests, for a view that has not been useful.

**Existing databases:** the table is dropped from the schema and `SCHEMA_VERSION` is
bumped to 2, so an install with a version-1 database is asked to wipe it on the next
install, like any schema change (see
[Database schema version](../3-operations/3-configuration.md#database-schema-version)).
The pipelines and outputs have to be created again from the `.bak` copy.

**Not measured:** how often operators opened the tab.

**Revisit when:** an incident shows that "the platform was unreachable from the VM"
could not be told from the output's own error. Then log one TCP connect check to
that destination in the output's existing failure event, which needs no
configuration, loop, table or UI.

## Tooling

### ESLint checks promise handling; Prettier stays the formatter

**Decision:** `npm run lint` runs ESLint with the `typescript-eslint` recommended
rules plus four type-aware ones: `no-floating-promises`, `no-misused-promises`,
`await-thenable` and `only-throw-error`. `eslint-config-prettier` turns off every
rule that overlaps with Prettier. CI runs lint as its own job.

**Why:**
- **`tsc` misses crashes that matter here.** It accepts an `async` callback passed
  to `setTimeout` or an event emitter. If that callback rejects, nothing handles
  the rejection and Node exits, taking every pipeline's control plane with it.
- **The type-aware rules are cheap at this size.** A full run takes about 10 s.

**Evidence:** the first run, in October 2026, found about 30 issues in 18,000
lines. One was a real crash path: the scheduled ffprobe in `health.ts` had
`try`/`finally` with no `catch`, so a throw while recording the result would have
been an unhandled rejection. It is now covered by a test. The rest were unused code
and small cleanups.

**Not adopted:** stylistic rule sets and the `strict` presets. They would mostly
churn working code.

**Revisit when:** the lint run gets slow enough that people skip it, or a bug
reaches production that a rule would have caught.

## Logging and diagnostics

### Keep the process running after an uncaught error

**Decision:** `uncaughtException` and `unhandledRejection` are logged (journal and
a diagnostics event) and the process keeps running. Each background loop (health
poll, output watchdog) also catches its own errors and logs the
first failure and the recovery. The diagnostics writer handles its own stream
errors. Shutdown steps and staggered restarts run through `runLogged`, which records
a throw as `step-failed` and carries on. Requests answer errors in JSON.

**Why:**
- **Exiting kills every output.** The FFmpeg processes exit by SIGPIPE when the
  control plane dies (by design, so none are orphaned). A bug in one timer or a
  full disk would otherwise end every forward of a live event, and systemd's
  restart would not bring them back for several seconds.
- **The loops are independent.** A throw in the health poll leaves the output
  processes and their watchdog untouched. The next tick starts from fresh state.
- **Surviving an error must not leave the process half-stopped.** A throw inside the
  SIGTERM handler would be swallowed by the same handler and a second SIGTERM is
  ignored, so the process would never exit. Each shutdown step is isolated.
- **One bad row must stay one bad row.** An unparsable `outputs.last_error` made
  every `listOutputs()` throw (watchdog, health, API). It now reads as empty history.
- **A server error must not look like a lost connection.** Express's default 500 is
  HTML; the dashboard failed to parse it and showed the connection banner. Errors are
  JSON and the dashboard shows the status of a non-JSON answer.

**Evidence:** before this, nothing listened for errors on the diagnostics
`WriteStream`, so a full disk would have crashed the app, and so would an
unwritable diagnostics directory at startup. The health poll and the host-probe loop
(since removed, see [Don't probe platform hosts from the server](#dont-probe-platform-hosts-from-the-server))
had `try`/`finally` with no `catch`, the same pattern the ffprobe fix (see the
ESLint entry above) removed. Regression tests cover a write-stream error, an
unwritable directory, a throwing health poll, a corrupt History row, `runLogged`
and the JSON error handler.

**Revisit when:** an incident shows the process kept running in a broken state
after an uncaught error. Then exit on `uncaughtException` and rely on systemd.

### Diagnostics ideas taken from SRS, MediaMTX and restream-krsna

**Decision (October 2026):** adopted:
- a per-run id on every output event (SRS tags every line, hook and API entry
  of a connection with one context id);
- the first occurrence plus a count of the rest for repeating events (SRS's
  error pithy print, MediaMTX's 1 s counter dumpers), applied to rejected
  publishes, loop failures and repeated exit stderr tails;
- alert episodes with a start and an end, derived from the 5 s poll (krsna
  derives alerts from its health snapshot);
- a random id per server start (SRS's heartbeat `service_id`).

Not adopted:
- **A Prometheus `/metrics` endpoint** (both SRS and MediaMTX have one). Nothing
  scrapes it yet, and it would be a new port or route to secure.
- **Delivery ratio** (destination-acknowledged bytes ÷ offered bytes) and
  **layered root-cause diagnosis** (krsna). Both are useful, but each needs new
  state and UI.
- **Logs in SQLite** (krsna). JSONL plus journald is enough at this size.

**Revisit when:** someone wants external alerting (add `/metrics`, loopback-only),
or an incident shows outputs connected but not keeping up (add the delivery
ratio; `outputSockets.ts` already reads `ss`).

### Warn when an output falls behind realtime, measured from its media clock

**Decision (October 2026):** every output gets a "falling behind" card warning when
its media clock runs below 0.9x wall time over two 30 s windows in a row. The speed
is computed from FFmpeg's `out_time` progress, not read from its `speed=` or `fps=`.
It is a warning only, like the other card warnings.

**Why:**
- **The existing watchdogs miss it.** The progress watchdog fires only when progress
  stops for 45 s, and the socket watchdog only when the socket is gone. An output
  whose destination or encode accepts data slower than realtime has both, yet gets
  further behind live every second until SRS's play queue drops data.
- **`speed=` and `fps=` are whole-run averages** (measured with the pinned FFmpeg
  on a copy output: `speed` and `fps` after 2.5 s still carried the initial burst).
  After hours of healthy running a slowdown would barely move them.
- **Two windows, and a gap resets.** One slow window is what an input hiccup looks
  like. A pause of more than 10 s is a stall, which the progress watchdog owns.
- **Warn, never restart.** A restart does not fix a slow destination or a slow
  encode, and would drop the platform session for nothing.

**Not adopted:** killing a slow output; a per-output `speed` field in the API (the
warning text carries the number).

**Revisit when:** the warning fires on healthy outputs (then widen the window or
lower the threshold), or operators want to see the speed continuously.

### Host resource alerts: CPU pressure, memory and disk

**Decision (October 2026):** the health poll raises an alert, with a separate end
threshold, when host CPU pressure, available memory or free disk space crosses a
line. It is reported (journal, diagnostics events, the dashboard's Server events
table) and nothing is acted on. The numbers are in
[Reliability](../3-operations/4-reliability.md#host-resource-alerts).

**Why:**
- Before this only memory had an alert. A CPU-starved host (the sizing page shows a
  `1080p` encode of a 4K input not keeping up on 4 vCPUs) makes outputs fall behind
  and SRT ingest drop packets, and the operator saw only each symptom per pipeline.
- Start and end thresholds differ, and the CPU alert also needs the reading to hold
  for 30 s (start) and 60 s (end), so a reading that hovers near the line is one
  episode, not a stream of them. The same idea ends a pipeline alert after six quiet polls.

**CPU uses pressure (PSI), not utilisation:** an encode is meant to use the CPUs (a
`720p` encode takes about 2 vCPUs), so a host sized for its encodes is near fully busy
while healthy and a utilisation alert would fire in normal use. Pressure stays near
zero until something waits for a CPU. It also means no fallback: a kernel without `/proc/pressure/cpu` gets no CPU
alert, rather than a utilisation guess that would fire on healthy encodes.

**Evidence for the thresholds (8-CPU development host, busy loops, `some avg10`):**

| Busy loops | Load | Pressure after 45 s |
|---|---|---|
| 8 | 1.0x | 25-30% |
| 10 | 1.25x | 46-53% |
| 16 | 2.0x | 68-70% |

A first draft used 90 to start and 85 to end; that never fires, since pressure stays
near 70 even with the host twice oversubscribed, and a threshold of 70 would stay
silent at about 1.5x oversubscription, where the sizing page has a `1080p` encode of a
4K input no longer keeping up (about 55-60% by interpolating the table). 50 is about
1.25x oversubscription, and 30 sits just above the reading of a fully busy but
unstarved host, so its noise does not hold an alert open. These come from a desktop with background load, not from the
production VM.

**Disk:** the filesystem of the database directory (database, diagnostics, HLS
previews) and the root filesystem (journald, SRS logs), alert under 10% free and end
at 15%. Diagnostics are size-capped and previews stop when idle, so this catches the
journal, logs or database growing, or another tenant of the disk.

**Not adopted:** acting on the alert (stopping outputs, shedding load), which could
take down streams on a reading that may be harmless; a dashboard banner or beep,
until the table proves useful (the beep is for pipeline problems).

**Revisit when:** a production incident shows the CPU thresholds firing late or on
healthy load (compare `host.cpuPressure` in the `health-snapshot` with the alert
times), or operators need these in front of them rather than in Server Logs.

### Failures that need an operator exit with status 78, which systemd does not restart

**Decision (October 2026):** a database stamped with another schema version, or a
missing or invalid config file (`bunryu.json`, `srs.conf`, `goryu.json`), makes the
app print why and exit with status 78 (`EX_CONFIG`). `bunryu.service` sets
`RestartPreventExitStatus=78`, so it stays failed instead of restarting.

**Why:** the units set `StartLimitIntervalSec=0` so a crashing service always comes
back, and that would turn an error only a person can fix into a restart every 2 s,
filling the 1 GB journal with the same message and pushing out older, useful logs.
Verified on systemd 259 with throwaway units: exit 78 stays `failed` with no
restarts, and any other exit keeps restarting. SRS and the relay `Require` the app,
so they stay down too, and nothing accepts a publish it cannot authorize.

The installer reads the database's stamp (byte 60 of the SQLite header, so it needs
neither `sqlite3` nor the node modules an update has not rebuilt yet, see
`scripts/db-schema-version.sh`) after pulling the new code and refuses to continue on a
mismatch unless `WIPE_DB=y` (or Enter at its default-yes prompt) agrees to the wipe, so the failure
shows up at deploy time with the running service untouched. The Docker supervisor
treats 78 the same way: it does not restart the app, does not start SRS or the relay,
and keeps the container up (unhealthy, with the message in `docker logs`) rather than
exiting into the restart policy, which would repeat the message.

**Config files.** The three files are read once at startup and kept until the next
restart, so a wrong one has to be found at that moment, before any module uses it.
Before this, a broken `bunryu.json` crashed and restarted every 2 s forever, a
missing `srs.conf` left the dashboard half working (`/api/config` answered 500), and
a missing or malformed `goryu.json` silently fell back to the defaults: an empty
passphrase and the default relay ports, with nothing in the log. Only a missing file
or invalid JSON exits 78, because the next attempt would fail the same way. Any
other read error, such as an I/O error, crashes the process and is restarted after 2 s,
so a transient fault cannot leave the server down. Checked on the built app: each of
the three files missing, and an invalid `bunryu.json`, exits 78 with a timestamped
message naming the file.

The judgment call is `goryu.json`: it only affects bonded SRT, yet a typo in it
now stops RTMP and plain SRT too, because SRS and the relay require the app.
Accepted because the files change only between events, when a restart shows the
error at once, and one rule for the three files is simpler than a fallback that
hides the fault. The call to read the files has to be the first import of
`src/index.ts` (`startupGate.ts`): tsx and bundlers hoist imports above other
statements, and one run found the check running after a module that had already
read `bunryu.json` and crashed with exit 1.

**Not adopted:**
- A migration path, which AGENTS.md rules out; the schema version only turns a
  confusing failure into a clear one.
- A dashboard alert with the app running on the wrong database: login, sessions and
  the SRS publish hook all read that database, so it would need a special mode
  guarding every route, and an app that is up but cannot work passes liveness checks
  and lets SRS and the relay start.
- Wiping automatically under `-y` or without a terminal: it discards the pipelines
  and outputs (a backup copy is kept), so it needs `WIPE_DB=y` or an interactive
  answer. The prompt defaults to yes because declining only ends the install, but
  only a person at a terminal can accept it.

**Revisit when:** a mistyped `goryu.json` takes down ingest that did not need the relay
(the fallback, with an error logged once, would be the alternative), or another failure
class needs the same treatment.

### Keep a fixed 2 s systemd restart delay, with no back-off

**Decision (October 2026):** the units keep `Restart=always`, `RestartSec=2` and
`StartLimitIntervalSec=0`. A service that crashes right after it starts is restarted
every 2 s until someone fixes it.

**Why:**
- The loops that matter are already bounded: an error only an operator can fix exits
  with 78 and is not restarted, SRS waits for the app's readiness check (up to 60 s)
  before it starts, and the journal is capped at 1 GB.
- A crash during a live event is back in 2 s. A back-off would only add delay to the
  case that matters most.
- No crash loop has happened, so there is no incident to size a back-off against.

**Not adopted:**
- `RestartSteps=` and `RestartMaxDelaySec=`: they need systemd 254. The production VM
  runs Ubuntu 22.04 with systemd 249, where a throwaway unit with `RestartSec=1`,
  `RestartSteps=4` and `RestartMaxDelaySec=8` restarted 21 times in 25 s at a constant
  gap of about 1.2 s. The directives are silently ignored.
- A delay computed in `ExecStartPre` from `NRestarts`: systemd only resets that counter
  on a manual start or stop, so a crash a week into an event would inherit the delay.
- `StartLimitIntervalSec` and `StartLimitBurst`: the unit would give up and stay down,
  which is what `StartLimitIntervalSec=0` exists to prevent.

**Revisit when:** the production VM moves to systemd 254 or later (Ubuntu 24.04 ships
255), or a crash loop fills the journal or loads the host. The Docker supervisor has
the same fixed 2 s delay (`docker/entrypoint.sh`).

### Hints are a dashboard lookup, not an API field

**Decision (October 2026):** the hints on known errors, warnings and alerts come from patterns in `public/ts/core/hints.ts`, matched against the text the
server already sends. There is no `hint` or `recommendedAction` field in the API.

**Why:** the advice is presentation (it can change wording without touching the
server or its diagnostics), and an API field would be one more thing to document and
keep stable. Matching the stderr text is as fragile as the FFmpeg messages it matches,
so an unmatched error is shown as it was, with no hint, which costs nothing.

**Not adopted:** restream-krsna's `evidence` and `recommended_action` on every alert,
which needs structured causes the server does not have for FFmpeg output errors.

**Revisit when:** a client other than the dashboard needs the advice, or a hint
should depend on state the dashboard does not have.

### Restart outputs when a reconnecting encoder changes format, not when it merely reconnects

**Decision (October 2026):** after a new publisher's ffprobe succeeds, its format
(video codec, resolution, audio track count) is compared with the pipeline's last
successful probe. If they differ, the outputs that were running before that publisher
connected are restarted, 200 ms apart, at most once per pipeline per minute. Outputs are
still not restarted for a plain reconnect.

**Why:**
- **It is a deterministic signal.** The decision to never restart on a reconnect rests on
  there being no reliable way to tell an encoder restart from a network drop (see
  [Reliability](../3-operations/4-reliability.md#encoder-restarts-do-not-restart-outputs)).
  A different format needs no such guess; a stream copy cannot follow it, so a restart
  repairs something already broken instead of dropping a working destination.
- **It reuses the existing re-probe**, which already runs once per new publisher, so
  there is no new polling.
- **Failed probes and the first probe never trigger it**, since neither shows a change.
- **The cooldown bounds it**, so an encoder that alternates formats does not cause a
  restart storm; the skipped change is still reported.

**Not adopted:** restarting on a frame-rate or bitrate change (copy outputs carry both);
restarting every output on every new publisher (the rejected approach above); a
`bunryu.json` switch (the restart only fires on a stream that was already breaking).

**Revisit when:** a format change turns out not to need a restart for some destination
type, or probes after a reconnect prove unreliable enough to report a change that did
not happen.

## Ingest protection

### Don't ban abusive ingest clients with fail2ban

**Decision:** the repo does not install or manage fail2ban. The app logs rejected
`on_publish` and `on_play` attempts (publish rejections throttled per key), and
that is where the built-in protection stops.

**Why:**
- **It was tried and removed.** Earlier versions used fail2ban as a narrow
  RTMP/app-hook protection. It added root-owned config, sudo helper scripts, a
  dashboard whitelist/status UI and extra test surface, and still left the most
  important gap, SRT, uncovered.
- **Neither SRT listener logs a bad-passphrase rejection in a form fail2ban could
  act on:**
  - SRS's SRT server (port `10080`) rejects a handshake that fails its
    `passphrase` check, either because the peer declares no encryption or because
    `SRTO_ENFORCEDENCRYPTION` fails the key exchange. The rejection happens
    inside the SRT handshake, before `srt_accept()` returns, so SRS's own log
    (`ERROR:UNSECURE` / "Password required or unexpected") never records the
    peer's IP.
  - `goryu`'s listener (port `10081`) used to log a matchable
    `[srt-relay] rejected connection (bad passphrase) from <HOST>` line from its
    own `srt_accept()` KMSTATE check, and a dedicated jail watched it. As of
    `goryu` v2.1.0 that line is no longer logged, so a jail would have nothing to
    match.
- **The part that can be matched is only a partial defense.** The logged
  rejected-publish lines would be enough for a jail on repeated bad RTMP
  stream-key attempts from one IP. That does not cover SRT bad passphrases, does
  little against distributed attackers, and is no substitute for an edge or
  firewall deployment at a high-risk event.
- **Brute force is not a practical risk.** The passphrase is a long random
  string and each guess needs a live SRT handshake round trip, so online guessing
  is computationally infeasible whether or not anyone is banned. The real effect
  is log and CPU noise from a misconfigured device or scanner that retries
  forever.

**What to do instead:** for small events rely on strong stream keys, a strong SRT
passphrase and the non-default RTMP port (`21935`). For larger or higher-risk
events keep the origin private and put a media-aware ingest edge or a provider
firewall/DDoS layer in front of it.

**Revisit when:** SRS or `goryu` logs a rejected SRT peer's IP in a matchable
form, or an incident shows repeated bad-key or bad-passphrase attempts causing
real load.

## Install and secrets

### The initial dashboard password is supplied, never generated or printed; the app config lives in `/etc/bunryu`

**Decision (October 2026):** a fresh install must be given the initial dashboard
password: `BUNRYU_DASHBOARD_PASSWORD`, or `dashboard_password` in
`/etc/bunryu/bunryu.json`. Without one the installer stops before changing
anything. The Docker entrypoint applies the same rule on an empty `/data` volume. A
run that keeps the database needs none, because the password only seeds an empty
one. `bunryu.json` moved from `/opt/bunryu` to `/etc/bunryu`, and the app finds it
through `BUNRYU_CONFIG` (unset means `./bunryu.json`, so dev checkouts are
unchanged). The installer and the Docker entrypoint set only `port`, the file paths
and the password in that file and keep every other key. `server-reset-password.sh` refuses to run when the file has no
`dashboard_password`.

**Why:**
- **Install output is copied.** The old installer printed a generated password at
  the end, and the container logged one. Startup scripts, SSH session logs,
  `docker logs` and pasted tickets all kept it. A password the operator chose is
  never shown.
- **The file was inside the git checkout.** `bunryu.json` is tracked, so the
  installer's `git reset --hard` restored the repo copy, which has no password. A
  reinstall therefore generated a new password into the file that no longer
  matched the kept database, and `server-reset-password.sh` would then apply the
  wrong one. `srs.conf` and `goryu.json` were already in `/etc/bunryu`, which is why
  the SRT passphrase survived reinstalls. The app config now sits beside them.
- **Failing early beats a default.** The app used to fall back to the public
  `admin` when it had no password to seed an empty database with, so a wiped
  database or a hand-made config could silently create that login. It now exits
  with status 78 instead, and the installer, the entrypoint and the reset script
  check first and say how to fix it. The repo's own `bunryu.json` ships `change-me` for
  development, which the installer, the unit and the image never read.
- **Hand edits must survive an update.** The installer used to write the whole
  file from a template, so a value an operator added, such as `trust_proxy` behind
  the Cloudflare Tunnel (without it every user shares one login rate-limit bucket),
  was lost on the next update without a message. Its template values equalled the
  app's own defaults, so rewriting them changed nothing except undoing edits. It now
  sets only what it has to (`port`, which the units' readiness check hardcodes, the
  file paths and the password) and keeps every other key.

**Not adopted:**
- **Carrying over a named list of keys** (first `dashboard_password`, then
  `trust_proxy`): every setting someone needs next would need adding to the list.
- **The same merge for `srs.conf` and `goryu.json`:** they are refreshed from the
  repo on purpose, because the app, the units and the docs assume their hook URLs,
  ports and SRT settings. Only the SRT passphrase is kept.
- **Generate and print once**, the previous behavior: the leak above.
- **Generate and write only to the file**: the operator would then have to read a
  root-only file to log in, and the installer could not tell a deliberate empty
  value from a missing one.
- **A real password in the tracked `bunryu.json`**: it invites editing a tracked
  file in a public repository, so the repo ships only the `change-me` dev
  placeholder.

**Tradeoffs:** `compose.yaml` passes the variable through, so `docker compose up`
without it restarts the container with the error in `docker compose logs` until it
is set (the supervisor is for evaluation only). The variable stays in the container
environment after the first start.

**Revisit when:** a second secret needs the same handling, or the Docker image is
used for real deployments and `docker secret` support matters.

### The SRT passphrase is reset from Settings by rewriting both files; the app does not restart SRS or Goryu

**Decision (October 2026):** Settings has a **Reset** button, like the stream-key
one, that writes a new random passphrase to `srs.conf` and `goryu.json` and shows a
banner until the restart. It is refused (`409`) while an input is live or an output is not stopped.
It changes files only: SRS and Goryu pick the value up at their next start, which
the operator causes by rebooting the server or restarting the container.

**Why:**
- **Restarting from the app is the riskier code.** It would mean signalling SRS and
  Goryu, waiting for both to answer with a new PID and handling one not returning:
  about 150 to 250 lines of new process supervision, in the area this project
  treats as high-risk, for something done between events a few times a year.
- **The reset happens between events anyway.** With no stream running, a reboot
  straight afterwards restarts SRS, Goryu and the app together, so the three agree
  again and nothing needs to be signalled.
- **The two files are written together or not at all.** Both new contents are built
  first, so a file the app cannot parse changes nothing. Each is written to a temp
  file in its own directory and renamed, and `srs.conf` is put back if the second
  rename fails, so a crash or full disk cannot leave SRS and Goryu with different
  passphrases (bonded SRT would stop working). The installer already makes
  `/etc/bunryu` writable for the service user, so no unit change was needed.
- **The dashboard keeps the old value until the restart.** The app caches both files
  at startup, so the publish URLs match what SRS and Goryu enforce rather than a file
  they have not read yet. An open dashboard picks the new value up by itself after the
  restart, because the app's config revision starts from the clock on every start.
- **The restart reminder is a banner, derived from the files.** A note on the Settings
  page was gone after a reload and invisible from every other view, and the restart is
  the step that matters. `/api/config` compares the passphrases now in the files with
  those read at startup (`srtPassphrasePending`), so the banner survives reloads, shows
  on every open dashboard and clears by itself when the app starts again. It stores no
  flag that could go stale. If only the app restarts, SRS keeps the old value and the
  banner still clears, which is why it says to restart the server or container.
- **The new value is not shown or returned.** It could not be used before the restart
  anyway, so showing it would only put the secret on screen and in a response. The
  dashboard's copy buttons give it after the restart.

**Not adopted:**
- **Restarting SRS and Goryu from the app:** see above. Resets are not needed
  during an event today.
- **Clearing the cache so the dashboard shows the new value at once:** the direct
  and bonded URLs would then show a passphrase nothing enforces yet, and a stray
  SRS crash or watchdog restart would silently apply it in the middle of an event.

**Tradeoffs:** a reset that is not followed by a restart leaves the new value armed
on disk: any unplanned restart of SRS or Goryu applies it, and every encoder with the
old URL then fails at the SRT handshake. The dialog and the Settings text say to
restart straight away. If only one of the two services restarts, it and the other
disagree until the second does too.

**Revisit when:** a reset is needed while streams are running.

**Checked on the isolated test stack:** a reset with a live input and four running
outputs returned `409` and left both files byte-identical; after stopping them it
returned `200`, both files held the same 32-character value and no temp file
remained, the API still showed the old value with `srtPassphrasePending` changed from
`false` to `true`, the banner showed on the Overview, and the log and diagnostics
recorded `srt-passphrase-reset` without the value. That the flag clears after a restart
follows from the comparison, which unit tests cover; it was not run through a restart.

### The Docker image is x86_64 only; ARM hosts run it emulated, for development

**Decision (October 2026):** no native arm64 image. Production is Linux x86_64, and
`compose.yaml` sets `platform: linux/amd64`, so Docker on an Apple Silicon Mac or
other ARM host runs the same image emulated. That is enough to try Bunryu or
develop against it.

**Why:** production doesn't need ARM, and two of the three pinned binaries have no
arm64 build to pin: goryu's releases are x86_64 only, and the FFmpeg 7.1 we mirror
has no arm64 counterpart (BtbN now builds arm64 only for 8.1 and later; FFmpeg 8.0.1
stalled pulling SRT from SRS on a development machine). SRS does publish an arm64
`ossrs/srs:v6.0-r2`. The emulated run was not tested, because the development host
is x86_64.

**Tradeoffs:** emulated timing and CPU say nothing about real capacity, so the
sizing numbers are x86_64 only.

**Revisit when:** developers need to debug media behavior on ARM, or production
moves to arm64 VMs. It needs an FFmpeg 7.1 arm64 build mirrored like the amd64 one,
an arm64 goryu release, the arm64 SRS from `ossrs/srs`, and a multi-platform image
build.
