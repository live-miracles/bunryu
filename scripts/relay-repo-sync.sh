#!/usr/bin/env bash
# Clone the goryu source repo next to this one if it isn't there
# yet, then fast-forward it to the latest master (skipped if it has local
# changes). Used by dev-server-install.sh's first-time setup and by
# `npm run relay:update`.
#
# Usage:
#   bash scripts/relay-repo-sync.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELAY_REPO_DIR="$REPO_DIR/../goryu"
RELAY_REPO_URL="https://github.com/live-miracles/goryu.git"

if [[ -d "$RELAY_REPO_DIR/.git" ]]; then
    echo "Relay repo already present at $RELAY_REPO_DIR"
elif [[ -e "$RELAY_REPO_DIR" ]]; then
    echo "ERROR: relay repo path exists but is not a git repo: $RELAY_REPO_DIR" >&2
    exit 1
else
    if ! command -v git &> /dev/null; then
        echo "ERROR: git is required to clone $RELAY_REPO_URL" >&2
        exit 1
    fi
    echo "Cloning relay repo into $RELAY_REPO_DIR..."
    git clone "$RELAY_REPO_URL" "$RELAY_REPO_DIR"
fi

if [[ -n "$(git -C "$RELAY_REPO_DIR" status --short)" ]]; then
    echo "Relay repo has local changes; skipping auto-update."
else
    echo "Updating relay repo..."
    git -C "$RELAY_REPO_DIR" fetch --tags origin
    git -C "$RELAY_REPO_DIR" pull --ff-only origin master
fi
