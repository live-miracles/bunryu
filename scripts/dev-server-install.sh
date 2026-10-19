#!/usr/bin/env bash
# Install SRS locally inside the repo for development. Linux (Ubuntu) only,
# like the rest of this repo's scripts/CI - the SRS build below is a CentOS7
# x86_64 binary regardless.
#
# Usage:
#   bash scripts/dev-server-install.sh
set -euo pipefail

if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "ERROR: this installer only supports x86_64 (got $(uname -m)); the SRS build it downloads is x86_64-only." >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRS_OUT="$REPO_DIR/objs/srs"
FFMPEG_OUT="$REPO_DIR/objs/ffmpeg"
FFPROBE_OUT="$REPO_DIR/objs/ffprobe"

SRS_VERSION=6.0-r2
SRS_RELEASE_TAG="v${SRS_VERSION}"
SRS_FILENAME="SRS-CentOS7-x86_64-${SRS_VERSION}.zip"
SRS_SHA256="8b654eccaf2d984dd87cb4f6c8663748922c1cb529de65f6d895ac3daade89a2"
SRS_URL="https://github.com/ossrs/srs/releases/download/${SRS_RELEASE_TAG}/${SRS_FILENAME}"

# Same pinned FFmpeg build scripts/server-install.sh installs to
# /usr/local/bin in production, installed here into the repo instead so
# `npm run dev` doesn't fall back to the system package (Ubuntu ships
# FFmpeg 8, which has been observed to hang pulling from a local SRS
# instance — see bunryu.json's ffmpeg_path/ffprobe_path).
#
# Mirrored into our own releases since BtbN prunes autobuild tags after ~2 years.
# To bump: grab a newer linux64-gpl build from BtbN/FFmpeg-Builds/releases, upload
# it via `gh release create ffmpeg-n<ver> <file> --repo live-miracles/bunryu`,
# then update these values (and scripts/server-install.sh) to match.
FFMPEG_VERSION=7.1
FFMPEG_BUILD_TAG="ffmpeg-n7.1.4-7-gadcf20da26"
FFMPEG_FILENAME="ffmpeg-n7.1.4-7-gadcf20da26-linux64-gpl-7.1.tar.xz"
FFMPEG_SHA256="ce46c711e3ff79ae1e9318bf7daa54c77f41ce37b71010c44f4a0b38f1d7a29f"
FFMPEG_URL="https://github.com/live-miracles/bunryu/releases/download/${FFMPEG_BUILD_TAG}/${FFMPEG_FILENAME}"

# Verify a downloaded file against an expected SHA256 (sha256sum on Linux,
# shasum on macOS). An empty expected hash skips the check.
verify_sha256() {
    local file="$1" expected="$2"
    if [[ -z "$expected" ]]; then
        echo "Checksum: skipped (custom version/URL)"
        return
    fi
    local actual
    if command -v sha256sum &> /dev/null; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    else
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    fi
    if [[ "$actual" != "$expected" ]]; then
        echo "ERROR: checksum mismatch for $(basename "$file")" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        exit 1
    fi
    echo "Checksum OK: $(basename "$file")"
}

mkdir -p "$REPO_DIR/objs"

SRS_VERSION_MARKER="$REPO_DIR/objs/.srs-version"
if [[ -n "${SRS_LOCAL_BIN:-}" ]]; then
    # Install from a local SRS binary.
    if [[ ! -x "$SRS_LOCAL_BIN" ]]; then
        echo "ERROR: SRS_LOCAL_BIN=$SRS_LOCAL_BIN is not executable" >&2
        exit 1
    fi
    install -m 755 "$SRS_LOCAL_BIN" "$SRS_OUT"
    echo "local-${SRS_VERSION}" > "$SRS_VERSION_MARKER"
    echo "Installed from local build: $("$SRS_OUT" -v 2>&1 | head -1)"
fi

if ! command -v curl &> /dev/null; then
    echo "ERROR: curl is required" >&2
    exit 1
