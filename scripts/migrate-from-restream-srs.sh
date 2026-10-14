#!/usr/bin/env bash
# One-time migration of a server installed under the project's previous name
# (restream-srs) to the Bunryu layout. Keeps the database, the dashboard
# password and both SRT passphrases; the service account keeps its UID.
#
#   /opt/restream-srs            -> /opt/bunryu  (restream.json -> bunryu.json)
#   /var/lib/restream-srs        -> /var/lib/bunryu
#   /etc/restream-srs            -> /etc/bunryu
#   user/group restream-srs      -> bunryu
#   restream-srs.service         -> bunryu.service
#   /usr/local/lib/restream-srs-srt -> /usr/local/lib/bunryu-srt
#
# Streams are interrupted while it runs (about a minute plus the build), so it
# refuses to start while SRS reports a live publisher unless --force is given.
#
# Usage:
#   git clone https://github.com/live-miracles/bunryu /tmp/bunryu-migrate
#   sudo bash /tmp/bunryu-migrate/scripts/migrate-from-restream-srs.sh [--force]
#
# REPO_URL overrides the repository the migrated checkout pulls from (used to
# rehearse the migration against a local repository).
set -euo pipefail

FORCE=no
case "${1:-}" in
    --force) FORCE=yes ;;
    '') ;;
    *)
        echo "Usage: sudo bash scripts/migrate-from-restream-srs.sh [--force]" >&2
        exit 2
        ;;
esac

REPO_URL="${REPO_URL:-https://github.com/live-miracles/bunryu}"
OLD_APP=/opt/restream-srs
OLD_DATA=/var/lib/restream-srs
OLD_CONF=/etc/restream-srs
OLD_USER=restream-srs
OLD_UNIT=restream-srs.service
OLD_LIB=/usr/local/lib/restream-srs-srt
NEW_APP=/opt/bunryu
NEW_DATA=/var/lib/bunryu
NEW_CONF=/etc/bunryu
NEW_USER=bunryu
NEW_LIB=/usr/local/lib/bunryu-srt

log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [migrate] $*"
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

rollback_hint() {
    cat >&2 << EOF

Migration stopped part-way. Nothing was deleted except the old unit file, the
old ld.so and journald snippets, and the old safe.directory entry (all
recreated by the old installer or the steps below). To go back to
the restream-srs layout, undo whichever of these steps already happened:

  systemctl stop srt-bonding-relay.service srs.service bunryu.service 2>/dev/null
  systemctl disable bunryu.service 2>/dev/null; rm -f /etc/systemd/system/bunryu.service
  usermod -l $OLD_USER -d $OLD_APP $NEW_USER; groupmod -n $OLD_USER $NEW_USER
  mv $NEW_APP $OLD_APP; mv $NEW_DATA $OLD_DATA; mv $NEW_CONF $OLD_CONF
  mv $OLD_APP/bunryu.json $OLD_APP/restream.json
  mv $NEW_LIB $OLD_LIB 2>/dev/null
  echo $OLD_LIB > /etc/ld.so.conf.d/restream-srs-srt.conf; ldconfig
  git -C $OLD_APP remote set-url origin https://github.com/live-miracles/bunryu
  git -C $OLD_APP reset --hard 54a7b16   # last commit before the rename
  bash $OLD_APP/scripts/server-install.sh -y

The database backup taken before any change is $OLD_DATA/db.sqlite.pre-bunryu
(or $NEW_DATA/db.sqlite.pre-bunryu once the data directory was moved).
EOF
}

[[ "$(id -u)" -eq 0 ]] || die "run as root (sudo bash $0)"
[[ -d "$OLD_APP" ]] || die "$OLD_APP not found: nothing to migrate"
for path in "$NEW_APP" "$NEW_DATA" "$NEW_CONF"; do
    [[ ! -e "$path" ]] || die "$path already exists; refusing to overwrite it"
done
id "$OLD_USER" &> /dev/null || die "user $OLD_USER not found"
! id "$NEW_USER" &> /dev/null || die "user $NEW_USER already exists"

