#!/usr/bin/env bash
# One-shot native setup for a Linux server.
# Installs Node.js 22, FFmpeg 7.1, SRS 6.0, goryu, builds the app,
# and registers systemd services that start on boot.
#
# Usage:
#   sudo git clone https://github.com/live-miracles/bunryu /opt/bunryu
#   sudo bash /opt/bunryu/scripts/server-install.sh
#
# Optional:
#   REPO_URL=https://github.com/your-fork/bunryu sudo bash scripts/server-install.sh
set -euo pipefail

ASSUME_YES=no
case "${1:-}" in
    -y | --yes)
        ASSUME_YES=yes
        ;;
    '')
        ;;
    *)
        echo "Usage: sudo bash scripts/server-install.sh [-y|--yes]" >&2
        exit 2
        ;;
esac

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: run as root (sudo bash scripts/server-install.sh)" >&2
    exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "ERROR: this installer only supports x86_64 (got $(uname -m)); the FFmpeg/SRS builds it downloads are x86_64-only." >&2
    exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/live-miracles/bunryu}"
APP_DIR=/opt/bunryu
DATA_DIR=/var/lib/bunryu
CONF_DIR=/etc/bunryu
SERVICE_USER=bunryu

SRS_VERSION=6.0-r2
SRS_RELEASE_TAG="v${SRS_VERSION}"
SRS_FILENAME="SRS-CentOS7-x86_64-${SRS_VERSION}.zip"
SRS_SHA256="8b654eccaf2d984dd87cb4f6c8663748922c1cb529de65f6d895ac3daade89a2"
SRS_URL="https://github.com/ossrs/srs/releases/download/${SRS_RELEASE_TAG}/${SRS_FILENAME}"

# Pinned goryu binary — published from the standalone relay repo.
# The Dockerfile pins the same SRS, relay and FFmpeg builds; bump both together.
SRT_RELEASE_TAG="${SRT_RELEASE_TAG:-v3.2.0}"
SRT_FILENAME="goryu-linux-x86_64.tar.gz"
SRT_SHA256="${SRT_SHA256:-cc326f298a081456b2726a2af7e1d1ada820fd99f66ead6e6f1499c2039d8a86}"
SRT_URL="${SRT_URL:-https://github.com/live-miracles/goryu/releases/download/${SRT_RELEASE_TAG}/${SRT_FILENAME}}"

# Mirrored into our own releases since BtbN prunes autobuild tags after ~2 years.
# To bump: grab a newer linux64-gpl build from BtbN/FFmpeg-Builds/releases, upload
# it via `gh release create ffmpeg-n<ver> <file> --repo live-miracles/bunryu`,
# then update these values (and scripts/dev-server-install.sh) to match.
FFMPEG_VERSION=7.1
FFMPEG_BUILD_TAG="ffmpeg-n7.1.4-7-gadcf20da26"
FFMPEG_FILENAME="ffmpeg-n7.1.4-7-gadcf20da26-linux64-gpl-7.1.tar.xz"
FFMPEG_SHA256="ce46c711e3ff79ae1e9318bf7daa54c77f41ce37b71010c44f4a0b38f1d7a29f"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() {
    echo
    echo "=== $* ==="
}

# Verify a downloaded file against an expected SHA256. An empty expected hash
# skips the check (used when a custom version/URL override makes the pin moot).
verify_sha256() {
    local file="$1" expected="$2"
    if [[ -z "$expected" ]]; then
        echo "Checksum: skipped (custom version/URL)"
        return
    fi
    local actual
    actual="$(sha256sum "$file" | awk '{print $1}')"
    if [[ "$actual" != "$expected" ]]; then
        echo "ERROR: checksum mismatch for $(basename "$file")" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        exit 1
    fi
    echo "Checksum OK: $(basename "$file")"
}

step "1/9 System packages"
apt-get update -q
apt-get install -y -q curl tar xz-utils unzip git ca-certificates build-essential

