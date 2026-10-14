# Remote access (Cloudflare Tunnel)

The dashboard is meant to be reached through a Cloudflare Tunnel plus
Cloudflare Access (see [Security](1-security.md)), so port 8080 can stay closed in
the firewall. The installer does not set this up; `cloudflared` runs as its own
systemd service, outside the three services of the
[native install](../1-getting-started/3-install.md). Ingest (RTMP/SRT) and
outputs never go through the tunnel, so restarting `cloudflared` only
interrupts dashboard/API access.

1. **Create the tunnel** in Cloudflare Zero Trust → Networks → Tunnels →
   *Create a tunnel* (type *Cloudflared*). Copy the tunnel token from the
   install command it shows (the long string after `--token`).
2. **Add a public hostname** to the tunnel, e.g. `restream.example.com`, with
   service `HTTP` → `localhost:8080`.
3. **Protect it with Cloudflare Access**: Zero Trust → Access → Applications →
   add a self-hosted application for that hostname with an allow policy for
   your team. Without this the hostname is open to the internet and only the
   dashboard password stands in the way.
4. **Install `cloudflared`** from the
   [Cloudflare package repository](https://pkg.cloudflare.com/) (or the `.deb`
   from its GitHub releases).
5. **Store the token in a root-only environment file** rather than on the
   command line. Do **not** use `cloudflared service install <token>`: it puts
   the token in `ExecStart`, where every local user can read it via
   `ps`/`/proc/<pid>/cmdline` and the world-readable unit file.
   ```bash
   sudo install -d -m 0750 /etc/cloudflared
   sudo sh -c 'umask 077; printf "TUNNEL_TOKEN=%s\n" "<paste-token-here>" > /etc/cloudflared/tunnel.env'
   ```
   `cloudflared tunnel run` reads the `TUNNEL_TOKEN` environment variable
   itself, so no `--token` flag is needed.
6. **Create the unit** `/etc/systemd/system/cloudflared.service`:
   ```ini
   [Unit]
   Description=Cloudflare Tunnel client
   After=network-online.target
   Wants=network-online.target

   [Service]
   TimeoutStartSec=15
   Type=notify
   EnvironmentFile=/etc/cloudflared/tunnel.env
   ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run
   Restart=on-failure
   RestartSec=5s

   [Install]
   WantedBy=multi-user.target
   ```
7. **Start it and check**:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now cloudflared
   journalctl -u cloudflared -n 20 --no-pager   # look for "Registered tunnel connection"
   ps -eo args | grep '[c]loudflared'            # the token must not appear here
   ```

To rotate the token, generate a new one in the Zero Trust dashboard, update
`/etc/cloudflared/tunnel.env`, and `sudo systemctl restart cloudflared`. Treat
the token as compromised (and rotate it) if it was ever printed in a log or
terminal, or was previously passed on the command line.
