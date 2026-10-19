# Sizing a server

How much CPU and RAM a Bunryu server needs, from costs measured on a GCP `n2`
VM. Use it to pick a machine size before you install
([Native install](3-install.md)); the supported ceilings are in
[Capacity and limits](1-introduction.md#capacity-and-limits).

CPU figures are in **vCPUs**: 1.0 means one vCPU fully busy. A GCP vCPU is one
hyperthread, so a 4-vCPU `n2` is 4 threads on 2 physical cores.

The costs come from two sources: a benchmark on loopback (repeatable, but with no
real network) and observations on the production server (real destinations, a 4K and
a 1080p SRT input, and a live event with 22 outputs). The benchmark gives the cost of
the processing, the observations add the cost of sending.

## Per-item costs

### Benchmark (loopback)

Measured on an `n2` (Intel Xeon 2.8 GHz), FFmpeg 7.1.4, 1080p30 H.264 input at about
6 Mbps with AAC audio. In these runs every output kept real-time speed (≥ 0.99x);
[Where it breaks](#where-it-breaks) covers several encodes at once. The production
feeds are 50 fps, which costs more wherever the video is decoded: see
[Video encodes](#video-encodes).

| Item | RTMP input | SRT input | RAM (RTMP / SRT input) |
|---|---:|---:|---:|
| 100 copy outputs (video and audio copied) | 0.6 vCPU | 3.1 vCPU | 3.1 GB / 4.4 GB |
| 100 outputs with an audio re-encode (a track selected, e.g. `T1`), instead of copy | 3.8 vCPU | 7.2 vCPU | 3.3 GB / 4.6 GB |

- The 100-output rows are extrapolated from runs at 30 outputs (copy) and 10 (audio
  re-encode). The cost per output stayed flat from 1 to 30 outputs.
- An SRT input costs about four times as much per copy output as an RTMP input:
  most likely the MPEG-TS demux in FFmpeg plus SRS sending SRT to each reader (the
  split was not profiled). The SRT row includes 0.9 vCPU in SRS.
- Outputs of one pipeline that need the same encode share it
  ([Shared encodes](../2-usage/2-outputs.md#shared-encodes)), so the encode and
  audio re-encode costs apply once per distinct encode, plus about 0.004 per
  output reading from it. Count an audio re-encode per output only for outputs
  with a unique recipe. Production did not have shared encodes yet at the time of
  these observations.

### Video encodes

Each profile has one usual input: `720p` down-converts a 1080p input, `1080p`
down-converts a 4K input and `vertical_rotate` is applied to a 1080p input. Both
production feeds are 50 fps, and the cost of anything that decodes the video grows
with the frame rate; the benchmark sources are 30 fps.

| Encode, with its usual input | On a production feed (50 fps) | Benchmark (30 fps) | RAM |
|---|---:|---:|---:|
| `720p` from a 1080p input | 2.05 vCPU | 1.1–1.7 vCPU | 270–280 MB |
| `vertical_rotate` from a 1080p input | 1.19 vCPU | 0.6–0.8 vCPU | 175 MB |
| `1080p` from a 4K input | does not keep up on 4 vCPUs; about 5 vCPU estimated | not measured | 814 MB |

- The production figures are one encode of the live 1080p50 feed, sent to YouTube for
  60–90 s at 1.0x speed. The benchmark range runs from clean to noisy synthetic
  content; use the production figure.
- `1080p` from the 4K50 feed ran at 0.53–0.58x real time (23 fps) on the 4-vCPU `n2`,
  and after about 20 s the SRT pull broke (`Packet corrupt`, `Input/output error`)
  because FFmpeg read too slowly. Decoding alone kept up (1.1x) at 1.83 vCPU. The
  5 vCPU estimate is the roughly 3 vCPUs that were free divided by 0.55x; it was not
  measured on a larger machine.
- The 814 MB was measured on a development machine with a synthetic 4K input.
- A `1080p` profile on a 1080p input, which is not an intended use, measured 1.5–2.5
  vCPU and 430 MB at 30 fps.

### Sending costs extra (observed in production)

Loopback sends nothing over a network. On production, every output cost more than the
benchmark, in proportion to the bitrate it sends:

| Output (observed) | Input | Output bitrate | vCPU per output | RAM per output | Samples |
|---|---|---:|---:|---:|---:|
| Copy, RTMP destination | RTMP | 7–10 Mbps | 0.039 | 34 MB | 1936 |
| Copy, RTMPS destination | RTMP | 7–10 Mbps | 0.036 | 34 MB | 167 |
| Audio re-encode | SRT | under 4 Mbps | 0.077 | 47 MB | 6393 |
| Audio re-encode | SRT | 7–10 Mbps | 0.072 | 60 MB | 516 |
| Audio re-encode | SRT, 4K feed | about 20 Mbps | 0.167 | 61 MB | 31 |
| Audio re-encode, YouTube primary and backup (dry run) | SRT, 4K feed | 20 Mbps | 0.181 / 0.185 | 56 MB (129 MB at start) | 2 × 4 min |

A sample is one per-minute health snapshot of one output. A copy output on an RTMP input cost 0.039 against 0.005 in the
benchmark. TLS is not the cause, since RTMPS and RTMP cost the same. The extra is the
sending itself, about **0.004 vCPU per Mbps sent**, and adding it to the benchmark
figures reproduces the table to within about 0.04 vCPU. At 8 Mbps per output that is
0.032 vCPU, or 3.2 vCPU per 100 outputs.

### Fixed and ingest costs (observed in production)

- The Node process used about 1% of a vCPU and 140–220 MB, SRS 44–85 MB and the
  relay 12–25 MB.
- A 4K feed (19.9 Mbps) and a 1080p feed (9.1 Mbps) over SRT, 29 Mbps in total,
  cost SRS 0.10 vCPU and the relay 0.20: about **0.01 vCPU per Mbps of ingest**.
- A live event on 2026-10-18 had one RTMP and one SRT input (17 Mbps in total) and
  21 outputs on average (22 at most), a mix of copy and audio re-encode. All
  processes together averaged **1.07 vCPU and peaked at 2.40**, and the host used
  1.15 GB of RAM on average and 1.28 GB at the peak. The peak was more than twice the
  average, so keep headroom.

## Estimating

1. Add up:
   - the base: **0.1** + **0.01** × the ingest bitrate in Mbps of all inputs;
   - each video encode, if any (see [Video encodes](#video-encodes));
   - each output: **0.01** (copy, RTMP input), **0.03** (copy, SRT input), **0.04**
     (audio re-encode, RTMP input) or **0.07** (audio re-encode, SRT input), plus
     **0.004** × the bitrate in Mbps it sends. An audio re-encode figure replaces the
     copy figure for that output; it does not add to it.
2. Divide by **0.7**. Live events must not run the host flat out, and an encode that
   cannot keep up falls behind real time rather than failing.
3. Round up to a whole number of vCPUs. A GCP `n2` starts at 2.

For RAM, add 0.4 GB for the services, the RAM of each encode and about 35 MB per copy
output or 50–60 MB per output with an audio re-encode.

The examples assume one 8 Mbps input and every output sending 8 Mbps. Video
encodings (`720p`, `1080p`, `vertical_rotate`) are rarely used, so they are left out:

| Workload | vCPUs | RAM |
|---|---:|---:|
| 20 copy outputs, RTMP input | 2 | 1.5 GB |
| 100 copy outputs, RTMP input | 7 | 4 GB |
| 100 copy outputs, SRT input | 10 | 5 GB |
| 20 outputs with an audio re-encode, RTMP input | 3 | 1.5 GB |
| 20 outputs with an audio re-encode, SRT input | 4 | 1.5 GB |
| 100 outputs with an audio re-encode, SRT input | 15 | 6 GB |

The estimate is deliberately conservative: it keeps the host under about 70% busy.
The audio re-encode rows are the worst case, where every output has its own encode.
Outputs of one pipeline with the same audio track selection share one, which should
bring each close to a copy output plus one encode (an estimate: not measured, and
not yet deployed on production).

Bandwidth is a limit of its own: 100 outputs at 8 Mbps send 800 Mbps. The 500-output
ceiling at the same bitrate needs about 30 vCPUs, 4 Gbps of egress and 17–30 GB of
RAM, so check the egress cap of the machine type as well as its vCPU count.

## Where it breaks

A single `1080p` encode of a 4K50 input is already more than 4 vCPUs can do, as
described under [Video encodes](#video-encodes). On the 4-vCPU `n2`, running several
video encodes at once also saturated the host and every encode fell behind real time:

| Concurrent encodes (noisy 1080p30 input) | Host CPU | Slowest encode |
|---|---:|---:|
| Four `720p` | 100% | 0.52x |
| Three `1080p` | 100% | 0.48x |
| Four `1080p` | 100% | 0.36x |

An encode below 1.0x delivers its destination a stalling, lagging stream. Keep the
number of distinct encodes within the estimate above, and keep everything else `copy`.

## Limits of these numbers

- **One machine family.** Only `n2` was measured. Newer families (`c3`, `n4`) have
  faster cores and should need fewer vCPUs; that is not measured here. Do not use
  shared-core types (`e2-micro`, `e2-small`, `e2-medium`) for live work: their CPU is
  burstable and throttles under a sustained encode.
- **The sending term is fitted, not modelled.** It comes from a few output types at
  7–10 Mbps, plus an audio re-encode at 3 Mbps and one at 20 Mbps (31 samples). Copy outputs on an SRT input
  and an audio re-encode on an RTMP input have no clean production observation:
  their rows add the term to the benchmark. The video encodes were measured on the
  production feeds (`720p`, `vertical_rotate`) and on loopback; `1080p` from 4K could
  not be measured at full speed on the `n2`.
- **4K.** The production 4K feed (20 Mbps) was observed with an audio re-encode
  output only: 0.17–0.18 vCPU and 56–61 MB per output, and SRS spent about 0.03 vCPU
  per 20 Mbps reader. Decoding the 4K50 feed alone took 1.83 vCPU and 265 MB. The 4K
  encodes' memory was measured on a development machine with a 30 fps synthetic input:
  `vertical_rotate` 472 MB, `720p` 608 MB, `1080p` 814 MB. The memory watchdog allows twice the RAM for a 4K input; see
  [Reliability](../3-operations/4-reliability.md).
- **Not measured:** previews and translation mixers.

Why this is a table and not a calculator in the dashboard:
[Design decisions](../4-reference/3-design-decisions.md#sizing-guidance-is-a-measured-table-not-a-calculator).
