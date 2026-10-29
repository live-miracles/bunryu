---
name: benchmark-sizing
description: Re-measure the CPU and RAM cost of Bunryu outputs (copy, audio re-encode, 720p/1080p/vertical encodes, concurrent encodes) for RTMP or SRT inputs, to refresh docs/1-getting-started/4-sizing.md. Use when FFmpeg, x264 or an encoding profile changes, when sizing a new machine family, or when the sizing numbers look wrong. Runs a private loopback SRS pair; never touches the Bunryu services.
---

# Benchmark sizing

`sizing-benchmark.py` (next to this file) produced the numbers in
`docs/1-getting-started/4-sizing.md`. It runs a private pair of SRS servers on
loopback ports 29350 to 29352 under `--workdir`, feeds one a generated 1080p30
stream and measures FFmpeg commands built like `buildFfmpegArgs()` in
`src/utils/ffmpeg.ts`. It does not use the Bunryu app, database or services.

## Before you run it

- **Prefer a throwaway VM of the same shape** (for example a fresh `n2-highcpu-4`)
  with FFmpeg and SRS installed as in `scripts/server-install.sh`. A benchmark that
  saturates the host (the concurrent-encode cases do) must never run on a server
  that may carry a live stream. Use `--no-guard` there.
- **Production only as a last resort, and only after the user says nothing is
  live.** Unlike `investigate-prod`, this skill writes files and starts CPU-heavy
  processes on the VM. Keep the guard on (the default): it aborts and kills
  everything if a production `ffmpeg` is running or the SRS API on
  `127.0.0.1:1985` shows a live publisher or cannot be read. The benchmark
  processes run at `nice 19`.
- **Check the script still matches the app.** Compare `V` (the encoding profiles)
  and `out_cmd()` with `ENCODINGS` and `buildFfmpegArgs()` in `src/utils/ffmpeg.ts`,
  and the SRT URL with `srtPullUrl()` in `src/utils/srs.ts`. The script does not
  import them, so it drifts silently.
- Needs Linux, Python 3, `nice`, `pgrep`, FFmpeg with libx264, and the real SRS
  binary (`--ffmpeg` and `--srs` if not on `PATH`). On a dev machine `srs` on
  `PATH` may be a service wrapper that only prints usage; pass `--srs objs/srs`
  from a repo build instead. If SRS exits at startup the script prints the tail of
  its log.

## Run

```bash
python3 -I sizing-benchmark.py --list                          # case ids
python3 -I sizing-benchmark.py --origin rtmp --no-guard        # all cases, ~17 min
python3 -I sizing-benchmark.py --origin srt --no-guard --cases p720_x1@hard1080
```

Run both origins: an SRT input makes copy outputs about four times costlier. Add
`--fps 50` to match the production feeds: anything that decodes the video costs about
`fps / 30` times the 30 fps default, and the encodes are meant for 1080p and 4K input
(`720p` from 1080p, `1080p` from 4K, `vertical_rotate` from 1080p), so measure those
combinations. Check that `min_speed` stays near 1.0 and that the run does not end
early with `alive` below the output count; a 4K to 1080p encode can fail to keep up
and then breaks the SRT pull. Each
case runs `--warm` seconds (default 15) then measures `--run` seconds (default 45),
and prints a `RESULT {json}` line:

| Field | Meaning |
|---|---|
| `cpu_per_proc_cores`, `cpu_total_cores` | vCPUs used per output FFmpeg and by all of them (1.0 is one vCPU fully busy) |
| `rss_mb_avg`, `hwm_mb_max` | output FFmpeg memory, average and peak |
| `hub_srs_cores`, `sink_srs_cores` | the SRS the outputs pull from and the one they push to |
| `host_util_pct` | whole-host CPU during the window |
| `min_speed` | slowest output's FFmpeg speed; below about 0.97 it fell behind real time |
| `udp_rcvbuf_errors`, `hub_srt_drops` | UDP datagrams the kernel dropped during the window, host-wide and on the hub's SRT socket; `null` if `/proc/net/snmp` was unreadable |

A `min_speed` of `null` means no progress data arrived: discard that case. A nonzero
`udp_rcvbuf_errors` or `hub_srt_drops` means the host lost datagrams during the window,
so a low `min_speed` or a lost output in that case may be the host, not the output: rerun
it on a quiet host (the host-wide counter also counts other processes' sockets). The run
ends with `DONE`, or `ABORTED <reason>` if the guard fired.

## On a remote VM

- Upload the script with its own command, check the byte count on the VM, then
  start it detached in a second command with
  `(nohup python3 -I sizing-benchmark.py ... > run.log 2>&1 < /dev/null &)`.
  Chaining `cat > file && ... &` backgrounds the whole chain, including the
  upload, and leaves an empty file.
- Watch for `DONE` in the log. `pgrep -f sizing-benchmark` over SSH matches its own
  command line, so it always looks running.
- Remove the workdir afterwards (about 260 MB of generated sources).

## Production observations

The benchmark has no real network, so it misses the cost of sending (about 0.004
vCPU per Mbps sent, measured on production). `observe-prod.py` recomputes that from
the server's own per-minute `health-snapshot` events and the outputs table:

```bash
gcloud compute ssh <vm> --tunnel-through-iap --command 'sudo python3 -I - 2026-10-18' < observe-prod.py
```

It is read-only (the database is opened with `mode=ro`) and prints aggregates only:
vCPU, RAM and bitrate per output class, and the totals for busy snapshots. Pass the
diagnostics file dates (the host's local date) for an event or a quiet day. Compare
the vCPU-per-output rows with the per-item costs in the sizing page to check the
sending term, and use the busy-snapshot rows to sanity-check an estimate.

## After measuring

Update `docs/1-getting-started/4-sizing.md` (tables, example sizes, and the formula
if the costs moved) and the Evidence block in the "Sizing" section of
`docs/4-reference/3-design-decisions.md`, with the date, machine type and FFmpeg
version. Do not commit raw logs with hostnames or zone names.

## Not measured

Previews, several inputs at once, ingest cost on its own,
4K or 60 fps input, real destinations (RTMPS and WAN), and machine families other
than `n2`.
