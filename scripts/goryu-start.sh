#!/usr/bin/env bash
# Entry point for `npm run goryu`: runs the local Goryu built by
# scripts/dev-server-install.sh. Does not build anything itself - run
# `npm run goryu:build` first if the binary isn't there yet (or `npm run
# dev-install` on a fresh checkout without ../goryu), or `npm run goryu:update`
# to pull Goryu source changes and rebuild.
#
# Usage:
#   bash scripts/goryu-start.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_PATH="$REPO_DIR/goryu.json"
BIN="$REPO_DIR/objs/goryu"
LIB_DIR="$REPO_DIR/objs/lib"

if [[ ! -x "$BIN" ]]; then
    echo "ERROR: Goryu is not built yet (no binary at $BIN)." >&2
    echo "Build it first with: npm run goryu:build" >&2
    echo "(on a fresh checkout without ../goryu, run: npm run dev-install)" >&2
    exit 1
fi

LD_LIBRARY_PATH="$LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$BIN" "$CONFIG_PATH"
