# Incident: A shared encode stayed up but its outputs could not read it, so they were blamed on YouTube

- **Date:** 2026-10-25 (times below are IST, UTC+05:30; the diagnostics file uses UTC)
- **Component:** shared encode (rendition) and the outputs reading it, SRS internal stream, output watchdog messages
- **Trigger:** Pipeline 12's shared encode started with the pipeline's input and from then on delivered nothing to the outputs that read it. Why is not established (see Unknowns).
- **Impact:** Both YouTube outputs configured on pipeline 12 ("EU Arabic Step7"), with two different stream keys, produced no stream for about 25 minutes (09:42 to 10:08). The pipeline's input stayed live. Pipelines 10, 11 and 13, started within the same 15 seconds with the same settings, and a new pipeline 14 created during the incident were not affected. Whether a live program was affected, and what YouTube showed, was not recorded.

## Summary

Every attempt of the YouTube output ended with the watchdog message `RTMP socket missing (destination port 1935 not established)`, which points at YouTube. YouTube was never contacted. The output's ffmpeg held one connection, to the local SRS (`127.0.0.1:21935`), and never got far enough to open its destination. The shared encode it reads was running and writing at its normal bitrate the whole time.

Stopping all outputs of the pipeline let the shared encode idle-stop after 15 seconds. The next start of the shared encode worked, and a third stream key then ran for 69 minutes with no failure.

The version running on the VM was `4828224`. The VM lagged `master` by one commit, which changed only dashboard and docs files (SRT details and alert sound controls), not the output watchdog or the SRS hooks.

## Timeline

| Time (IST) | Event |
|---|---|
| 09:42:07 - 09:42:11 | Inputs of pipelines 10, 12, 11 and 13 are allowed and go live over SRT from the same encoder address (`<redacted-ip>`). |
| 09:42:11 | Shared encode `12-3` (pid 154881, run `12-3#10`) starts. It logs the usual start-up burst (`non-existing PPS 0 referenced`, `decode_slice_header error`, 54 lines in 1 s), like the shared encodes of pipelines 10, 11 and 13. |
| 09:42:17 | SRS accepts the shared encode's publish of `internal/r12_copy_a0` (hook `allowed shared-encode publish`). |
| 09:42:20 | Output `12-1` (YT) starts reading it. |
| 09:43:06 | First watchdog kill of `12-1`: socket warning began 30 s earlier, process had run 45 s. Same again about every 50 s. |
| 09:59:59 | A second output `12-4` ("new yt", another key) is started on the same shared encode. It fails the same way. |
| 10:03:41, 10:04:41 | The kills quoted in the report (pids 156268 and 156770), each with `socket_snapshot: ESTAB peer=127.0.0.1:21935` and an empty ffmpeg stderr tail. |
| 10:05:05 - 10:06:40 | A new pipeline 14 ("new EU arabic") goes live; its shared encode is created at 10:06:34 and published at 10:06:40. It works. |
| 10:05:30 | `12-1` stopped after 19 failed attempts. |
| 10:06:40 | `12-4` stopped after 7 failed attempts. |
| 10:06:56 - 10:06:59 | With no output left running, `12-3` idle-stops after 15 s; its process had run 24 min 48 s. |
| 10:08:09 | `12-3` starts again (run `12-3#12`); 10 s later a third output, `12-5` ("livestream yt", a third key), starts on it. It runs until 11:17:27 (69 min) with no failure or restart event. |

## Evidence

All from `/var/lib/bunryu/diagnostics/diagnostics-2026-10-25.jsonl` (query by `outputId` 12-1, 12-3, 12-4, 12-5) and the `bunryu` and `srs` journals, read on the VM.

