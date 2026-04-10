#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-nix.sh
#
# Build a NixOS-compatible package archive for Claude Desktop Linux.
# Produces a gzip tarball with an FHS-style layout (bin/, lib/, share/)
# that can be consumed via the bundled flake.nix or other Nix packaging steps.
#
# Env vars:
#   BUILD_DIR        default: /tmp/claude-build
#   OUTPUT_DIR       default: ./output  (relative to repo root)
#   VERSION_SUFFIX   optional: appended to version in filename/metadata
#                    (e.g. "~dev.20260404.abc1234" for dev channel)
# ---------------------------------------------------------------------------

log() { echo "[build-nix] $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BUILD_DIR="${BUILD_DIR:-/tmp/claude-build}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_DIR/output}"

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
if [[ ! -f "$BUILD_DIR/VERSION" ]]; then
    log "ERROR: $BUILD_DIR/VERSION not found. Run fetch-and-extract.sh first."
    exit 1
fi

if [[ ! -d "$BUILD_DIR/app-extracted" ]]; then
    log "ERROR: $BUILD_DIR/app-extracted not found. Run inject-stubs.sh and patch-cowork.sh first."
    exit 1
fi

VERSION="$(cat "$BUILD_DIR/VERSION")"
VERSION_SUFFIX="${VERSION_SUFFIX:-}"
FULL_VERSION="${VERSION}${VERSION_SUFFIX}"
ELECTRON_VERSION="${ELECTRON_OVERRIDE:-$(cat "$BUILD_DIR/ELECTRON_VERSION")}"
log "Version      : $FULL_VERSION"
log "Electron     : $ELECTRON_VERSION"

# ---------------------------------------------------------------------------
# Download / cache Electron binary (shared cache with other build scripts)
# ---------------------------------------------------------------------------
ELECTRON_CACHE="$BUILD_DIR/electron-cache"
mkdir -p "$ELECTRON_CACHE"

ELECTRON_ZIP="$ELECTRON_CACHE/electron-v${ELECTRON_VERSION}-linux-x64.zip"
ELECTRON_BASE_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}"

if [[ ! -f "$ELECTRON_ZIP" ]]; then
    log "Fetching Electron SHA256 manifest..."
    SHASUMS="$(curl -fsSL "${ELECTRON_BASE_URL}/SHASUMS256.txt")"
    EXPECTED_SHA="$(echo "$SHASUMS" | grep "electron-v${ELECTRON_VERSION}-linux-x64\.zip$" | awk '{print $1}')"
    if [[ -z "$EXPECTED_SHA" ]]; then
        log "ERROR: Could not find SHA256 for electron-v${ELECTRON_VERSION}-linux-x64.zip"
        exit 1
    fi
    log "Downloading Electron $ELECTRON_VERSION..."
    curl -fL --progress-bar -o "$ELECTRON_ZIP" "${ELECTRON_BASE_URL}/electron-v${ELECTRON_VERSION}-linux-x64.zip"
    ACTUAL_SHA="$(sha256sum "$ELECTRON_ZIP" | awk '{print $1}')"
    if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
        log "ERROR: SHA256 mismatch after download (expected $EXPECTED_SHA, got $ACTUAL_SHA)"
        rm -f "$ELECTRON_ZIP"
        exit 1
    fi
    log "SHA256 verified: $ACTUAL_SHA"
else
    log "Electron zip   : $ELECTRON_ZIP (cached)"
fi

# ---------------------------------------------------------------------------
# Re-pack the patched ASAR
# ---------------------------------------------------------------------------
ASAR_OUT="$BUILD_DIR/app-patched.asar"
if [[ ! -f "$ASAR_OUT" ]]; then
    log "Packing app-patched.asar from $BUILD_DIR/app-extracted ..."
    npx --yes @electron/asar pack "$BUILD_DIR/app-extracted" "$ASAR_OUT"
    log "Packed       : $ASAR_OUT"
else
    log "ASAR         : $ASAR_OUT (already packed)"
fi

# ---------------------------------------------------------------------------
# Assemble Nix package layout
#
# This creates a standalone directory tree matching what the flake.nix
# derivation would produce, so CI can build it without Nix installed.
# NixOS users install via the flake; this tarball is an alternative for
# users who want to manually place the files.
# ---------------------------------------------------------------------------
NIX_ROOT="$BUILD_DIR/nix-root"
rm -rf "$NIX_ROOT"

