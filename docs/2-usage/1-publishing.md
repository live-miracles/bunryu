# Publishing to a pipeline

A **pipeline** is one live input. Creating a pipeline assigns it a stream key;
the pipeline panel in the dashboard has a copy button for the full publish URL
of every protocol, plus buttons to copy the server URL, key, stream ID or
passphrase separately for encoders that ask for them in separate fields. The
panel does not display the URLs themselves.

| Protocol | Port | URL shape |
|----------|------|-----------|
| RTMP | 21935/tcp | `rtmp://<public-host>:21935/live/<stream-key>` |
| SRT | 10080/udp | `srt://<public-host>:10080?streamid=#!::r=live/<stream-key>,m=publish&passphrase=<passphrase>&pbkeylen=16` |
| Bonded SRT | 10081/udp | `srt://<public-host>:10081?mode=caller&grouptype=broadcast&streamid=#!::r=live/<stream-key>,m=publish&passphrase=<passphrase>&pbkeylen=16` |

`<public-host>` is the **Public Host** set in Settings. It is empty on a new install:
the dashboard shows a banner asking for it, and the publish URLs use `localhost` until
you set it. The SRT passphrase is
generated at install time; see [SRS and SRT relay config](../1-getting-started/3-install.md#srs-and-srt-relay-config).

Prefer SRT when the encoder supports it: it has fixed, predictable latency,
survives lossy networks better than RTMP, and keeps every audio track. Use
bonded SRT for encoders that send the same stream over several network links
(for example cellular bonding units); the
[`goryu`](https://github.com/live-miracles/goryu)
merges the links before SRS sees the stream.

The bonded port also accepts an ordinary single-link SRT connection: use the
bonded URL without `grouptype=broadcast`. The dashboard then shows it as an
"SRT input via relay" with the encoder's IP, instead of a bonded group. This is
optional. Plain SRT sent straight to port 10080 avoids the relay's extra hop
(about 200 ms) and keeps the stream independent of the relay process; see
[SRT ingest](../4-reference/3-design-decisions.md#srt-ingest).
The trade-off is visibility: SRS does not expose packet loss, retransmit or drop
counters for an SRT publisher, so a stream sent straight to 10080 has no link
statistics or loss alerts in the dashboard (its input card says so). Through the
relay you get them, so use the bonded port when you want to watch the link.

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
input's codec, resolution, frame rate, bitrate and audio tracks (from `ffprobe`).
**Preview** plays the input in the dashboard.

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
