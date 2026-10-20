#!/usr/bin/env bash
# Schema version helper for the installer (see src/db/schema.ts).
#
#   db-schema-version.sh --build   prints SCHEMA_VERSION of this checkout
#   db-schema-version.sh <file>    prints the version stamped in a database
#                                  (0 = never stamped), or nothing when the file
#                                  is not a SQLite database
#
# PRAGMA user_version is the big-endian 32-bit integer at byte 60 of the SQLite
# header. The app never enables WAL, so the header is current even if the app was
# killed. Reading it here needs neither sqlite3 nor the node modules, which an
# update has not rebuilt yet.
set -euo pipefail

case "${1:-}" in
    '')
        echo "Usage: db-schema-version.sh --build | <db-file>" >&2
        exit 2
        ;;
    --build)
        version="$(sed -n 's/^export const SCHEMA_VERSION = \([0-9][0-9]*\);.*/\1/p' "$(dirname "$(readlink -f "$0")")/../src/db/schema.ts")"
        if [[ -z "$version" ]]; then
            echo "ERROR: cannot find SCHEMA_VERSION in src/db/schema.ts" >&2
            exit 1
        fi
        echo "$version"
        ;;
    *)
        head -c 15 "$1" | grep -aqx 'SQLite format 3' || exit 0
        read -r a b c d < <(od -An -tu1 -j60 -N4 "$1")
        echo $(((a << 24) | (b << 16) | (c << 8) | d))
        ;;
esac
