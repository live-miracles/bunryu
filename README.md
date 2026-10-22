<img src="public/logo.png" alt="Bunryu logo" width="96" align="right" />

# Bunryu

_Bunryu (分流, "branching flow"): one live stream, many destinations._

[![CI](https://github.com/live-miracles/bunryu/actions/workflows/ci.yml/badge.svg)](https://github.com/live-miracles/bunryu/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-live--miracles.github.io-blue.svg)](https://live-miracles.github.io/projects/bunryu/)

**Self-hosted restreaming server built for reliability, for live events that run for many hours.** Take inputs over RTMP, SRT and bonded SRT, and forward each one to many RTMP/RTMPS/SRT destinations (YouTube, Facebook, Twitch, CDNs) from one Linux server. Watchdogs restart a failed output without affecting the others.

Built on official [SRS](https://github.com/ossrs/srs) for ingest, [`goryu`](https://github.com/live-miracles/goryu) for bonded SRT ingress, and FFmpeg for outputs, with a Node.js + TypeScript control plane, web dashboard and REST API.

| [Install](docs/1-getting-started/3-install.md) | [Try with Docker](docs/1-getting-started/2-docker.md) | [Documentation](docs/README.md) |
| --- | --- | --- |

![Bunryu dashboard: a pipeline with live preview and seven running outputs](.github/assets/pipeline-view.png)

## Features

- [Ingest](docs/2-usage/1-publishing.md) over RTMP, SRT and bonded SRT, with stream-key authorization and passphrase-protected SRT.
- [Forward](docs/2-usage/2-outputs.md) each input to many RTMP, RTMPS or SRT destinations: no fixed limit, tested with 50 inputs and 500 outputs per server. Copy-mode (passthrough) outputs cost almost no CPU.
- [Transcode](docs/2-usage/2-outputs.md#video-encoding) a few outputs to 720p, 1080p or a rotated vertical feed for Shorts/Reels, and [select audio tracks](docs/2-usage/2-outputs.md#audio) per output, including multi-track SRT outputs. Outputs that need the same encode [share one FFmpeg](docs/2-usage/2-outputs.md#shared-encodes), so ten 720p outputs cost one encode, not ten.
- [Mix translation audio](docs/2-usage/3-translation.md) (beta) from an interpreter's pipeline over the source, with speech detection, ducking, delay and restore timing. If the translator drops, the output continues with source audio.
- [Recover automatically](docs/3-operations/4-reliability.md): stall, socket and memory watchdogs with bounded restarts. One failing destination never affects the others.
- Keep [post-incident evidence](docs/3-operations/4-reliability.md#input-timestamp-fault-detection): per-output Error History with FFmpeg stderr tails, grouped timestamp warnings, and [rotated structured diagnostics](docs/3-operations/3-configuration.md).
- Watch everything in a live dashboard: HLS preview, ffprobe media details, bitrates, host and per-process CPU/RAM/network charts, and copy-ready publish URLs, and it stays readable with 50 inputs and 500 outputs ([measured](docs/1-getting-started/4-sizing.md#the-dashboard-at-the-supported-ceiling)).
- Restart safely: SRS accepts publishes only once the control plane is ready, and all configuration persists in SQLite.

![Overview page with host charts and per-process resources](.github/assets/overview.png)

![The dashboard with 50 inputs and 500 outputs: two inputs drop, and the totals, the affected pipelines and the Issues tab show it](.github/assets/dashboard-problems.gif)

_50 inputs and 500 outputs in one dashboard. The control plane, SRS and inputs are real; the outputs are simulated, so no FFmpeg load is shown ([details](docs/1-getting-started/4-sizing.md#the-dashboard-at-the-supported-ceiling))._

## Built for reliability

A live event can't be restarted. Bunryu assumes something will go wrong (a destination stalls, an encoder drops, a process runs out of memory) and is built so the failure stays small, fixes itself where that is safe, and is explained afterwards.

- **Isolated:** each output is its own FFmpeg process. A frozen, refusing or non-reading destination, a dropped input or a crashed FFmpeg doesn't touch the other outputs or pipelines.
- **Bounded recovery:** [watchdogs](docs/3-operations/4-reliability.md) restart stuck outputs with limits, so a bad destination can't cause a restart storm.
- **Safe startup:** SRS accepts publishes only once the control plane is ready, and a service restart or host reboot comes back from SQLite without manual steps.
- **Accurate state:** inputs and outputs don't stay "running" in the dashboard after a disconnect, crash or restart.
- **Evidence:** per-output Error History, rotated diagnostics, and [incident write-ups](fail-reports/README.md) of real failures and their fixes.
- **Small and boring:** no media code of our own. SRS, libsrt and FFmpeg do the media work, and the control plane is about 11,000 lines of TypeScript; it costs some efficiency ([why](docs/1-getting-started/5-comparison.md#design-approach)).

These paths are exercised with fault-injection scenarios (a frozen destination, one that never reads, one that refuses connections, output churn, a publisher outage, an SRS crash, a CPU-saturated host and a soak with 50 healthy outputs). No software can promise that nothing fails: see [Known issues](docs/3-operations/5-known-issues.md) and the [supported capacity](docs/1-getting-started/1-introduction.md#capacity-and-limits) for what Bunryu does not cover.

## Quick start

Try it with Docker:

```bash
git clone https://github.com/live-miracles/bunryu
cd bunryu
BUNRYU_DASHBOARD_PASSWORD='choose-a-long-password' docker compose up -d
```

Open `http://localhost:8080`, log in with that password, create a pipeline and publish to the URL the dashboard shows. No camera? [Publish a test card](docs/2-usage/1-publishing.md#without-a-camera-file-or-destination) with FFmpeg.

Install on a server (Debian/Ubuntu, x86_64, systemd), the recommended setup for production:

```bash
sudo git clone https://github.com/live-miracles/bunryu /opt/bunryu
sudo BUNRYU_DASHBOARD_PASSWORD='choose-a-long-password' bash /opt/bunryu/scripts/server-install.sh
```

The installer needs the initial dashboard password on a fresh install and never prints one. See [Native install](docs/1-getting-started/3-install.md) for firewall ports, updates and the SRT passphrase, and [Remote access](docs/3-operations/2-remote-access.md) for reaching the dashboard securely.

## Documentation

- **Getting started:** [Introduction](docs/1-getting-started/1-introduction.md) · [Docker](docs/1-getting-started/2-docker.md) · [Native install](docs/1-getting-started/3-install.md) · [Comparison with alternatives](docs/1-getting-started/5-comparison.md)
- **Usage:** [Publishing](docs/2-usage/1-publishing.md) · [Outputs](docs/2-usage/2-outputs.md) · [Translation outputs](docs/2-usage/3-translation.md) (beta)
- **Operations:** [Security](docs/3-operations/1-security.md) · [Remote access](docs/3-operations/2-remote-access.md) · [Configuration](docs/3-operations/3-configuration.md) · [Reliability](docs/3-operations/4-reliability.md) · [Known issues](docs/3-operations/5-known-issues.md)
- **Reference:** [REST API](docs/4-reference/1-api.md) · [Development](docs/4-reference/2-development.md)

## License

[MIT](LICENSE). SRS, goryu and FFmpeg are separate projects under their own licenses.
