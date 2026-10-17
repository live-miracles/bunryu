#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELAY_REPO_DIR="$REPO_DIR/../goryu"
OUT_BIN="$REPO_DIR/objs/goryu"
OUT_LIB_DIR="$REPO_DIR/objs/lib"
RELAY_OUT_BIN="$RELAY_REPO_DIR/objs/goryu"
RELAY_OUT_LIB_DIR="$RELAY_REPO_DIR/objs/lib"

if [[ ! -d "$RELAY_REPO_DIR/.git" ]]; then
    echo "ERROR: relay repo not found at $RELAY_REPO_DIR" >&2
    echo "Run: bash $REPO_DIR/scripts/dev-server-install.sh" >&2
    exit 1
fi

bash "$RELAY_REPO_DIR/scripts/build-local.sh"

install -d -m 755 "$(dirname "$OUT_BIN")" "$OUT_LIB_DIR"
install -m 755 "$RELAY_OUT_BIN" "$OUT_BIN"
if [[ -d "$RELAY_OUT_LIB_DIR" ]]; then
    find "$RELAY_OUT_LIB_DIR" -maxdepth 1 -type f -exec install -m 755 {} "$OUT_LIB_DIR"/ \;
fi

echo "Installed relay into this repo: $OUT_BIN"
