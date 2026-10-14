# Translation outputs

A translation output mixes a live interpreter's audio into an output. It is
configured directly on an output: the output's own pipeline is the **source** (it
supplies the video and source audio), and a second, user-selected pipeline
supplies the **translator** audio. The mixer publishes the result to that
output's destination, so each output can have its own translator and settings.

The output must use the **Translation** audio encoding and be started by the
user. The mixer does not create pipelines or start translator inputs
automatically. If the translator disconnects or is not live, the output keeps
publishing source audio only; when the translator becomes live again, the
translated mix resumes.

Use SRT for both the source and the translator pipeline: it has fixed,
predictable latency. RTMP inputs have variable buffering, which works against
the fixed delay and ducking timing this feature relies on; the dashboard warns on
an output card when either side is RTMP.

The dashboard's **User Manual** (the open-book icon in the navbar) has the same
guide, so it is at hand during an event.

## Signal flow and timing

The translator audio is delayed before it is mixed into the output. The mixer
measures the translator's undelayed audio to detect speech, then uses that
advance time to lower the source volume before the translated speech becomes
audible. This avoids the source staying at full volume during the first part of
each translated sentence.

```
                                     ┌─► meter / voice detection
Translator pipeline ──audio──────────┤
                                     └─► delay ───────────────┐
                                                              │
Source pipeline ──video───────────────────────────────────────┼─► output
                 audio ──► source gain / ducking ─────────────┘

Source volume
───────●                       ●─────────
        \                     /
         \                   /
          \                 /
           ●───────────────●
           T1              T2

T1: translator speech is detected; source volume fades down.
T2: translator has been silent long enough; source restores.
```

The delay should be long enough for the mixer to detect speech before the
delayed translator audio reaches the output. It is normally paired with the duck
fade duration: for example, an 800 ms translation delay and a 900 ms source duck
fade give the source time to move down smoothly. A longer delay gives more
warning but also increases translation latency. If the translator starts
speaking again before the restore fade finishes, ducking takes over immediately
from the current source level instead of finishing the climb back up first.

## Settings

| Setting | Meaning |
|---------|---------|
| Translator Pipeline | Pipeline carrying the translator audio |
| Source Track / Translation Input Track | Which audio track to use from each pipeline |
| Translation Delay (ms) | Delay applied to the audible translator audio |
| Voice Threshold (dB) | Speech detection threshold; a non-positive value such as `-20` |
| Source While Speaking (%) | Source volume while the translator is speaking |
| Duck Fade (ms) | Time used to lower the source volume when speech starts |
| Restore After / Volume / Fade | Silence required before restoring, the restored source volume, and the fade time |

Volumes are percentages from 0 to 100 and map directly to FFmpeg gain: for
example, 6 means a gain of 0.06, or 6% of the source amplitude.

## Known limitations

### Recovery after a translator SRT disconnect is slow

When a translation output's translator input drops, the source's ducked
volume does not recover for tens of seconds — sometimes a minute or more.
Reconnecting the translator is fast by comparison (a few seconds). This
asymmetry is expected: connecting is an edge-triggered, unambiguous event (a
new publish is immediately visible), but disconnecting is inferred from
absence, which SRS can't trust right away — the app only reacts once its
health poll observes SRS's own stream list as gone, and SRS itself only
concludes an SRT peer is dead after its `srt_server.peer_idle_timeout`
elapses with nothing received, confirmed via `SRTS_BROKEN` in the SRS log
(see [Known issues](../3-operations/5-known-issues.md#srs-logs-srts_broken-errors-for-every-srt-play-disconnect-including-clean-ones)). In the rarer case where the translation mixer's own
FFmpeg process also stalls (rather than just losing the translator leg
cleanly), recovery instead waits on the coarser output-progress-stalled
watchdog (`stallMs`, default 45s) to restart it.

**Why this is not tuned lower.** `peer_idle_timeout` is a single setting on
SRS's shared SRT listener — it applies to every SRT input, not just
translators, including the main broadcast source. SRT exists specifically to
tolerate lossy/unstable networks; shortening this timeout to speed up
translator recovery would risk the main source being torn down on a brief,
real network blip during a live event. A translator SRT drop is rare, and
the output degrades gracefully in the meantime (it keeps publishing source
audio throughout), so that tradeoff is not worth the risk to the primary
broadcast path.

**Mitigation:** none needed — the output stays up on source audio for the
entire gap. If translator disconnects become frequent enough to matter,
investigate the translator's own network path rather than this timeout.

### Sync is only tight for SRT sources

Translation pipelines are meant to use SRT inputs. With an SRT source the
mixed output keeps the source and translator within a fraction of a second
(measured ~0 s, or up to ~0.7 s translator-behind when the translator also
sends video), before the configured translation delay is added. This relies
on the mixer opening the translator first with a short probe; see the comment
in `buildTranslationMixerArgs`.

An RTMP source still works, but SRS's GOP cache makes every new RTMP player
start at the last keyframe, so the source can trail the translation by up to
its keyframe interval (measured −2.2 s to +0.2 s with a 2 s GOP), varying per
mixer start. This is not compensated: doing so would mean either disabling
SRS's GOP cache globally (slower start/restart for every output and preview)
or estimating the offset at runtime inside a live process.

**Mitigation:** use SRT for translation sources. If RTMP is unavoidable, a
1 s keyframe interval on the encoder keeps the error near 1 s.
