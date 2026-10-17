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

### Don't build our own media server

**Decision:** no in-house RTMP/SRT server, and no adoption of new projects as the
core server until they have production history.

**Why:** a small server is feasible in line count, but the cost is in encoder
compatibility (RTMP handshake and command variants, chunking, extended
timestamps, enhanced RTMP) and behavior on bad networks, which only show up in
real use. A new server carries every input at once, so its bugs reach every
stream.

## SRT ingest

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

## Outputs and preview

### One FFmpeg process per output

**Decision:** each output runs in its own FFmpeg process with its own watchdogs.

**Why:**
- A stalled destination, a corrupt input frame or a memory blow-up affects only
  that output, and it can be restarted on its own (see
  [Reliability](../3-operations/4-reliability.md)).
- FFmpeg also does every transcode, audio-track selection and translation mix.

**Cost:** roughly 12–16 MB of RAM per copy-mode output, and a full core per
custom video encoding (once per distinct encode on a pipeline, since outputs with
the same encode share one: see
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
  service's supervision, watchdogs, retry back-off, Error History, stats and
  health unchanged. A reconciler (one tick per second) creates, removes, starts and
  idle-stops the rows.
- **No schema change and no config option,** so the production database is not
  wiped. A hidden pipeline or a new table would have needed new supervision,
  health and history paths for the same behaviour.
- **Which outputs share:** not plain copy, not multi-track (`0,1`, since RTMP/FLV
  carries one audio track) and not translation (owned by the mixer). One output with
  a recipe still goes through a rendition: one code path, at the cost of one extra
  copy FFmpeg (about 12–16 MB, a few percent CPU).
- **The internal app is reserved:** users cannot create, edit, start, stop or
  delete renditions or point an output at the app; SRS's publish hook accepts it
  only over RTMP from loopback for a running rendition row. Renditions do not count
  toward the 500-output cap.
- **Readiness is local** (process running and data written), not the 5 s health
  poll. When a rendition exits on its own its readers are restarted and wait for it;
  each gets an Error History record naming the cause. After 15 s with no running
  reader it stops, so a quick stop/start does not restart the shared encode.

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
