# Sizing a server

How much CPU and RAM a Bunryu server needs, from costs measured on a GCP `n2`
VM. Use it to pick a machine size before you install
([Native install](3-install.md)); the supported ceilings are in
[Capacity and limits](1-introduction.md#capacity-and-limits).

CPU figures are in **vCPUs**: 1.0 means one vCPU fully busy. A GCP vCPU is one
hyperthread, so a 4-vCPU `n2` is 4 threads on 2 physical cores.

## Per-item costs

Measured on an `n2` (Intel Xeon 2.8 GHz), FFmpeg 7.1.4, 1080p30 H.264 input at
about 6 Mbps with AAC audio. In these runs every output kept real-time speed
(≥ 0.99x); [Where it breaks](#where-it-breaks) covers several encodes at once.

| Item | RTMP input | SRT input | RAM (RSS) |
|---|---:|---:|---:|
| Copy output (video and audio copied) | 0.005 | 0.02, plus 0.01 in SRS | 31 MB / 44 MB |
| Audio re-encode on an output (a track is selected, e.g. `T1`), added to the above | +0.03 | +0.04 | +2 MB |
| `720p` encode | 1.1–1.7 | 1.1–1.7 | 260 MB |
| `1080p` encode | 1.5–2.5 | 1.5–2.5 | 430 MB |
| `vertical_rotate` encode | 0.6–0.8 | 0.6–0.8 | 155 MB |

- An SRT input costs about four times as much per copy output as an RTMP input:
  most likely the MPEG-TS demux in FFmpeg plus SRS sending SRT to each reader (the
  split was not profiled). Thirty copy outputs measured 0.16 vCPU on RTMP and 0.93 on SRT (FFmpeg plus SRS).
- The range for an encode is clean content (low) to noisy, high-motion content
  (high). Plan on the high end: live content with camera motion, graphics or crowds
  can be closer to it than to a test pattern. A `720p` encode from a 720p input
  measured 1.3.
- Outputs of one pipeline that need the same encode share it
  ([Shared encodes](../2-usage/2-outputs.md#shared-encodes)), so the encode and
  audio re-encode costs apply once per distinct encode, plus about 0.004 per
  output reading from it. Count an audio re-encode per output only for outputs
  with a unique recipe.
- Fixed costs seen on production: the Node process 140–220 MB, SRS 25–80 MB, the
  relay about 10 MB. SRS and the relay together used 0.1–0.6 vCPU for one busy
  pipeline with a bonded SRT input and 1–28 outputs. Ingest was not benchmarked on
  its own, so treat 0.5 vCPU as the base load.

## Estimating

1. Add up: **0.5** (base) + the encodes (use the high figure) + copy outputs ×
   **0.01** (RTMP input) or **0.03** (SRT input) + unshared audio re-encodes ×
   **0.04** (RTMP) or **0.07** (SRT).
2. Divide by **0.7**. Live events must not run the host flat out, and an encode that
   cannot keep up falls behind real time rather than failing.
3. Round up to the next machine size.

For RAM, add 0.4 GB for the services, the RAM of each encode and about 30–45 MB per
output. Most workloads are CPU-bound, so `n2-highcpu` (1 GB per vCPU) is usually the
cheapest fit; use `n2-standard` or `n2-highmem` only when the RAM total exceeds the
vCPU count in GB. The 500-output ceiling needs roughly 16–22 GB of RAM.

| Workload | vCPUs | RAM | Shape |
|---|---:|---:|---|
| 20 copy outputs, RTMP input | 2 | 1 GB | `n2-highcpu-2` |
| 100 copy outputs, RTMP input | 4 | 3.5 GB | `n2-highcpu-4` |
| 100 copy outputs, SRT input | 8 | 5 GB | `n2-highcpu-8` |
| One `720p` encode and 30 copy outputs, SRT input | 8 | 2 GB | `n2-highcpu-8` |
| One `1080p` encode and 30 copy outputs, SRT input | 8 | 2.5 GB | `n2-highcpu-8` |
| Two `1080p` encodes and 30 copy outputs, SRT input | 16 | 3 GB | `n2-highcpu-16` |

The estimate is deliberately conservative. On a 4-vCPU `n2`, one `1080p` encode alone
took 65% of the host and one `720p` encode 40–45%.

## Where it breaks

On the 4-vCPU `n2`, running several encodes at once saturated the host and every
encode fell behind real time:

| Concurrent encodes (noisy 1080p input) | Host CPU | Slowest encode |
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
- **Synthetic input, loopback network.** The input was a generated test stream and
  every pull and push ran over loopback. Real destinations add TLS (RTMPS) and WAN
  sending, which this does not measure. On production, outputs with an audio track
  selected measured 5–8% each, which fits the audio re-encode plus this overhead,
  before shared encodes were deployed there.
- **1080p30 input only.** 4K input and higher frame rates cost more, and the memory
  watchdog allows twice the RAM for them.
- **Not measured:** previews, translation mixers, several inputs at once, and
  network bandwidth. Bandwidth is a separate limit: add up the bitrate of every
  output and check it against the egress cap of the machine type.

Why this is a table and not a calculator in the dashboard:
[Design decisions](../4-reference/3-design-decisions.md#sizing-guidance-is-a-measured-table-not-a-calculator).
