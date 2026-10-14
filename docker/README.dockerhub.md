# Bunryu

**Bunryu (分流, "branching flow")** is a self-hosted restreaming server for long
live events. It takes inputs over RTMP, SRT and bonded SRT and forwards each one
to many RTMP/RTMPS/SRT destinations (YouTube, Facebook, Twitch, CDNs), with
watchdogs that restart a failed output without affecting the others.

- Source, issues and full documentation: https://github.com/live-miracles/bunryu
- Website: https://live-miracles.github.io/projects/bunryu/

This image bundles the control plane, SRS, srt-bonding-relay and a pinned
FFmpeg build (linux/amd64). It is the quickest way to try Bunryu; long-running
production servers use the native systemd install.

## Run

```bash
docker run -d --name bunryu --restart unless-stopped \
  -p 8080:8080 -p 21935:21935 -p 10080:10080/udp -p 10081:10081/udp \
  -v bunryu-data:/data livemiracles/bunryu:latest
docker logs bunryu | grep "dashboard password"
```

Open `http://localhost:8080`, log in with the printed password, create a
pipeline and publish to the URL the dashboard shows.

| Port | Protocol | Purpose |
|------|----------|---------|
| 8080 | TCP | Dashboard and REST API |
| 21935 | TCP | RTMP input |
| 10080 | UDP | SRT input |
| 10081 | UDP | Bonded SRT input |

Everything persistent (database, config, generated passphrase, diagnostics)
lives in the `/data` volume.

## Tags

- `latest`, `X.Y.Z`, `X.Y`: releases
- `edge`: the current `master` branch

The same images are published as `ghcr.io/live-miracles/bunryu`.
