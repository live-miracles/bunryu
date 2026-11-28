# Incident: One shared encode's audio was distorted on both outputs until it was restarted; cause not established

- **Date:** 2026-11-28 (times below are IST, UTC+05:30; the diagnostics file uses UTC)
- **Component:** shared encode (rendition) with an audio re-encode, FFmpeg audio decode/resample
- **Trigger:** A dry run on the production VM. About an hour after `server-install.sh` restarted the whole stack, audio was played into pipeline 8 (`key08_<redacted>`, "Tamil Step7") and came out distorted. Why is not established (see Unknowns).
- **Impact:** Both outputs of pipeline 8 (YT and VDO), which read the same shared encode, carried distorted audio from when audio started (about 15:00) until the shared encode was restarted by hand at 15:07:50. Pipelines 2 and 3, with shared encodes of the same recipe, fed by the same encoder and started in the same second, were not affected. The video, the input, and the network were not affected as far as the logs show. It was a dry run, not a live program.

## Summary

The shared encode of pipeline 8 (`8-3`) started 1.0 s after the pipeline's SRT input came back following the install, and it was the only one of the three that logged a burst of H.264 decode errors at start (it had joined mid-GOP). It then ran 69 minutes as one process. During the first hour nothing was sent on the audio track, so there was nothing to hear. When audio began, the encode used 10 to 16% CPU, two to three times the 5 to 6% of the two sibling shared encodes carrying the same content, and the operator heard distortion on both outputs. Restarting the shared encode removed the symptom: from 15:09 its CPU and bitrate match the siblings (checked to 15:22).

The logs rule out load, network loss and the host. They do not show what FFmpeg did wrong inside the process, because FFmpeg ran at `-loglevel warning` and only a 3 KB stderr tail is kept. The cause is therefore a hypothesis. This report records the evidence, and the change made to capture it next time.

Version on the VM: `6734c46` (package version 3.1.0), the same as `master` at the time. FFmpeg and SRS were the pinned production builds.

## Timeline

| Time (IST) | Event |
|---|---|
| 13:00 - 13:42 | Before the install, `8-3` runs normally: about 2630 kbps, 5% CPU, speed 1.00, SRT loss and drops low. |
| 13:58:22 | `server-install.sh` restarts the stack (`server-started` 13:58:23). All inputs disconnect. |
| 13:58:28 | The relay is running again and the three SRT inputs go live from the same encoder address (`<redacted-ip>`). |
| 13:58:28.7 / 29.1 / 29.5 | Shared encodes `2-3`, `3-3` and `8-3` start. Only `8-3` logs `non-existing PPS 0 referenced` and `decode_slice_header error` (44 lines in 1.1 s). |
| 13:58:38 | Output `8-2` (YT) starts reading `8-3`. `8-4` (VDO) is started by hand at 14:00:58. |
| 13:58 - 14:58 | `8-3` writes about 2513 kbps at 2.8% CPU. The siblings write about 2638 kbps at 5 to 6%. The 125 kbps difference is one 128k AAC track, so no audio was being sent on key08 (`3-3` shows the same drop for a few minutes before 14:58). |
| 14:58:23 - 15:00:33 | Audio starts on key08 (reported by the operator, who did not note the time). `8-3` goes to 2601 kbps and 16.4% CPU. |
| 15:00 - 15:07 | `8-3` stays at 10 to 16% CPU; `2-3` and `3-3` stay at 5 to 7%. Speed stays 1.000, `failures` 0, SRT loss about 18 packets in the hour, no drops. The operator hears distortion on both outputs. |
| 15:06:56 | `8-2` (YT) stopped by hand. |
| 15:07:07 - 15:07:48 | Two new publishes allowed on key08 (15:07:07 and 15:07:45), with publisher changes at 15:07:08 and 15:07:48: a different source address, then back to the original. Pipeline alert `publisher-reconnected` for 65 s. The running `8-3` is not restarted by them. |
| 15:07:46 | `8-2` started by hand. |
| 15:07:50 | Shared encode `8-3` restarted by hand; its two outputs restart with it (`shared encode restarted by user`). New run `8-3#2` starts 15:07:53 (6 warning lines at start). |
| 15:09 - 15:22 | `8-3` runs at 4.6 to 6.6% CPU and about 2640 kbps (one-minute dips also appear on the siblings), the same as `2-3` and `3-3`. The operator confirms the audio is fixed. |

## Evidence

From `/var/lib/bunryu/diagnostics/diagnostics-2026-11-28.jsonl` (events `ffmpeg-started`, `ffmpeg-exited`, `ffmpeg-restart`, `ffmpeg-timestamp-warning*`, `input-publisher-transition`, and the once-a-minute `health-snapshot` for outputs `2-3`, `3-3`, `8-3`) and `journalctl -u bunryu.service`.