# App files
install -Dm644 "$ASAR_OUT" "$NIX_ROOT/lib/claude-desktop/app.asar"
echo "$ELECTRON_VERSION" > "$BUILD_DIR/nix-electron-version"
install -Dm644 "$BUILD_DIR/nix-electron-version" "$NIX_ROOT/lib/claude-desktop/ELECTRON_VERSION"

# Bundled Electron
ELECTRON_DIR="$NIX_ROOT/lib/electron"
mkdir -p "$ELECTRON_DIR"
log "Extracting Electron into nix tree..."
unzip -q "$ELECTRON_ZIP" -d "$ELECTRON_DIR"
chmod 755 "$ELECTRON_DIR/electron"

# Launcher wrapper
install -Dm755 "$REPO_DIR/packaging/AppDir/usr/bin/claude-desktop" \
    "$NIX_ROOT/bin/claude-desktop"

# Desktop entry
install -Dm644 "$REPO_DIR/packaging/AppDir/claude-desktop.desktop" \
    "$NIX_ROOT/share/applications/claude-desktop.desktop"

# Icons
ICONS_DIR="$REPO_DIR/packaging/icons"
if [[ -d "$ICONS_DIR" ]] && ls "$ICONS_DIR"/claude-*.png &>/dev/null; then
    log "Installing icons..."
    for PNG in "$ICONS_DIR"/claude-*.png; do
        N="$(basename "$PNG" | grep -oP '(?<=claude-)\d+(?=\.png)' || true)"
        [[ -z "$N" ]] && continue
        install -Dm644 "$PNG" \
            "$NIX_ROOT/share/icons/hicolor/${N}x${N}/apps/claude-desktop.png"
    done
else
    log "WARNING: No PNG icons found in $ICONS_DIR — generating from bundled SVG..."
    SVG_ICON="$REPO_DIR/packaging/claude-desktop.svg"
    if [[ -f "$SVG_ICON" ]]; then
        mkdir -p "$ICONS_DIR"
        if command -v rsvg-convert &>/dev/null; then
            for SIZE in 16 32 48 64 128 256 512; do
                rsvg-convert -w "$SIZE" -h "$SIZE" "$SVG_ICON" \
                    -o "$ICONS_DIR/claude-${SIZE}.png" 2>/dev/null || true
            done
        elif command -v convert &>/dev/null; then
            for SIZE in 16 32 48 64 128 256 512; do
                convert -background none "$SVG_ICON" \
                    -resize "${SIZE}x${SIZE}" "$ICONS_DIR/claude-${SIZE}.png" 2>/dev/null || true
            done
        fi
        for PNG in "$ICONS_DIR"/claude-*.png; do
            [ -f "$PNG" ] || continue
            N="$(basename "$PNG" | grep -oP '(?<=claude-)\d+(?=\.png)' || true)"
            [[ -z "$N" ]] && continue
            install -Dm644 "$PNG" \
                "$NIX_ROOT/share/icons/hicolor/${N}x${N}/apps/claude-desktop.png"
        done
    fi
fi

# Always install SVG icon for scalable resolution support
SVG_ICON="$REPO_DIR/packaging/claude-desktop.svg"
if [[ -f "$SVG_ICON" ]]; then
    install -Dm644 "$SVG_ICON" \
        "$NIX_ROOT/share/icons/hicolor/scalable/apps/claude-desktop.svg"
fi

# Write version metadata
echo "$FULL_VERSION" > "$NIX_ROOT/lib/claude-desktop/VERSION"

# ---------------------------------------------------------------------------
# Build tarball
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
DEST_TAR="$OUTPUT_DIR/claude-desktop-${FULL_VERSION}-x86_64-nix.tar.gz"

log "Building nix tarball..."
tar -czf "$DEST_TAR" -C "$NIX_ROOT" .

sha256sum "$DEST_TAR" | awk '{print $1}' > "${DEST_TAR}.sha256"

log "Nix tarball  : $DEST_TAR"
log "SHA256       : $(cat "${DEST_TAR}.sha256")"
log "Done."