# Update the source first, before any step reads the pinned versions or writes
# config: this script is itself part of the update, so a run that pulled newer
# code halfway through would carry on with the old script's pins and units (bash
# also reads a script lazily, so replacing it mid-run can garble the rest). After
# the pull, hand over to the freshly pulled copy; BUNRYU_INSTALL_REEXEC stops a loop.
# The brace group is parsed in full before git runs, so the exec is already in memory.
SELF_SUM="$(sha256sum "$(readlink -f "$0")" 2> /dev/null | awk '{print $1}' || true)"
{
    if [[ ! -d "$APP_DIR/.git" ]]; then
        git clone "$REPO_URL" "$APP_DIR"
    else
        echo "Repository already present at $APP_DIR, pulling latest code."
        # Root owns the tree (the service user must not), which git requires of
        # the user running it; older installs may still have another owner.
        chown -R root:root "$APP_DIR"
        git -C "$APP_DIR" fetch origin
        git -C "$APP_DIR" reset --hard '@{u}'
    fi
    NEW_SELF="$APP_DIR/scripts/server-install.sh"
    if [[ -z "${BUNRYU_INSTALL_REEXEC:-}" && "$(sha256sum "$NEW_SELF" | awk '{print $1}')" != "$SELF_SUM" ]]; then
        echo "Restarting with the updated installer ($NEW_SELF)."
        export BUNRYU_INSTALL_REEXEC=1
        exec bash "$NEW_SELF" "$@"
    fi
}

step "2/9 Node.js 22"
if node --version 2> /dev/null | grep -q '^v22'; then
    echo "Node.js 22 already installed: $(node --version)"
else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    echo "Installed: $(node --version)"
fi

step "3/9 FFmpeg $FFMPEG_VERSION"
FFMPEG_URL="https://github.com/live-miracles/bunryu/releases/download/${FFMPEG_BUILD_TAG}/${FFMPEG_FILENAME}"

if /usr/local/bin/ffmpeg -version 2> /dev/null | grep -q "ffmpeg version n${FFMPEG_VERSION}"; then
    echo "FFmpeg $FFMPEG_VERSION already installed."
else
    echo "Downloading $FFMPEG_FILENAME..."
    curl -fsSL "$FFMPEG_URL" -o "$WORK/$FFMPEG_FILENAME"
    verify_sha256 "$WORK/$FFMPEG_FILENAME" "$FFMPEG_SHA256"
    tar -xJf "$WORK/$FFMPEG_FILENAME" -C "$WORK"
    FFMPEG_DIR="$(find "$WORK" -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)"
    install -m 755 "${FFMPEG_DIR}/bin/ffmpeg" /usr/local/bin/ffmpeg
    install -m 755 "${FFMPEG_DIR}/bin/ffprobe" /usr/local/bin/ffprobe
    echo "Installed: $(/usr/local/bin/ffmpeg -version 2>&1 | head -1)"
fi

SRS_VERSION_MARKER=/usr/local/bin/.srs-version
step "4/9 SRS $SRS_VERSION"
if [[ -x /usr/local/bin/srs && -f "$SRS_VERSION_MARKER" && "$(cat "$SRS_VERSION_MARKER")" == "$SRS_RELEASE_TAG" ]]; then
    echo "SRS $SRS_VERSION ($SRS_RELEASE_TAG) already installed."
else
    echo "Downloading $SRS_FILENAME ($SRS_RELEASE_TAG)..."
    curl -fsSL "$SRS_URL" -o "$WORK/$SRS_FILENAME"
    verify_sha256 "$WORK/$SRS_FILENAME" "$SRS_SHA256"
    unzip -q "$WORK/$SRS_FILENAME" -d "$WORK/srs"
    SRS_BIN="$(find "$WORK/srs" -type f -path '*/usr/local/srs/objs/srs' | head -1)"
    if [[ -z "$SRS_BIN" ]]; then
        echo "ERROR: could not find srs binary in $SRS_FILENAME" >&2
        exit 1
    fi
    install -m 755 "$SRS_BIN" /usr/local/bin/srs
    echo "$SRS_RELEASE_TAG" > "$SRS_VERSION_MARKER"
    echo "Installed: $(/usr/local/bin/srs -v 2>&1 | head -1)"