# Live publishers, as SRS reports them. If SRS is not reachable there is
# nothing live to protect; an answer that cannot be read stops the migration.
live=0
if streams="$(curl -fsSL --max-time 5 http://127.0.0.1:1985/api/v1/streams/ 2> /dev/null)"; then
    live="$(node -e 'try{const d=JSON.parse(process.argv[1]);process.stdout.write(String((d.streams||[]).filter(s=>s.publish&&s.publish.active).length))}catch{process.stdout.write("-1")}' "$streams")"
fi
if [[ "$live" -lt 0 && "$FORCE" != yes ]]; then
    die "could not read the SRS stream list; check for live streams yourself and pass --force"
fi
if [[ "$live" -gt 0 && "$FORCE" != yes ]]; then
    die "SRS reports $live live publisher(s); migrate between events, or pass --force"
fi
log "pre-flight checks passed ($live live publishers)"

trap rollback_hint ERR

log "stopping services"
systemctl stop srt-bonding-relay.service srs.service "$OLD_UNIT"

log "backing up the database"
cp -a "$OLD_DATA/db.sqlite" "$OLD_DATA/db.sqlite.pre-bunryu"

log "removing $OLD_UNIT"
systemctl disable "$OLD_UNIT" 2> /dev/null || true
rm -f "/etc/systemd/system/$OLD_UNIT"

log "moving directories"
mv "$OLD_APP" "$NEW_APP"
mv "$OLD_DATA" "$NEW_DATA"
mv "$OLD_CONF" "$NEW_CONF"
# Keeps dashboard_password; the installer rewrites the paths in it.
mv "$NEW_APP/restream.json" "$NEW_APP/bunryu.json"

log "renaming service account $OLD_USER -> $NEW_USER"
usermod -l "$NEW_USER" -d "$NEW_APP" "$OLD_USER"
groupmod -n "$NEW_USER" "$OLD_USER"

# The installer skips the relay download while its version marker matches, so
# it would not recreate the library directory: move it instead. The new unit
# loads it through LD_LIBRARY_PATH; the old system-wide ld.so registration
# goes away.
if [[ -d "$OLD_LIB" ]]; then
    log "moving relay libraries to $NEW_LIB"
    mv "$OLD_LIB" "$NEW_LIB"
fi
rm -f /etc/ld.so.conf.d/restream-srs-srt.conf
ldconfig

rm -f /etc/systemd/journald.conf.d/restream-srs.conf
git config --system --unset-all safe.directory "^$OLD_APP\$" 2> /dev/null || true
git config --system --add safe.directory "$NEW_APP"

# The moved checkout still holds the old installer, which would recreate the
# old paths: update the code first, then run the new installer.
log "updating $NEW_APP from $REPO_URL"
git -C "$NEW_APP" remote set-url origin "$REPO_URL"
git -C "$NEW_APP" fetch origin
git -C "$NEW_APP" reset --hard '@{u}'

systemctl daemon-reload
log "running the Bunryu installer"
bash "$NEW_APP/scripts/server-install.sh" -y

trap - ERR

log "verifying"
failed=no
for unit in bunryu.service srs.service srt-bonding-relay.service; do
    if systemctl is-active --quiet "$unit"; then
        log "  $unit active"
    else
        log "  $unit NOT active"
        failed=yes
    fi
done
for _ in $(seq 1 30); do
    curl -fsS --max-time 2 http://127.0.0.1:8080/api/ready > /dev/null 2>&1 && break
    sleep 1
done
if curl -fsS --max-time 2 http://127.0.0.1:8080/api/ready > /dev/null 2>&1; then
    log "  /api/ready answers"
else
    log "  /api/ready does NOT answer"
    failed=yes
fi
leftovers="$(grep -rl restream-srs /etc/systemd /etc/ld.so.conf.d "$NEW_CONF" "$NEW_APP/bunryu.json" 2> /dev/null || true)"
if [[ -n "$leftovers" ]]; then
    log "  files still mentioning restream-srs (check them):"
    echo "$leftovers" | sed 's/^/    /'
fi

if [[ "$failed" == yes ]]; then
    log "migration finished with problems; see above and 'journalctl -u bunryu.service'"
    exit 1
fi
log "migration complete. Database backup: $NEW_DATA/db.sqlite.pre-bunryu (delete it once everything checks out)"
