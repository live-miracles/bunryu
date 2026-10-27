# Publishing to a pipeline

A **pipeline** is one live input. Creating a pipeline assigns it a stream key;
the pipeline panel's **Publish to this input** card shows one input mode at a
time (**RTMP**, **SRT** or **SRT Relay**), chosen with the buttons at its top. It
follows the encoder: when a publisher connects the card switches to the mode it is
using (marked with a green dot), and until the mode changes again a mode you picked
stays. Each row shows a value, shortened with an ellipsis if it is long, and a
copy button (two overlapping squares): server URL, key, stream ID or passphrase separately for encoders
that ask for them in separate fields, and the full publish URL (SRT Relay has two: **Bonded URL** for an encoder that sends over several links, and **Single-link URL** for an ordinary one). The stream key and
stream ID are masked after their `keyNN_` prefix (`key01_••••••••`) and the passphrase
entirely; the eye button beside each shows the real value for 15 s, for typing it
into an encoder by hand. Copy always copies the real value.

| Protocol | Port | URL shape |
|----------|------|-----------|
| RTMP | 21935/tcp | `rtmp://<public-host>:21935/live/<stream-key>` |
| SRT | 10080/udp | `srt://<public-host>:10080?streamid=#!::r=live/<stream-key>,m=publish&passphrase=<passphrase>&pbkeylen=16` |
| SRT via relay | 10081/udp | `srt://<public-host>:10081?mode=caller&streamid=#!::r=live/<stream-key>,m=publish&passphrase=<passphrase>&pbkeylen=16` |
| Bonded SRT | 10081/udp | `srt://<public-host>:10081?mode=caller&grouptype=broadcast&streamid=#!::r=live/<stream-key>,m=publish&passphrase=<passphrase>&pbkeylen=16` |

