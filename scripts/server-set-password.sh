#!/usr/bin/env bash
# Set the dashboard password, for example when it has been forgotten. Asks for the
# new password (or takes BUNRYU_DASHBOARD_PASSWORD), stores only its hash in the
# database, signs out every session and restarts the dashboard service.
#
# Usage:
#   sudo bash /opt/bunryu/scripts/server-set-password.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: run as root (sudo bash scripts/server-set-password.sh)" >&2
    exit 1
fi

APP_DIR="${APP_DIR:-/opt/bunryu}"
SERVICE_USER=bunryu

# As the service user, so the database keeps its owner. The variables reach node
# through the environment, never its command line.
cd "$APP_DIR"
BUNRYU_CONFIG="${BUNRYU_CONFIG:-/etc/bunryu/bunryu.json}" \
    runuser -u "$SERVICE_USER" -- node "$APP_DIR/dist/setPassword.js"
# The running server keeps its sessions in memory; a restart drops them.
systemctl try-restart bunryu.service
echo "Log in with the new password."
