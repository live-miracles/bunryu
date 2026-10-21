#!/usr/bin/env bash
# Isolated Bunryu test stack: own SRS, own control plane, fresh DB, fake
# output ffmpeg. Never touches a developer's own `npm run dev` (8080/1985).
# Usage: scripts/test-stack.sh start | status | flood on|off | shot <png> [js] [waitMs] | stop
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
WORK=${WORK:-${TMPDIR:-/tmp}/bunryu-ui}
APP_PORT=18080 HOOK_PORT=18082 RTMP_PORT=31935 API_PORT=31985 SRT_PORT=31080 CDP_PORT=9333
B=http://127.0.0.1:$APP_PORT
# start overwrites bunryu.json/srs.conf and deletes db.sqlite* in $WORK, so it
# must never point at the repo (that would wipe a developer's real config and DB).
case "$(realpath -m "$WORK")" in
    "$REPO" | "$REPO"/*)
        echo "WORK must be outside the repo ($REPO)"
        exit 1
        ;;
esac
mkdir -p "$WORK/objs"

# Launch detached with stdout/stderr/stdin fully redirected, so callers that pipe
# this script's output (| tail) are not kept waiting by the background process.
bg() {
    local log=$1
    shift
    (
        cd "$WORK"
        exec nohup "$@"
    ) > "$log" 2>&1 < /dev/null &
}

listener() { lsof -ti:"$1" -sTCP:LISTEN 2> /dev/null || true; }

health() {
    curl -s -m 5 -b "$WORK/cj" "$B/api/health" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for pid,p in d['pipelines'].items():
    print('pipeline',pid,'input',{k:p['input'][k] for k in ('connected','live')})
    for k,v in p['outputs'].items():
        if v.get('role')=='rendition': print('  shared encode',k,v['status'],'ready',v.get('ready'),'readers',v.get('readers'),(v['warningReason'] or '')[:100])
        else: print(' ',k,v['status'],v['bitrateKbps'],(v['warningReason'] or '')[:100]+(' (reads '+v['renditionId']+')' if v.get('renditionId') else ''))
    print('  alerts',[(a['severity'],a['code']) for a in p['alerts']])"
}

case "${1:-}" in
    start)
        for port in $APP_PORT $HOOK_PORT $RTMP_PORT $API_PORT $SRT_PORT $CDP_PORT; do
            [ -z "$(listener $port)" ] || {
                echo "port $port already in use - run 'stop' first"
                exit 1
            }
        done
        avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
        [ "$avail" -ge 1500 ] || [ -n "${FORCE:-}" ] || {
            echo "only ${avail}MB available; the stack needs ~1GB (FORCE=1 to override)"
            exit 1
        }
        (cd "$REPO" && npx tsc -p tsconfig.json) # public/js is gitignored build output
        # FAST_WATCHDOG=1 shortens the stall watchdog (20 s warm-up, 15 s stall) so the
        # fault scenarios of test-faults.mjs finish in minutes, not tens of minutes.
        if [ -n "${FAST_WATCHDOG:-}" ]; then
            WATCHDOG='"warmup_ms": 20000, "stall_ms": 15000, "interval_ms": 2000'
        else
            WATCHDOG='"warmup_ms": 90000, "stall_ms": 45000, "interval_ms": 5000'
        fi
        cat > "$WORK/bunryu.json" << JSON
{ "port": $APP_PORT, "hook_port": $HOOK_PORT, "database_path": "./db.sqlite", "srs_config_path": "./srs.conf",
  "dashboard_password": "admin",
  "ffmpeg_path": "$WORK/ffmpeg-shim.sh", "ffprobe_path": "$REPO/objs/ffprobe",
  "output_watchdog": { $WATCHDOG,
                       "socket_warmup_ms": 3600000, "socket_grace_ms": 3600000 } }
JSON
        sed -e "s/listen              21935;/listen              $RTMP_PORT;/" \
            -e "s/listen          127.0.0.1:1985;/listen          127.0.0.1:$API_PORT;/" \
            -e "s/listen          10080;/listen          $SRT_PORT;/" \
            -e "s#127.0.0.1:8082#127.0.0.1:$HOOK_PORT#g" "$REPO/srs.conf" > "$WORK/srs.conf"
        # Fake output ffmpeg: destination URL as last arg => healthy copy output
        # (progress on stdout, discontinuity flood on stderr while $WORK/flood exists);
        # anything else (preview) runs the real ffmpeg. Shared encodes are real too:
        # - a shared encode publishes to the internal app, so it runs the real ffmpeg;
        # - an output that reads one (its input is an internal stream) runs the real
        #   ffmpeg with the destination replaced by /dev/null, so it really reads the
        #   shared encode from SRS (readers, fan-out, restarts are real);
        # - while $WORK/real-outputs exists every output does that (CPU comparisons);
        # - an output to rtmp://192.0.2.<N>/<name> with $WORK/dest-<N>.port present really
        #   pushes to rtmp://127.0.0.1:<port>/dest/<name> (a destination that
        #   scripts/test-faults.mjs can freeze or black-hole); an srt://192.0.2.<N>:<p>?...
        #   output is redirected the same way to srt://127.0.0.1:<port>?... .
        # Real runs use `exec -a` so argv[0] stays the configured ffmpeg_path, which is
        # how the app's startup sweep recognises orphaned ffmpeg processes.
        cat > "$WORK/ffmpeg-shim.sh" << SHIM
#!/bin/bash
last="\${@: -1}"
case "\$last" in
  rtmp://127.0.0.1:$RTMP_PORT/internal/*) exec -a \$0 $REPO/objs/ffmpeg "\$@" ;;
  rtmp://*|rtmps://*|srt://*) ;;
  *) exec -a \$0 $REPO/objs/ffmpeg "\$@" ;;
esac
case "\$last" in
  rtmp://192.0.2.*/*)
    n=\${last#rtmp://192.0.2.}; n=\${n%%/*}
    if [ -s "$WORK/dest-\$n.port" ]; then
      args=("\$@")
      args[\$((\${#args[@]} - 1))]="rtmp://127.0.0.1:\$(cat "$WORK/dest-\$n.port")/dest/\${last##*/}"
      exec -a \$0 $REPO/objs/ffmpeg "\${args[@]}"
    fi ;;
esac
case "\$last" in
  srt://192.0.2.*)
    rest=\${last#srt://192.0.2.}; n=\${rest%%[:/?]*}
    if [ -s "$WORK/dest-\$n.port" ]; then
      query=; case "\$last" in *\?*) query="?\${last#*\?}" ;; esac
      args=("\$@")
      args[\$((\${#args[@]} - 1))]="srt://127.0.0.1:\$(cat "$WORK/dest-\$n.port")\$query"
      exec -a \$0 $REPO/objs/ffmpeg "\${args[@]}"
    fi ;;
esac
real=
[ -e "$WORK/real-outputs" ] && real=1
for a in "\$@"; do
  case "\$a" in rtmp://127.0.0.1:$RTMP_PORT/internal/*) real=1 ;; esac
done
if [ -n "\$real" ]; then
  args=("\$@")
  args[\$((\${#args[@]} - 1))]=/dev/null
  exec -a \$0 $REPO/objs/ffmpeg -y "\${args[@]}"
fi
trap 'exit 0' TERM INT
# No fork per tick (bash builtins only): 500 outputs would otherwise fork about 1000
# processes a second and saturate the host, which says nothing about the app.
exec 9<> <(:)
start=\${EPOCHREALTIME/[.,]/}; i=0
while true; do
  us=\$(( \${EPOCHREALTIME/[.,]/} - start ))
  echo "total_size=\$((us/2))"; echo "out_time_ms=\$us"; echo "bitrate=4000.0kbits/s"; echo "progress=continue"
  if [ -e "$WORK/flood" ]; then
    for n in \$(seq 40); do
      i=\$((i+1))
      echo "[aist#0:0/aac @ 0x5c4063a05240] timestamp discontinuity (stream id=256): -14980000, new offset= -\$((5160000+i%3))" >&2
      echo "[vist#0:1/h264 @ 0x62c407ef8200] timestamp discontinuity (stream id=257): 14980000, new offset= -\$((20140000+i%3))" >&2
    done
  fi
  read -t 1 -u 9 || true
done
SHIM
        chmod +x "$WORK/ffmpeg-shim.sh"
        rm -f "$WORK/flood" "$WORK/real-outputs" "$WORK/db.sqlite"*
        PORT=$APP_PORT DATABASE_PATH="$WORK/db.sqlite" bg "$WORK/app.log" "$REPO/node_modules/.bin/tsx" "$REPO/src/index.ts"
        bg "$WORK/srs.out" "$REPO/objs/srs" -c "$WORK/srs.conf"
        for _ in $(seq 40); do
            curl -sf "$B/login.html" > /dev/null && break
            sleep 1
        done
        curl -s -c "$WORK/cj" -H 'content-type: application/json' -d '{"password":"admin"}' "$B/api/auth/login"
        echo
        curl -s -b "$WORK/cj" -X POST "$B/api/pipelines" > "$WORK/pipe.json"
        KEY=$(python3 -c "import json;print(json.load(open('$WORK/pipe.json'))['streamKey'])")
        curl -s -b "$WORK/cj" -H 'content-type: application/json' -d '{"name":"Test_Live"}' "$B/api/pipelines/1" > /dev/null
        for n in A_YT B_YT A_FB B_FB; do
            curl -s -b "$WORK/cj" -H 'content-type: application/json' \
                -d "{\"name\":\"$n\",\"url\":\"rtmp://192.0.2.10/live/test\"}" "$B/api/pipelines/1/outputs" > /dev/null
        done
        bg "$WORK/pub.log" "$REPO/objs/ffmpeg" -re -f lavfi -i testsrc=size=640x360:rate=25 -f lavfi -i sine=frequency=440 \
            -c:v libx264 -preset ultrafast -tune zerolatency -b:v 800k -g 50 -c:a aac -b:a 64k -f flv \
            "rtmp://127.0.0.1:$RTMP_PORT/live/$KEY"
        echo $! > "$WORK/pub.pid"
        sleep 6
        curl -s -b "$WORK/cj" -X POST "$B/api/pipelines/1/outputs/start-all"
        echo
        sleep 8
        health
        ;;
    status) health ;;
    flood)
        if [ "${2:-}" = on ]; then touch "$WORK/flood"; else rm -f "$WORK/flood"; fi
        echo "flood ${2:-off}"
        ;;
    shot)
        out=${2:?png path}
        if [ -z "$(listener $CDP_PORT)" ]; then
            bg "$WORK/chrome.log" google-chrome --headless=new --no-sandbox --disable-gpu --remote-debugging-port=$CDP_PORT \
                --user-data-dir="$WORK/chrome-profile" --window-size=1500,1000 about:blank
            sleep 3
        fi
        node "$HERE/test-stack-cdp.mjs" "$out" "${3:-}" "${4:-3000}"
        ;;
    stop)
        rm -f "$WORK/flood" "$WORK/real-outputs"
        for port in $APP_PORT $API_PORT $CDP_PORT; do
            pids=$(listener $port)
            [ -z "$pids" ] || kill $pids
        done
        [ ! -f "$WORK/pub.pid" ] || {
            kill "$(cat "$WORK/pub.pid")" 2> /dev/null || true
            rm -f "$WORK/pub.pid"
        }
        sleep 4
        ss -ltn | grep -E ":($APP_PORT|$RTMP_PORT|$API_PORT|$SRT_PORT|$CDP_PORT)\b" || echo "all test ports closed"
        ;;
    *)
        echo "usage: $0 start|status|flood on|off|shot <png> [js] [waitMs]|stop"
        exit 2
        ;;
esac
