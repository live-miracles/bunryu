# Sizing a server

How much CPU and RAM a Bunryu server needs, from costs measured on a 4-vCPU GCP `n2`
(Xeon 2.8 GHz, FFmpeg 7.1.4). Use it to choose a machine before you install
([Native install](3-install.md)); the supported ceilings are in
[Capacity and limits](1-introduction.md#capacity-and-limits).

CPU is in **vCPUs**: 1.0 is one vCPU fully busy, and a GCP vCPU is one hyperthread. The
costs come from a loopback benchmark (processing only, 1080p30 input at 6 Mbps) and from
production (real destinations, 4K50 and 1080p50 SRT feeds, an event with 22 outputs).

## Costs

### Outputs

| 100 outputs | RTMP input | SRT input | RAM (RTMP / SRT input) |
|---|---:|---:|---:|
| Copy (video and audio copied) | 0.6 vCPU | 3.1 vCPU | 3.1 / 4.4 GB |
| Audio re-encode (a track selected, e.g. `T1`), instead of copy | 3.8 vCPU | 7.2 vCPU | 3.3 / 4.6 GB |

These are processing costs, extrapolated from runs at 30 and 10 outputs (the cost per
output stayed flat). An SRT input costs about four times as much per copy output, 0.9
vCPU of it in SRS. **Sending adds about 0.004 vCPU per Mbps sent**, per output: on
production a copy output cost 0.039 vCPU against 0.005 on loopback, and RTMPS cost the
same as RTMP. At 8 Mbps that is 3.2 vCPU per 100 outputs.

Outputs of one pipeline with the same encode
([Shared encodes](../2-usage/2-outputs.md#shared-encodes)) pay for it once, plus about
0.004 vCPU each for reading it. Count the audio re-encode per output only for outputs
with their own recipe; production did not have shared encodes yet.

### Video encodes

`720p` down-converts a 1080p input, `1080p` a 4K input, and `vertical_rotate` is applied
to a 1080p input. Both production feeds are 50 fps.

| Encode, with its usual input | vCPU | RAM |
|---|---:|---:|
| `720p` from 1080p50 | 2.05 | 270–280 MB |
| `vertical_rotate` from 1080p50 | 1.19 | 175 MB |
| `1080p` from 4K50 | 5.94 on 8 vCPUs; does not keep up on 4 | 930–940 MB |

- The first two are one encode of the live feed, sent to YouTube for 60–90 s at 1.0x
  speed. At 30 fps the benchmark gave 1.1–1.7 and 0.6–0.8, so the cost grows with the
  frame rate.
- `1080p` from the 24 Mbps 4K50 feed ran at 1.0x on an 8-vCPU `n2`, which leaves that
  host about 90% busy, so plan on 10 or more vCPUs. On 4 vCPUs it ran at 0.53–0.58x and
  after about 20 s the SRT pull broke (`Packet corrupt`, `Input/output error`) because
  FFmpeg read too slowly. Decoding the 4K50 feed alone takes 1.83 vCPU.

### Fixed and ingest

- The Node process uses about 1% of a vCPU and 140–220 MB, SRS 44–85 MB and the relay
  12–25 MB.
- Ingest costs about **0.01 vCPU per Mbps**: a 4K (19.9 Mbps) and a 1080p (9.1 Mbps)
  SRT feed cost SRS 0.10 and the relay 0.20.
- A live event (one RTMP and one SRT input, 17 Mbps in; 21 outputs on average, copy
  and audio re-encode) used **1.07 vCPU on average and 2.40 at the peak**, and 1.15 GB
  of RAM (1.28 GB at the peak). The peak was more than twice the average.

## Estimating

1. Add up:
   - the base: **0.1** + **0.01** × the ingest Mbps of all inputs;
   - each video encode, if any (table above);
   - each output: **0.01** (copy, RTMP input), **0.03** (copy, SRT input), **0.04**
     (audio re-encode, RTMP input) or **0.07** (audio re-encode, SRT input), plus
     **0.004** × the Mbps it sends. The audio figure replaces the copy figure.
2. Divide by **0.7**: a live event must not run the host flat out, and an encode that
   cannot keep up falls behind real time.
3. Round up to a whole number of vCPUs (a GCP `n2` starts at 2).

For RAM, add 0.4 GB for the services, the RAM of each encode and about 35 MB per copy
output or 50–60 MB per output with an audio re-encode.

Examples, with one 8 Mbps input and every output sending 8 Mbps (video encodings are
rarely used, so they are left out):

| Workload | vCPUs | RAM |
|---|---:|---:|
| 20 copy outputs, RTMP input | 2 | 1.5 GB |
| 100 copy outputs, RTMP input | 7 | 4 GB |
| 100 copy outputs, SRT input | 10 | 5 GB |
| 20 outputs with an audio re-encode, RTMP input | 3 | 1.5 GB |
| 20 outputs with an audio re-encode, SRT input | 4 | 1.5 GB |
| 100 outputs with an audio re-encode, SRT input | 15 | 6 GB |

The audio rows are the worst case, where every output has its own encode; with shared
encodes each should come close to a copy output plus one encode (an estimate, not
measured). Bandwidth is a limit of its own: 100 outputs at 8 Mbps send 800 Mbps, and the
500-output ceiling at that bitrate needs about 30 vCPUs, 4 Gbps of egress and 17–30 GB
of RAM, so check the egress cap of the machine type too.

## The dashboard at the supported ceiling

Measured on the isolated test stack ([Development](../4-reference/2-development.md)) on
an 8-core laptop shared with other work: 50 pipelines, each with a live 720p RTMP input
(a looped clip, stream copy) and 10 copy outputs, so 500 outputs, all running. The
outputs are a stand-in for FFmpeg that reports progress and sends nothing, so FFmpeg's
own CPU and RAM are not here (see [Outputs](#outputs)). These numbers are the cost of
the control plane and the dashboard.

| Measure | Result |
|---|---|
| Control plane with one dashboard open | about 17% of one core, 251 MB RSS |
| `/api/health`, fetched every 5 s by each dashboard | 296 KB, 18 KB gzipped, about 30 ms to produce |
| `/api/config` | 149 KB, 11 KB gzipped |
| Dashboard first render (headless Chrome, same machine) | 0.7-0.8 s (one run of four took 1.3 s), about 9,100 DOM nodes |
| Overview page length | about 28,000 px (about 32 screens): 50 input rows, then 500 output rows |
| Status view (50 pipelines, 501 outputs) | one screen at 1920×1080, 935 DOM nodes; a poll that finds nothing new takes about 16 ms (worst of 20: 27 ms), a full rebuild about 36 ms (worst 56 ms) |

What the dashboard shows at that size:

- The header totals (48 of 50 inputs live, 480 of 500 outputs healthy, 20 flagged) and
  the sidebar's pipeline groups and status dots show a problem without scrolling. With
  two inputs taken offline, those two pipelines turned yellow in their groups.
- The **Issues** tab narrows the output list to the affected outputs, each with its
  reason ("Output is running but input is not live").
- A pipeline's own view shows its 10 outputs on one screen.

Each table has a search box for names; the page itself is long, see [Known issues](../3-operations/5-known-issues.md#the-overview-is-one-long-page).

## Limits of these numbers

- **One machine family.** Only `n2` was measured; newer families (`c3`, `n4`) should
  need fewer vCPUs. Do not use shared-core types (`e2-micro`, `e2-small`, `e2-medium`)
  for live work: their CPU is burstable and throttles under a sustained encode.
- **The sending term is fitted** from a few output types at 7–10 Mbps plus one at 3
  and one at 20 Mbps. Copy outputs on an SRT input and audio re-encodes on an RTMP input
  have no clean production observation, so their figures add the term to the benchmark.
- **4K:** an audio re-encode output measured 0.17–0.18 vCPU and 56–61 MB, and SRS spent
  about 0.03 vCPU per 20 Mbps reader. The memory watchdog allows twice the RAM for a 4K
  input ([Reliability](../3-operations/4-reliability.md)).
- **Not measured:** previews.

Why this is a table and not a calculator in the dashboard:
[Design decisions](../4-reference/3-design-decisions.md#sizing-guidance-is-a-measured-table-not-a-calculator).