fi
if ! command -v unzip &> /dev/null; then
    echo "ERROR: unzip is required (apt install unzip)" >&2
    exit 1
fi
if ! command -v tar &> /dev/null; then
    echo "ERROR: tar is required" >&2
    exit 1
fi
if ! command -v xz &> /dev/null; then
    echo "ERROR: xz is required (apt install xz-utils)" >&2
    exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FFMPEG_VERSION_MARKER="$REPO_DIR/objs/.ffmpeg-version"
FFMPEG_PIN="${FFMPEG_BUILD_TAG}/${FFMPEG_FILENAME}"
if [[ -x "$FFMPEG_OUT" && -x "$FFPROBE_OUT" && -f "$FFMPEG_VERSION_MARKER" && "$(cat "$FFMPEG_VERSION_MARKER")" == "$FFMPEG_PIN" ]]; then
    echo "FFmpeg $FFMPEG_VERSION already installed at $FFMPEG_OUT ($FFMPEG_PIN)"
else
    echo "Downloading FFmpeg $FFMPEG_VERSION ($FFMPEG_PIN)..."
    curl -fsSL "$FFMPEG_URL" -o "$WORK/$FFMPEG_FILENAME"

    verify_sha256 "$WORK/$FFMPEG_FILENAME" "$FFMPEG_SHA256"

    tar -xJf "$WORK/$FFMPEG_FILENAME" -C "$WORK"
    FFMPEG_DIR="$(find "$WORK" -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)"
    if [[ -z "$FFMPEG_DIR" || ! -x "$FFMPEG_DIR/bin/ffmpeg" || ! -x "$FFMPEG_DIR/bin/ffprobe" ]]; then
        echo "ERROR: could not find ffmpeg/ffprobe binaries in $FFMPEG_FILENAME" >&2
        exit 1
    fi
    install -m 755 "$FFMPEG_DIR/bin/ffmpeg" "$FFMPEG_OUT"
    install -m 755 "$FFMPEG_DIR/bin/ffprobe" "$FFPROBE_OUT"
    echo "$FFMPEG_PIN" > "$FFMPEG_VERSION_MARKER"
    echo "Installed: $("$FFMPEG_OUT" -version 2>&1 | head -1) ($FFMPEG_PIN)"
fi

if [[ -z "${SRS_LOCAL_BIN:-}" ]]; then
    if [[ -x "$SRS_OUT" && -f "$SRS_VERSION_MARKER" && "$(cat "$SRS_VERSION_MARKER")" == "$SRS_RELEASE_TAG" ]]; then
        echo "SRS $SRS_VERSION ($SRS_RELEASE_TAG) already installed at $SRS_OUT"
    else
        echo "Downloading SRS $SRS_VERSION ($SRS_RELEASE_TAG)..."
        curl -fsSL "$SRS_URL" -o "$WORK/$SRS_FILENAME"

        verify_sha256 "$WORK/$SRS_FILENAME" "$SRS_SHA256"

        unzip -q "$WORK/$SRS_FILENAME" -d "$WORK/srs"
        SRS_BIN="$(find "$WORK/srs" -type f -path '*/usr/local/srs/objs/srs' | head -1)"
        if [[ -z "$SRS_BIN" ]]; then
            echo "ERROR: could not find srs binary in $SRS_FILENAME" >&2
            exit 1
        fi
        install -m 755 "$SRS_BIN" "$SRS_OUT"
        echo "$SRS_RELEASE_TAG" > "$SRS_VERSION_MARKER"
        echo "Installed: $("$SRS_OUT" -v 2>&1 | head -1) ($SRS_RELEASE_TAG)"
    fi
fi

bash "$REPO_DIR/scripts/goryu-repo-sync.sh"
bash "$REPO_DIR/scripts/build-goryu-local.sh"

echo ""
echo "Run SRS:  npm run srs"
echo "Run app:  npm run dev"
echo "Run Goryu: npm run goryu"
