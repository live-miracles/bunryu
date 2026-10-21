# Comparison with alternatives

How Bunryu differs from the tools people usually consider for the same job. It is
written for choosing a tool, not for ranking them: each has a case where it is the
better pick. Facts about other projects come from their own READMEs and
documentation, checked in October 2026 against Bunryu 3.0, Restreamer 2.12, SRS 6.0
and MediaMTX 1.21; check their sites for what they offer today.

## Design approach

Bunryu has no media code of its own. SRS accepts RTMP and SRT, libsrt carries SRT
(inside SRS and in [Goryu](https://github.com/live-miracles/goryu)), and FFmpeg does
everything to the stream after that: the outputs, previews, probing and audio
processing. What Bunryu adds is a control plane of about 11,000 lines of TypeScript
(38 files, four runtime dependencies) and Goryu, about 2,000 lines of C over libsrt.

This is deliberate. Timestamps, codec quirks and damaged input are where media
software fails, and FFmpeg and libsrt have long production use on exactly that. In
our tests FFmpeg stayed connected through 10% packet loss where a newer converter
dropped its readers ([details](../4-reference/3-design-decisions.md#dont-use-mediamtx-for-srt-ingest-or-srtrtmp-conversion)).
A small codebase is also easier to read, test and reason about when something fails
in the middle of an event.

The cost is efficiency. A copy output is a whole FFmpeg process of about 65 to 90 MB
of RAM, where a purpose-built forwarding hub used about 10x less RAM, though about
1.5x more CPU ([details](../4-reference/3-design-decisions.md#one-ffmpeg-process-per-output)).
That is acceptable inside the supported [capacity](1-introduction.md#capacity-and-limits),
and we chose it over writing our own.

## At a glance

|                             | Bunryu                                                 | datarhei Restreamer                                         | SRS alone                                  | MediaMTX                                               |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| What it is                  | Restreaming server for long live events, with one dashboard for up to 50 inputs and 500 outputs                | Restreaming app with a wizard UI, built on datarhei Core    | Media server (ingest and delivery)         | Media server and router for many protocols             |
| Forward to many destinations | RTMP, RTMPS and SRT, one FFmpeg process per output     | RTMP, SRT and other protocols through its UI                | `forward` entries in its config file       | The `forward` feature, set per path in its config file |
| Dashboard and API           | Dashboard and REST API                                 | Web UI and Swagger-documented REST API                      | HTTP API and config files                  | Control API and config file                            |
| Bonded SRT ingest           | Yes, through [Goryu](https://github.com/live-miracles/goryu) | Not documented                                        | No ([ossrs/srs#4771](https://github.com/ossrs/srs/issues/4771)) | Not found in its docs or code                          |
| Recovery                    | Per-output watchdogs, bounded retries, Error History   | Core documents error detection and recovery for its processes | Not compared                         | Not compared                                       |
| Translation audio mixing    | Yes (beta): ducking, delay and restore                 | Can mux a separate audio channel                            | No                                         | No                                                     |
| Viewer-facing playback      | Dashboard preview only                                 | Built-in player and publication page                        | HLS, WebRTC and more                       | WebRTC, HLS, RTSP and more                             |
| Where it runs               | Linux x86_64 (ARM only emulated, for development)      | Docker on AMD64, ARMv7 and ARM64                            | Linux and macOS on many CPU types          | Linux, Windows and macOS, one binary                   |
| License                     | MIT                                                    | Apache-2.0                                                  | MIT                                        | MIT                                                    |

## datarhei Restreamer

**Core trade-off:** friendlier and broader, versus built for a narrower job.

- Pick Restreamer if you want a setup wizard, a built-in player or public page for
  viewers, hardware encoding (Raspberry Pi, NVIDIA, Intel), or to run on ARM.
- Pick Bunryu for a Linux server that forwards many pipelines to many destinations
  through long events, where per-output recovery, an Error History with FFmpeg's
  last output, bonded SRT ingest or translation mixing matter.

Both are FFmpeg based. We have not compared how they behave when a destination
fails, so we make no claim about it.

## SRS

**Core trade-off:** SRS is Bunryu's ingest, and its own forwarding is static.

Bunryu runs on official SRS for RTMP and SRT ingest. For outputs it does not use
SRS's `forward`: in 6.0 a destination cannot be added or removed on a live stream
without disconnecting the publisher, and a forward runs inside the SRS process, so a
fault there can affect every stream. See
[the design decision](../4-reference/3-design-decisions.md#dont-use-srss-built-in-forwarding-for-outputs).

Use SRS alone for a media server with a fixed configuration, or when you need
WebRTC, HLS or its other delivery protocols. Bunryu adds the management layer around
it for restreaming.

## MediaMTX

**Core trade-off:** a flexible protocol router, versus FFmpeg's maturity on damaged
input.

- We tested MediaMTX in two roles and kept FFmpeg in both. As an SRT-to-RTMP
  converter it closed RTMP readers under 5-10% packet loss where FFmpeg stayed
  connected ([details](../4-reference/3-design-decisions.md#dont-use-mediamtx-for-srt-ingest-or-srtrtmp-conversion)).
  As a forwarding hub for copy outputs it used about 10x less RAM but about 1.5x
  more CPU than FFmpeg, and FFmpeg would still be needed for transcodes, SRT
  destinations and translation mixes
  ([details](../4-reference/3-design-decisions.md#one-ffmpeg-process-per-output)).
- Pick MediaMTX for protocol conversion, WebRTC or RTSP, recording, running on
  Windows or macOS, or a single small binary. It is not a restreaming manager, so
  you set up and watch each forward yourself.

## Hosted multistreaming services

A hosted service means no server to run. Bunryu is for teams that want to run the
server themselves: on their own infrastructure, with their own destinations and
logs, with capacity set by their own hardware. It does not remove the
work of operating a server; see [sizing](4-sizing.md) and
[reliability](../3-operations/4-reliability.md).

## When not to use Bunryu

- You need a native ARM or Apple Silicon deployment, or a Windows or macOS host.
  Bunryu installs on Debian or Ubuntu x86_64 and the [Docker image](2-docker.md) is
  x86_64 only.
- You need hardware encoding. Bunryu's video encodings are CPU profiles, and most
  outputs are meant to copy the stream.
- You want a public page or embeddable player for viewers. Bunryu forwards streams
  to destinations; it does not serve viewers.
- You need WebRTC, RTSP or HLS delivery, or protocol conversion as a service.
- You need more than the supported
  [capacity](1-introduction.md#capacity-and-limits): 50 inputs and 500 outputs.