fi

SRT_VERSION_MARKER=/usr/local/bin/.goryu-version
# The relay ships its own libsrt and C++ runtime. Only the relay may load them
# (LD_LIBRARY_PATH in its unit): registered system-wide they shadow the host's
# libstdc++/libcrypto for every program, which breaks apt-get on hosts whose
# libstdc++ is newer than the bundled one.
SRT_LIB_DIR=/usr/local/lib/bunryu-srt
step "5/9 goryu $SRT_RELEASE_TAG"
if [[ -x /usr/local/bin/goryu && -f "$SRT_VERSION_MARKER" && "$(cat "$SRT_VERSION_MARKER")" == "$SRT_RELEASE_TAG" ]]; then
    echo "goryu $SRT_RELEASE_TAG already installed."
else
    echo "Downloading $SRT_FILENAME ($SRT_RELEASE_TAG)..."
    curl -fsSL "$SRT_URL" -o "$WORK/$SRT_FILENAME"
    verify_sha256 "$WORK/$SRT_FILENAME" "$SRT_SHA256"
    tar -xzf "$WORK/$SRT_FILENAME" -C "$WORK"
    SRT_BIN="$(find "$WORK" -type f -name goryu -perm -111 | head -1)"
    if [[ -z "$SRT_BIN" ]]; then
        echo "ERROR: could not find goryu binary in $SRT_FILENAME" >&2
        exit 1
    fi
    if [[ -d "$WORK/lib" ]]; then
        install -d -m 755 "$SRT_LIB_DIR"
        install -m 755 "$WORK"/lib/* "$SRT_LIB_DIR/"
    fi
    install -m 755 "$SRT_BIN" /usr/local/bin/goryu
    echo "$SRT_RELEASE_TAG" > "$SRT_VERSION_MARKER"
    echo "Installed: /usr/local/bin/goryu"
fi

step "6/9 Service user and directories"
if ! id "$SERVICE_USER" &> /dev/null; then
    useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    echo "Created user: $SERVICE_USER"
else
    echo "User $SERVICE_USER already exists."
fi
mkdir -p "$APP_DIR" "$DATA_DIR" "$DATA_DIR/objs" "$CONF_DIR"
# The application tree is root-owned and read-only to the service user. Root
# runs code from it on every update (this script, npm, the build, the password
# reset), so a service user that owns it could turn a compromised SRS/FFmpeg/
# Node process into root on the next update. The service user only writes to
# the data and config directories.
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/objs" "$CONF_DIR"

step "7/9 Application"
cd "$APP_DIR"
# No dependency lifecycle scripts run as root: only the two native modules the
# app needs are built, explicitly.
npm ci --ignore-scripts
npm rebuild better-sqlite3 zeromq
npm run build
npm prune --omit=dev
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
# The service user runs `git log` (dashboard version panel) in a repo it does not
# own; git refuses that unless the directory is marked safe.
if ! git config --system --get-all safe.directory | grep -qxF "$APP_DIR"; then
    git config --system --add safe.directory "$APP_DIR"
fi
echo "Build complete."

step "8/9 Config and data"
# SRT passphrase: the repo configs ship a public default, so on first install
# (when these files don't exist yet at $CONF_DIR) generate a per-server secret
# and write it to both. On reinstall, each file's currently-deployed
# passphrase is read before it gets overwritten below and simply written
# back — no comparisons, no syncing between the two files. Change or disable
# it (empty disables the check) by editing both files by hand and restarting
# the services.
NEW_SRT_PASSPHRASE="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
if [[ -f "$CONF_DIR/srs.conf" ]]; then
    SRS_SRT_PASSPHRASE="$(sed -n 's/^[[:space:]]*passphrase[[:space:]]\{1,\}\(.*\);[[:space:]]*$/\1/p' "$CONF_DIR/srs.conf" | head -1)"
    echo "SRT passphrase (srs.conf): keeping existing value"
else
    SRS_SRT_PASSPHRASE="$NEW_SRT_PASSPHRASE"
    echo "SRT passphrase (srs.conf): generated new secret"
fi
if [[ -f "$CONF_DIR/goryu.json" ]]; then
    RELAY_SRT_PASSPHRASE="$(node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(c.passphrase||"");' "$CONF_DIR/goryu.json")"
    echo "SRT passphrase (goryu.json): keeping existing value"
else
    RELAY_SRT_PASSPHRASE="$NEW_SRT_PASSPHRASE"
    echo "SRT passphrase (goryu.json): generated new secret"
fi
# The repo ships a public default passphrase for dev. Never keep it on a server:
# if either deployed file still has it (an old install, or a hand-copied config),
# replace it in both so the two stay in sync.
PUBLIC_DEFAULT_SRT_PASSPHRASE=bunryu-default-srt-passphrase
if [[ "$SRS_SRT_PASSPHRASE" == "$PUBLIC_DEFAULT_SRT_PASSPHRASE" || "$RELAY_SRT_PASSPHRASE" == "$PUBLIC_DEFAULT_SRT_PASSPHRASE" ]]; then
    SRS_SRT_PASSPHRASE="$NEW_SRT_PASSPHRASE"
    RELAY_SRT_PASSPHRASE="$NEW_SRT_PASSPHRASE"
    echo "SRT passphrase: replaced the public default with a generated secret"
fi
cp "$APP_DIR/srs.conf" "$CONF_DIR/srs.conf"
cp "$APP_DIR/goryu.json" "$CONF_DIR/goryu.json"
echo "Config: refreshed $CONF_DIR/srs.conf from repository"
echo "Config: refreshed $CONF_DIR/goryu.json from repository"
# Written via node, not sed -i: a hand-typed passphrase containing "&" or "\"
# would otherwise be reinterpreted as sed replacement syntax and silently
# corrupted instead of applied verbatim.
node -e 'const fs=require("fs");const [p,pass]=process.argv.slice(1);const c=fs.readFileSync(p,"utf8").replace(/^([ \t]*passphrase[ \t]+).*;/m,(_,prefix)=>prefix+pass+";");fs.writeFileSync(p,c);' \
    "$CONF_DIR/srs.conf" "$SRS_SRT_PASSPHRASE"
node -e 'const fs=require("fs");const [p,pass]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(p,"utf8"));c.passphrase=pass;fs.writeFileSync(p,JSON.stringify(c,null,4)+"\n");' \
    "$CONF_DIR/goryu.json" "$RELAY_SRT_PASSPHRASE"
# Dashboard password: bunryu.json's dashboard_password only seeds a database
# that has no password yet; the repo's bunryu.json carries none, so generate
# one on first install and keep the deployed value on reinstall.
DASHBOARD_PASSWORD=""
if [[ -f "$APP_DIR/bunryu.json" ]]; then
    DASHBOARD_PASSWORD="$(node -e 'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof c.dashboard_password==="string"?c.dashboard_password:"");}catch{}' "$APP_DIR/bunryu.json")"
fi
if [[ -n "$DASHBOARD_PASSWORD" ]]; then
    echo "Dashboard password (bunryu.json): keeping existing value"
else
    DASHBOARD_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
    echo "Dashboard password (bunryu.json): generated new secret"
fi
cat > "$APP_DIR/bunryu.json" << EOF
{
    "port": 8080,
    "database_path": "$DATA_DIR/db.sqlite",
    "srs_config_path": "$CONF_DIR/srs.conf",
    "ffmpeg_path": "/usr/local/bin/ffmpeg",
    "ffprobe_path": "/usr/local/bin/ffprobe",
    "output_watchdog": {
        "warmup_ms": 90000,
        "stall_ms": 45000,
        "interval_ms": 5000,
        "socket_warmup_ms": 15000,
        "socket_grace_ms": 30000
    }
}
EOF
# Written via node for the same reason as the passphrases above: a hand-typed
# password containing quotes or backslashes must not corrupt the JSON.
node -e 'const fs=require("fs");const [p,pass]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(p,"utf8"));c.dashboard_password=pass;fs.writeFileSync(p,JSON.stringify(c,null,4)+"\n");' \
    "$APP_DIR/bunryu.json" "$DASHBOARD_PASSWORD"
echo "Config: refreshed $APP_DIR/bunryu.json"
# Database. We don't run data migrations, so a db.sqlite left over from an older
# version could be schema-incompatible and cause hard-to-debug issues.
DB_FILE="$DATA_DIR/db.sqlite"
fresh_db=yes
if [[ -s "$DB_FILE" ]]; then
    wipe_db=no
    case "${WIPE_DB:-}" in
        y | Y) wipe_db=yes ;;
        n | N) wipe_db=no ;;
        *)
            if [[ "$ASSUME_YES" == yes ]]; then
                echo "Existing database found at $DB_FILE. Preserving it (-y/--yes)."
            elif [[ -t 0 ]]; then
                read -rp "Existing database found at $DB_FILE. Preserve it? [Y/n] " reply
                [[ "$reply" == "n" || "$reply" == "N" ]] && wipe_db=yes
            fi
            ;;
    esac
    if [[ "$wipe_db" == "yes" ]]; then
        # Keep a copy (same owner-only mode: it holds the stream keys and
        # destination URLs) so the pipelines and outputs can be re-created.
        DB_BACKUP="$DB_FILE.$(date +%Y%m%d-%H%M%S).bak"
        cp -p "$DB_FILE" "$DB_BACKUP"
        rm -f "$DB_FILE"
        echo "Database wiped (backup: $DB_BACKUP); defaults will be re-seeded on first boot."
    else
        fresh_db=no
        echo "Keeping existing database."
    fi
fi
touch "$DB_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$CONF_DIR/srs.conf" "$CONF_DIR/goryu.json" "$APP_DIR/bunryu.json" "$DB_FILE"
# bunryu.json now holds the dashboard password in plain text. The database holds
# the password hash, stream keys and destination URLs (platform stream keys), and
# the two configs hold the SRT passphrase: nothing here is for other local users.
chmod 600 "$APP_DIR/bunryu.json" "$DB_FILE"
chmod 640 "$CONF_DIR/srs.conf" "$CONF_DIR/goryu.json"
chmod 750 "$DATA_DIR" "$CONF_DIR"
echo "Config: $CONF_DIR/srs.conf"
echo "App config: $APP_DIR/bunryu.json"
echo "Data:   $DB_FILE"

step "9/9 Systemd"
# Keep the journal bounded and available for the same seven-day incident window
# as the application's structured diagnostics. These limits are host-wide, but
# are intentionally conservative for the streaming VM and prevent a noisy
# service from consuming the disk.
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/bunryu.conf << 'EOF'
[Journal]
Storage=persistent
Compress=yes
SystemMaxUse=1G
SystemKeepFree=2G
RuntimeMaxUse=256M
MaxRetentionSec=7day
MaxFileSec=1day
SystemMaxFileSize=100M
EOF
systemctl restart systemd-journald

cat > /etc/systemd/system/srs.service << EOF
[Unit]
Description=SRS Streaming Server
After=network-online.target bunryu.service
Wants=network-online.target
Requires=bunryu.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$DATA_DIR
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 60); do curl -fsS http://127.0.0.1:8080/api/ready >/dev/null && exit 0; sleep 1; done; echo "bunryu readiness check timed out" >&2; exit 1'
ExecStart=/usr/local/bin/srs -c $CONF_DIR/srs.conf
Restart=always
RestartSec=2
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR $CONF_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/goryu.service << EOF
[Unit]
Description=Shared Goryu relay
After=network-online.target bunryu.service srs.service
Wants=network-online.target
Requires=bunryu.service srs.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$DATA_DIR
Environment=LD_LIBRARY_PATH=$SRT_LIB_DIR
ExecStart=/usr/local/bin/goryu $CONF_DIR/goryu.json
Restart=always
RestartSec=2
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR $CONF_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/bunryu.service << EOF
[Unit]
Description=Bunryu Control Plane
After=network-online.target
Wants=network-online.target
# Restart=always alone still gives up after systemd's default start limit
# (5 starts in 10 s) and leaves the unit failed until someone intervenes; 0
# turns the limit off so all three units keep retrying every RestartSec.
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
# Journal files are only readable by root and the systemd-journal group -
# sharing a UID with srs.service/goryu.service does not itself
# grant read access. Lets the dashboard's /api/srs-logs shell out to
# \`journalctl -u <unit>\` for any unit's log, not just srs.service.
SupplementaryGroups=systemd-journal
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $APP_DIR/dist/index.js
Restart=always
RestartSec=2
# Exit 78 means a database of another schema version: it needs an operator, so
# do not restart it in a loop (see src/index.ts).
RestartPreventExitStatus=78
# This service forks one ffmpeg per output (300+) plus ffprobe/preview helpers,
# each carrying several threads. LimitNOFILE covers the parent's pipe/socket fds;
# TasksMax/LimitNPROC lift the task (thread+process) cap, which otherwise falls
# back to systemd's default (~15% of pid_max) and would be hit during a mass
# start/restart surge — manifesting as spawn failures (EAGAIN) right when many
# outputs are recovering at once.
LimitNOFILE=1048576
TasksMax=infinity
LimitNPROC=infinity
# Files the app creates (database journal, HLS previews, diagnostics) are private.
UMask=0077
PrivateTmp=true
ProtectSystem=full
NoNewPrivileges=true
ReadWritePaths=$DATA_DIR $CONF_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable srs.service goryu.service bunryu.service
systemctl stop goryu.service srs.service bunryu.service 2> /dev/null || true
systemctl start bunryu.service
systemctl start srs.service
systemctl start goryu.service

echo
echo "=============================="
echo " Setup complete"
echo "=============================="
echo "Dashboard: http://<server-ip>:8080/"
if [[ "$fresh_db" == "yes" ]]; then
    echo "  Password: $DASHBOARD_PASSWORD"
    echo "  (also stored as dashboard_password in $APP_DIR/bunryu.json;"
    echo "   change it in Settings -> Change Password after logging in)"
else
    echo "  Password: unchanged (kept existing database)"
    echo "  Forgot it? Run scripts/server-reset-password.sh"
fi
echo "  Set your public host in Settings → Public Host"
echo "App config: $APP_DIR/bunryu.json"
echo "Config:    $CONF_DIR/srs.conf"
echo "Data:      $DATA_DIR/db.sqlite"
echo ""
echo "Security:"
echo "  RTMP now listens on 21935 (was 1935) - update your GCP firewall rule"
echo "  and encoder URLs. The dashboard shows the current publish URLs."
echo "  SRT requires a passphrase (see $CONF_DIR/srs.conf); it is included"
echo "  in the SRT publish URLs shown in the dashboard."
echo ""
echo "Check status:"
echo "  systemctl status srs.service"
echo "  systemctl status goryu.service"
echo "  systemctl status bunryu.service"
echo ""
echo "Follow logs:"
echo "  journalctl -u goryu.service -f"
echo "  journalctl -u bunryu.service -f"
echo "  journalctl -u srs.service -f"
echo ""
echo "Update later:"
echo "  sudo bash $APP_DIR/scripts/server-install.sh"
