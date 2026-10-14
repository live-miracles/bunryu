#!/usr/bin/env bash
# Container entrypoint: prepares /data on first start, then supervises the
# three processes that the native install runs as systemd units.
#
# - bunryu (Node.js control plane) starts first.
# - SRS starts only after http://127.0.0.1:8080/api/ready answers, on every
#   (re)start, like srs.service's ExecStartPre gate.
# - srt-bonding-relay starts after SRS.
# Each process is restarted 2 s after it exits (RestartSec=2 in systemd), and
# every start/exit is logged with its status. On SIGTERM the relay and SRS are
# stopped before the control plane, which stops its FFmpeg outputs.
set -uo pipefail
# Files the app creates (database, HLS previews, diagnostics) are private, as
# with UMask=0077 in the systemd units.
umask 077

DATA_DIR=/data
APP_DIR=/app
PORT=8080
RESTART_DELAY_S=2
READY_TIMEOUT_S=60

log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [entrypoint] $*"
}

random_secret() {
    head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9'
}

prepare_data() {
    mkdir -p "$DATA_DIR/objs"
    chmod 750 "$DATA_DIR"
    cd "$DATA_DIR" || exit 1

    # SRT passphrase: generated on first start, kept afterwards. The configs are
    # refreshed from the image on every start (like a reinstall) so an image
    # upgrade picks up config changes; only the passphrase carries over.
    local srs_pass relay_pass new_pass
    new_pass="$(random_secret)"
    srs_pass="$new_pass"
    relay_pass="$new_pass"
    if [[ -f srs.conf ]]; then
        srs_pass="$(sed -n 's/^[[:space:]]*passphrase[[:space:]]\{1,\}\(.*\);[[:space:]]*$/\1/p' srs.conf | head -1)"
    fi
    if [[ -f srt-bonding-relay.json ]]; then
        relay_pass="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.passphrase||"");' srt-bonding-relay.json)"
    fi
    if [[ "$srs_pass" == bunryu-default-srt-passphrase || "$relay_pass" == bunryu-default-srt-passphrase ]]; then
        srs_pass="$new_pass"
        relay_pass="$new_pass"
    fi
    cp "$APP_DIR/srs.conf" srs.conf
    cp "$APP_DIR/srt-bonding-relay.json" srt-bonding-relay.json
    node -e 'const fs=require("fs");const [p,pass]=process.argv.slice(1);fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/^([ \t]*passphrase[ \t]+).*;/m,(_,prefix)=>prefix+pass+";"));' \
        srs.conf "$srs_pass"
    node -e 'const fs=require("fs");const [p,pass]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(p,"utf8"));c.passphrase=pass;fs.writeFileSync(p,JSON.stringify(c,null,4)+"\n");' \
        srt-bonding-relay.json "$relay_pass"

    # Dashboard password: only seeds an empty database (see the Authentication
    # section of docs/3-operations/1-security.md); generated once and kept in
    # bunryu.json.
    local password=""
    if [[ -f bunryu.json ]]; then
        password="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof c.dashboard_password==="string"?c.dashboard_password:"");}catch{}' bunryu.json)"
    fi
    if [[ -z "$password" ]]; then
        password="$(random_secret)"
        log "generated dashboard password: $password (stored in $DATA_DIR/bunryu.json; change it in Settings after logging in)"
    fi
    node -e '
const fs = require("fs");
const [p, pass] = process.argv.slice(1);
const c = {
    port: 8080,
    database_path: "/data/db.sqlite",
    srs_config_path: "/data/srs.conf",
    ffmpeg_path: "/usr/local/bin/ffmpeg",
    ffprobe_path: "/usr/local/bin/ffprobe",
    output_watchdog: {
        warmup_ms: 90000,
        stall_ms: 45000,
        interval_ms: 5000,
        socket_warmup_ms: 15000,
        socket_grace_ms: 30000,
    },
    dashboard_password: pass,
};
fs.writeFileSync(p, JSON.stringify(c, null, 4) + "\n", { mode: 0o600 });
' bunryu.json "$password"
    chmod 600 bunryu.json
    chmod 640 srs.conf srt-bonding-relay.json
}

wait_ready() {
    local i
    for ((i = 0; i < READY_TIMEOUT_S; i++)); do
        # `stopping` is the calling supervise()'s local (bash dynamic scope).
        ((stopping)) && return 1
        curl -fsS "http://127.0.0.1:$PORT/api/ready" > /dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}

no_gate() {
    return 0
}

# supervise <name> <gate-function> <command...>
supervise() {
    local name="$1" gate="$2"
    shift 2
    local child="" stopping=0 status again
    trap 'stopping=1; [[ -n "$child" ]] && kill -TERM "$child" 2> /dev/null' TERM INT
    while ((!stopping)); do
        if ! "$gate"; then
            ((stopping)) && break
            log "$name: control plane not ready after ${READY_TIMEOUT_S}s; retrying"
            continue
        fi
        log "$name: starting"
        "$@" &
        child=$!
        # A signal that landed before $child was set killed nothing.
        ((stopping)) && kill -TERM "$child" 2> /dev/null
        wait "$child"
        status=$?
        # A trapped signal interrupts wait; wait again for the real exit.
        if ((stopping)); then
            wait "$child" 2> /dev/null
            again=$?
            ((again != 127)) && status=$again
            log "$name: stopped (status $status)"
            break
        fi
        log "$name: exited with status $status; restarting in ${RESTART_DELAY_S}s"
        child=""
        sleep "$RESTART_DELAY_S" &
        wait $! 2> /dev/null
    done
    exit 0
}

prepare_data

supervise bunryu no_gate node "$APP_DIR/dist/index.js" &
app_pid=$!
supervise srs wait_ready /usr/local/bin/srs -c "$DATA_DIR/srs.conf" &
srs_pid=$!
supervise srt-bonding-relay wait_ready /usr/local/bin/srt-bonding-relay "$DATA_DIR/srt-bonding-relay.json" &
relay_pid=$!

shutdown() {
    log "shutdown requested; stopping relay and SRS, then the control plane"
    kill -TERM "$relay_pid" "$srs_pid" 2> /dev/null
    wait "$relay_pid" "$srs_pid" 2> /dev/null
    kill -TERM "$app_pid" 2> /dev/null
    wait "$app_pid" 2> /dev/null
    log "all processes stopped"
    exit 0
}
trap shutdown TERM INT

wait