`<public-host>` is the **Public Host** set in Settings. It is empty on a new install:
the dashboard shows a banner asking for it, and the publish URLs use `localhost` until
you set it. The SRT passphrase is
generated at install time and can be reset in Settings; see [SRS and SRT relay config](../1-getting-started/3-install.md#srs-and-srt-relay-config).
The repository's default passphrase is for development; an installed server replaces it
with a generated secret. Copy the current passphrase from the dashboard rather than
assuming the default.

Prefer SRT when the encoder supports it: it has fixed, predictable latency,
survives lossy networks better than RTMP, and keeps every audio track. Use
bonded SRT for encoders that send the same stream over several network links
(for example cellular bonding units); the SRT relay
([Goryu](https://github.com/live-miracles/goryu))
merges the links before SRS sees the stream.

The relay port also accepts an ordinary single-link SRT connection: use the
relay URL without `grouptype=broadcast`. The dashboard then shows it as an
"SRT input via relay" with the encoder's IP, instead of a bonded group. This is
optional. Plain SRT sent straight to port 10080 avoids the relay's extra hop
(about 200 ms) and keeps the stream independent of the relay process; see
[SRT ingest](../4-reference/3-design-decisions.md#srt-ingest).
The trade-off is visibility: SRS does not expose packet loss, retransmit or drop
counters for an SRT publisher, so a stream sent straight to 10080 has no link
statistics or loss alerts in the dashboard (its input card says so). Through the
relay you get them, so use the bonded port when you want to watch the link.
While an encoder is publishing through the relay, the pipeline shows the SRT Relay card
under the input's video and audio details, whichever Publish mode is selected. It keeps a compact summary
visible; select the **Detailed stats** icon (bars) in the card's top right corner to open a dialog sized to its
input, per-leg, output and graph content, within the screen width. It refreshes live statistics with the dashboard's regular poll.
At the top of the dialog each leg has its own loss and drop charts, each with its own value axis, so a
leg with far larger counts does not flatten the others. The axis spans the counts in the
window, not zero up, so a new drop stands out even after hours of accumulated ones. A leg's two
charts sit side by side when the dialog is wide enough.

The card's **L / R / D** figures (packets lost, retransmitted and dropped) count the
**last 10 minutes**, not the whole session; the label shows the window (less than 10 min
for the first minutes after a link connects), and hovering a figure names the
counts. A link with nothing lately is dimmed so a burst stands out. A bonded input as a whole shows
only **Drop**, the packets still missing after the legs backed each other up; that is
what actually damages the stream, so it turns amber when it is above zero. A drop on one
leg does not: the other leg usually delivered the packet. The Overview's SRT Relay table
uses the same figures; the dialog's detailed rows (the totals since the stream connected) and graphs are cumulative.

When the relay has recorded an error, a **History** button (clock icon, as on an
output) appears beside the card's title and opens it. The relay keeps only its latest
error per stream, and keeps it across reconnects, so the card shows the error line
and turns the button red only while it is unresolved: the stream is up and has not
forwarded a packet since the error. Once packets flow again, or the stream is idle,
the line goes away and the error stays in History.

Because the relay forgets that error when the session ends, each new one is also
written to the pipeline log as "Relay error: …". A stream that keeps failing the same
way (a rejected key retries every few seconds) stays one line, updated to "(seen N
times over 3 min)" instead of filling the log; N counts the errors a 5 s poll saw, so
it can be lower than the relay's own retries.

Whatever the protocol, the pipeline's log records the encoder's address each time a
publisher connects (`Publisher: rtmp from <ip>`), which is how you tell afterwards
which encoder was on a key. A bonded input logs its legs instead.

## Test commands

These `ffmpeg` commands publish a test stream. Replace `localhost` with the
server address, and `<stream-key>` / `<passphrase>` with the values from the
dashboard.

### Without a camera, file or destination

This generates a test card and a tone, so you need no encoder, video file or
platform account:

```bash
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440 \
  -c:v libx264 -preset veryfast -b:v 2500k -pix_fmt yuv420p -g 60 \
  -c:a aac -b:a 128k \
  -f flv rtmp://localhost:21935/live/<stream-key>
```

To see an output run without a real destination, forward one pipeline into
another on the same server:

1. Create two pipelines, A and B.
2. Add an output to A with the destination
   `rtmp://localhost:21935/live/<stream-key-of-B>`. An output may connect to
   loopback only on the server's own RTMP/SRT ports.
3. Run the command above with A's stream key.

A goes live and its output shows running, and B goes live with the forwarded
stream. Preview either one.

### From a file

These commands publish a looping file.

RTMP:

```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -c:a aac -b:a 128k \
  -f flv rtmp://localhost:21935/live/<stream-key>
```

SRT (if the passphrase check is disabled, drop
`&passphrase=<passphrase>&pbkeylen=16`):

```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -x264-params "repeat-headers=1" \
  -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10080?streamid=#!::r=live/<stream-key>,m=publish&passphrase=<passphrase>&pbkeylen=16'
```

For a normal single-link SRT connection through the relay, use port 10081 without
`grouptype=broadcast`:

```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -x264-params "repeat-headers=1" \
  -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10081?mode=caller&streamid=#!::r=live/<stream-key>,m=publish&passphrase=<passphrase>&pbkeylen=16'
```

SRT with multiple audio tracks (for example one per language):

```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -map 0 \
  -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k \
  -x264-params "repeat-headers=1" \
  -force_key_frames 'expr:gte(t,n_forced*2)' -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10080?streamid=#!::r=live/<stream-key>,m=publish&passphrase=<passphrase>&pbkeylen=16'
```

## Checking the input

Once a publisher connects, the pipeline turns live and the dashboard shows the
input's codec, resolution, frame rate, bitrate and audio tracks (from `ffprobe`),
and how far apart its keyframes are (**Keyframes**, measured over 12 s of video about
a minute after the publisher connects; "1 in 12 s" means a single keyframe in that time). YouTube needs a keyframe at least every 4 s
and recommends 2 s; with a longer interval the pipeline gets a warning alert, and a
preview starts late. Set the encoder's keyframe interval to 2 s (the commands above
do). **Preview** plays the input in the dashboard.

### Preview

The preview is an HLS stream made by the server's FFmpeg. The input's video is
copied unchanged, and only the audio is re-encoded to AAC.

- **Browser:** only Chrome is supported. HEVC inputs play only where Chrome can
  decode HEVC; otherwise you get audio without picture.
- **Server cost:** a few percent of one core per open preview (about 9% for a
  1080p input with two audio tracks). Previewing is fine even on a 2 vCPU server.
- **Bandwidth:** each viewer receives the input's full bitrate, for example about
  6 Mbps for a typical 1080p input, through the dashboard (and the Cloudflare
  Tunnel, if used).
- **Audio tracks:** an input with several audio tracks gets a track selector; the
  switch happens in the browser, without restarting the preview.
- **Delay:** segments start on the input's keyframes, so an encoder with a long
  keyframe interval (e.g. 6–10 s) makes the preview start slower and run further
  behind live. A 2 s keyframe interval, which platforms recommend anyway, keeps it
  short.
- **Stopping:** a preview stops when you press Stop or close the tab, and on its
  own about 20 s after nobody is watching (see
  [Security](../3-operations/1-security.md)).

Publishes with an unknown stream key are rejected by SRS before any output
starts. Recent rejected attempts are listed under the pipeline list ("Rejected
publish attempts"), which helps when an encoder is configured with a stale key;
see [Security](../3-operations/1-security.md) for details.