- Same stream clock: at 15:03:33 `2-3` and `8-3` report the identical `lastOutTimeUs` (3897621333), and both inputs show 3049 kbps. `lastTotalSizeBytes` was 1285 MB for `2-3` and 1227 MB for `8-3`, so `8-3` wrote 58 MB less over the same 3897 s.
- Output rate and CPU per five minutes, from the snapshot size and CPU deltas:

| Window (IST) | `2-3` kbps / CPU % | `3-3` | `8-3` |
|---|---|---|---|
| 14:30 - 14:55 | 2634 - 2650 / 5 - 7 | 2514 - 2640 / 3 - 6 | 2497 - 2528 / 2.7 - 2.9 |
| 15:00 - 15:05 | 2578 - 2680 / 6 - 7 | 2650 - 2681 / 5 | 2601 - 2684 / 10 - 16 |
| 15:10 - 15:20 | 2545 - 2683 / 4.4 - 10.6 | 2559 - 2678 / 4.6 - 6.8 | 2506 - 2682 / 4.6 - 6.6 |

- `8-3#1`'s exit event (`status: stopped`, 15:07:53) has a 3 KB stderr tail of repeated `non-existing PPS` / `decode_slice_header error` lines and four `Packet corrupt` and two `PES packet size mismatch` lines from the mpegts demuxer. Those came with the publisher changes seconds earlier. The tail holds nothing from 15:00.
- No `ffmpeg-warning-started` (memory, socket, media clock), no watchdog restart, no `host-cpu-high` or `host-memory-low`, and no OOM kill in the kernel log. Host CPU pressure was about 9%.

## Why this points at the `8-3` process

- The same recipe, input rate and stream clock on `2-3` and `3-3` was fine.
- `8-3` used two to three times the CPU for the same content, and returned to the siblings' level after a restart and nothing else.
- Nothing outside the process differed: loss, speed, memory and the host were the same as for the siblings.

## Unknowns

- **What went wrong inside FFmpeg.** There is no audio parameter data in the logs. `8-3` ran at `-loglevel warning`, which drops the line that says how FFmpeg read the input's streams, and only 3 KB of stderr is kept.
- **Whether the start moment is the cause.** `8-3` is the only one of the three whose start logged the mid-GOP decode errors, and it was the last to start. But `3-3` crossed the same silence-to-audio change at 14:58 and was fine, and `2-3` and `3-3` started in the same second. So the start moment is a lead, not a finding.
- **A mis-read channel layout.** [2026-07-10](2026-07-10-pipeline1-output-oom-cascade.md) recorded an AAC frame misparsed as a bogus channel layout ("Full-on remixing from 22.2"), which made the downmix to stereo expensive. A wrong layout at start would explain both the CPU and the sound. No such line was seen here, but the stderr from 15:00 was not kept, so this is not excluded.
- **Whether the publisher changes at 15:07 helped.** The restart came 2 seconds after the last of them. The encode ran through them unchanged, and the operator reports the restart as the fix, but the two cannot be fully separated.
- **When the distortion started.** The operator did not note the time; 15:00 is taken from the output rate and CPU change.

## Findings and follow-ups

1. **Done: the input streams as FFmpeg read them are now in diagnostics.** A process that transcodes audio runs at `-loglevel info -hide_banner` and writes one `ffmpeg-input-info` event per start (container, codec, sample rate, channel layout, stream mapping; the pull URL, which carries the stream key, is masked). Copy outputs stay at `warning`, so the stderr volume of the hundreds of copy outputs does not change. Code: `logsInputInfo` and `createInputInfoCollector` in `src/utils/ffmpeg.ts`, the event in `src/services/outputs.ts`; tests in `test/utils.test.ts` and `test/outputs.test.ts`; described in `docs/3-operations/4-reliability.md`.
2. **Open: if it happens again, capture before restarting.** On the VM: the running ffmpeg command line (`ps`), an `ffprobe` of the input's SRS stream (audio sample rate and channels), and 10 seconds of the shared encode's output. With the event above, the first of these should already be in diagnostics.
3. **Open, not done on purpose: delay starting a shared encode after a publisher reconnect.** Rejected for now. The only support is the mid-GOP start of one encode, `3-3` contradicts it, and a wait adds a state to the output start path, which the project avoids without evidence. Revisit if `ffmpeg-input-info` of a distorted encode shows a wrong reading made at start.
4. **Operational note.** A full restart (for example `server-install.sh`) starts every shared encode while its publisher is still reconnecting. After an install during a rehearsal, listen to each key's audio, and restart any shared encode that sounds wrong (Restart on the Shared encodes card).

## Status

The diagnostics change is implemented and its tests pass (`test/utils.test.ts`, `test/outputs.test.ts`, `test/outputTimeout.test.ts`); it has not been deployed to the VM. The cause is open. The report will be updated if the event shows a wrong input reading on a later occurrence.
