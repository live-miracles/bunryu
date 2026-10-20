#!/usr/bin/env bash
# Reset the dashboard password to the dashboard_password value in
# /etc/bunryu/bunryu.json. Run this if you have forgotten the password: set
# dashboard_password in that file first, then run this script.
#
# Usage:
#   sudo bash /opt/bunryu/scripts/server-reset-password.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: run as root (sudo bash scripts/server-reset-password.sh)" >&2
    exit 1
fi

APP_DIR="${APP_DIR:-/opt/bunryu}"
CONFIG_PATH="${BUNRYU_CONFIG:-/etc/bunryu/bunryu.json}"

# The dashboard reseeds from this value on restart. With none it would fall back
# to the public default 'admin', so refuse instead.
if ! node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.exit(typeof c.dashboard_password==='string' && c.dashboard_password!=='' ? 0 : 1)" "$CONFIG_PATH" 2> /dev/null; then
    echo "ERROR: no dashboard_password in $CONFIG_PATH. Add one, for example" >&2
    echo "  \"dashboard_password\": \"choose-a-long-password\"" >&2
    echo "and run this script again." >&2
    exit 1
fi

# Run from the app dir so Node resolves better-sqlite3 from its node_modules
# (module resolution is relative to cwd, not this script's location).
cd "$APP_DIR"
node -e "const fs=require('fs'); const path=require('path'); const config=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const dbPath=path.isAbsolute(config.database_path) ? config.database_path : path.resolve(path.dirname(process.argv[1]), config.database_path); const db=require('better-sqlite3')(dbPath); db.prepare(\"DELETE FROM settings WHERE key='dashboardPasswordHash'\").run(); db.prepare(\"DELETE FROM sessions\").run()" "$CONFIG_PATH"
systemctl restart bunryu.service

echo "Password reset to dashboard_password from $CONFIG_PATH."
echo "All existing dashboard sessions were signed out."
echo "Change it in Settings after logging in."
