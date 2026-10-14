#!/usr/bin/env bash
# Reset the dashboard password to the dashboard_password value in bunryu.json
# (or 'admin' if that field is absent).
# Run this if you have forgotten the password.
#
# Usage:
#   sudo bash /opt/bunryu/scripts/server-reset-password.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: run as root (sudo bash scripts/server-reset-password.sh)" >&2
    exit 1
fi

APP_DIR="${APP_DIR:-/opt/bunryu}"
CONFIG_PATH="$APP_DIR/bunryu.json"

# Run from the app dir so Node resolves better-sqlite3 from its node_modules
# (module resolution is relative to cwd, not this script's location).
cd "$APP_DIR"
node -e "const fs=require('fs'); const path=require('path'); const config=JSON.parse(fs.readFileSync('bunryu.json','utf8')); const dbPath=path.isAbsolute(config.database_path) ? config.database_path : path.resolve(process.cwd(), config.database_path); const db=require('better-sqlite3')(dbPath); db.prepare(\"DELETE FROM settings WHERE key='dashboardPasswordHash'\").run(); db.prepare(\"DELETE FROM sessions\").run()"
systemctl restart bunryu.service

echo "Password reset to dashboard_password from $CONFIG_PATH ('admin' if unset)."
echo "All existing dashboard sessions were signed out."
echo "Change it in Settings after logging in."