- Every watchdog-killed `ffmpeg-exited` of `12-1` and `12-4` (`watchdog: true`) has the same stderr tail: `Error opening input: Input/output error` / `Error opening input file rtmp://127.0.0.1:21935/internal/r12_copy_a0`. No line mentions the destination.
- The last attempt of `12-4` was stopped by hand 13.5 s after it started (`status: stopped`, no watchdog) and printed the same two lines. So the line is what ffmpeg prints when it is interrupted while still opening its input: it was blocked there for the whole attempt, not rejected by SRS.
- `health-snapshot` entries of `12-3` during the incident: `bitrateKbps` 2445 to 2508, `progressAgeMs` 1000 to 1900, `failures` 0, 41 MB RSS, 3% CPU. The snapshots of `12-1` show `bitrateKbps: null` and a growing failure count.
- `12-3`'s start-up warning burst ended after 1 s (`ffmpeg-timestamp-recovered`); the other three shared encodes logged the same burst and worked.
- The SRS journal (log level `warn`) has no line mentioning `r12_copy_a0` in the window. The SRS `/api/v1/streams` shows `internal/r12_copy_a0` publishing normally after the restart (3 readers, 2.6 Mbps, H264 Main 1280x720, AAC), as it does for the other pipelines.
- No `host-cpu-high`, `host-memory-low` or kernel OOM entries between 09:30 and 10:10.

## Why the input of the output is the source

- The destination was never reached: the only socket of the failing ffmpeg was the one to local SRS.
- The shared encode was healthy and writing, so SRS accepted its data, yet an ffmpeg reading the same stream from SRS got none, for 25 minutes and for three different stream keys. The same condition on the three sibling pipelines did not occur.
- The fault cleared when the shared encode (the only shared piece of state between the failing attempts) was stopped and started again. A new stream key alone did not help (`12-4` failed the same way as `12-1`).

## Unknowns

- **Why SRS delivered nothing to the reader.** Possibilities are a bad state of that one internal stream inside SRS, or something about the first frames the shared encode published (it started 0.6 s after the input went live, mid-GOP). Neither was checked at the time: SRS logged nothing and no state of the stream was recorded.
- Whether YouTube viewers, or a live program, were affected.
- Whether the first output's `Input/output error` was the kill or something earlier: only the interrupted last attempt of `12-4` shows it was the kill.

## Findings and follow-ups

1. **Misleading watchdog message** (done). The socket watchdog reported a missing destination socket for an output that had written nothing and never connected, which is an input problem. It now says "No input data: ffmpeg has written nothing and never connected to the destination". After data was written the old wording is kept. `src/services/outputSockets.ts`, `src/services/outputs.ts`.
2. **Missing evidence** (done). The watchdog restarts now read the output's stream from SRS first (2 s limit) and record `input_source`, `srs_stream` and, for a shared output, `shared_encode` in the History, and an `inputSource` object in the `ffmpeg-restart` event. Checked on the real test stack with the `freeze` scenario (6 of 6 checks passed, the event carried the SRS stream state).
3. **A manual Start was not recorded** (done). The History now has a "started" record and the diagnostics an `output-user-start` event, so the sequence of what the operator did is visible next to the failures.
4. **Cause unknown, no automatic recovery** (open). Restarting the shared encode after repeated failed reads is what fixed this by hand and would have cut it from 25 minutes to about 2. It is not implemented: it changes watchdog behaviour, needs fault tests, and the cause is unknown. Recorded with the reasons in [the design decisions](../docs/4-reference/3-design-decisions.md#an-output-that-never-connected-is-reported-as-waiting-for-input-and-restarts-record-the-input-source). If it happens again the new records should show whether SRS or the encode was at fault.
5. **A shorter input `-rw_timeout` was rejected**: it bounds every read, so a short input gap would restart outputs and use up their 5-attempt limit. Same entry in the design decisions.
6. **Operator workaround** (documented in [known issues](../docs/3-operations/5-known-issues.md#a-shared-encode-can-stay-up-while-its-outputs-cannot-read-it)): stop every output of the pipeline, wait about 20 s until the shared encode stops, start them again.
7. **Outside this repository:** check YouTube's stream health for 09:42 to 10:08 if the outage mattered.

## Status

Follow-ups 1 to 3 are implemented and tested (unit and integration tests, and the `freeze` fault scenario) in commit `5c1788b`; they are not deployed to the VM. Follow-up 4 stays open and the cause is not established.
