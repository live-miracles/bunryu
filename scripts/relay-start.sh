#!/usr/bin/env bash
# Entry point for `npm run relay`: runs the local Goryu built by
# scripts/dev-server-install.sh. Does not build anything itself - run
# `npm run dev-install` first if the binary isn't there yet, or
# `npm run relay:update` to pull relay source changes and rebuild.
#
# Usage:
#   bash scripts/relay-start.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_PATH="$REPO_DIR/goryu.json"
BIN="$REPO_DIR/objs/goryu"
LIB_DIR="$REPO_DIR/objs/lib"

if [[ ! -x "$BIN" ]]; then
    echo "ERROR: relay binary not found at $BIN" >&2
    echo "Run: npm run dev-install" >&2
    exit 1
fi

LD_LIBRARY_PATH="$LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$BIN" "$CONFIG_PATH"
