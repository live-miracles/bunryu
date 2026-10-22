# Docker

Docker is the quickest way to try Bunryu. For long-running production
servers, use the [native install](3-install.md).

## Quick start

```bash
git clone https://github.com/live-miracles/bunryu
cd bunryu
BUNRYU_DASHBOARD_PASSWORD='choose-a-long-password' docker compose up -d
```

Open `http://localhost:8080`, log in with that password, create a
pipeline and [publish](../2-usage/1-publishing.md) to it.

No camera or local FFmpeg? Run the image's own FFmpeg as a test source
(`<stream-key>` is from the pipeline panel; stop it with Ctrl+C):

```bash
docker exec bunryu ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440 \
  -c:v libx264 -preset veryfast -b:v 2500k -pix_fmt yuv420p -g 60 \
  -c:a aac -b:a 128k \
  -f flv rtmp://localhost:21935/live/<stream-key>
```

The image is x86_64 only. On Apple Silicon Macs and other ARM hosts it runs
emulated, which is for trying and developing only; run production on Linux x86_64
(see [Details](#details)).

## Details

The image bundles the control plane, SRS, goryu and the same
pinned FFmpeg build as the native installer (x86_64 only). On an ARM host such
as an Apple Silicon Mac, `compose.yaml` makes Docker emulate it (with plain
`docker build` and `docker run`, add `--platform linux/amd64`); that is slower, so
use it only to try or develop Bunryu. See
[why there is no ARM image](../4-reference/3-design-decisions.md#the-docker-image-is-x86_64-only-arm-hosts-run-it-emulated-for-development).
One container runs
all three processes under a small supervisor (`docker/entrypoint.sh`) that
keeps the native startup order: SRS starts only after `/api/ready` answers,
each process is restarted 2 s after it exits, and every start and exit is
logged with its status. The exception is a failure only an operator can fix, a
database of another schema version or a missing or invalid `bunryu.json`, `srs.conf` or
`goryu.json`: the control plane exits with status 78, the supervisor logs it and starts
nothing else, and the container stays up but unhealthy until the cause is fixed (remove
`/data/db.sqlite` for the database) and it is restarted.

```bash
docker compose up -d                       # build and start (compose.yaml)
docker compose logs -f bunryu        # all three processes log here
docker compose down                        # stop; data stays in the volume
```

Or without compose:

```bash
docker build -t bunryu .
docker run -d --name bunryu --restart unless-stopped \
  -p 8080:8080 -p 21935:21935 -p 10080:10080/udp -p 10081:10081/udp \
  -e BUNRYU_DASHBOARD_PASSWORD='choose-a-long-password' \
  -v bunryu-data:/data bunryu
```

- **Data**: everything persistent is in the `/data` volume: `db.sqlite`,
  `bunryu.json`, the generated `srs.conf` / `goryu.json`, HLS
  previews and diagnostics. On every start the SRS and relay configs are
  refreshed from the image and keep their SRT passphrase, like a reinstall;
  `bunryu.json` keeps any setting you added and gets only the port, paths and
  password set.
- **Secrets**: the first start needs `BUNRYU_DASHBOARD_PASSWORD` (it is stored
  as `dashboard_password` in `/data/bunryu.json`, so later starts don't) and
  otherwise stops with an error in the logs; it never generates or logs a
  password. The container does generate a random SRT passphrase.
- **Public host**: set **Settings → Public Host** to the address encoders use,
  so the dashboard's publish URLs are correct.
- **Limitations**: the dashboard's SRS/relay/app log viewers read journald, so
  they are empty in Docker; use `docker compose logs`. The version panel
  shows the commit as `unknown`. The Goryu needs UDP port 10081
  published as above. The image can't raise the kernel's UDP buffer ceiling;
  see [UDP buffer ceiling](../3-operations/3-configuration.md#udp-buffer-ceiling).
