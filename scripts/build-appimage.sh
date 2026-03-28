#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-appimage.sh
#
# Assemble a self-contained AppImage for Claude Desktop Linux.
# Bundles the exact Electron version detected from the ASAR.
#
# Env vars:
#   BUILD_DIR           default: /tmp/claude-build
#   OUTPUT_DIR          default: ./output  (relative to repo root)
#   ELECTRON_OVERRIDE   force a specific Electron version (e.g. 37.0.0)
# ---------------------------------------------------------------------------

log() { echo "[build-appimage] $*"; }

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

if [[ ! -f "$BUILD_DIR/app.asar" ]]; then
    log "ERROR: $BUILD_DIR/app.asar not found. Run patch-cowork.sh first."
    exit 1
fi

if [[ ! -f "$BUILD_DIR/ELECTRON_VERSION" ]]; then
    log "ERROR: $BUILD_DIR/ELECTRON_VERSION not found. Run fetch-and-extract.sh first."
    exit 1
fi

APP_VERSION="$(cat "$BUILD_DIR/VERSION")"
ELECTRON_VERSION="${ELECTRON_OVERRIDE:-$(cat "$BUILD_DIR/ELECTRON_VERSION")}"

log "Claude Desktop : $APP_VERSION"
log "Electron       : $ELECTRON_VERSION"

mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Locate or download appimagetool
# ---------------------------------------------------------------------------
TOOLS_DIR="$BUILD_DIR/tools"
mkdir -p "$TOOLS_DIR"

if command -v appimagetool &>/dev/null; then
    APPIMAGETOOL="$(command -v appimagetool)"
    log "appimagetool   : $APPIMAGETOOL (system)"
else
    APPIMAGETOOL="$TOOLS_DIR/appimagetool"
    if [[ ! -x "$APPIMAGETOOL" ]]; then
        log "Downloading appimagetool ..."
        APPIMAGETOOL_URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
        curl -fL --progress-bar -o "$APPIMAGETOOL" "$APPIMAGETOOL_URL"
        chmod +x "$APPIMAGETOOL"
        log "appimagetool   : $APPIMAGETOOL (downloaded)"
    else
        log "appimagetool   : $APPIMAGETOOL (cached)"
    fi
fi

# ---------------------------------------------------------------------------
# Download + cache Electron binary (with SHA256 verification)
# ---------------------------------------------------------------------------
ELECTRON_CACHE="$BUILD_DIR/electron-cache"
mkdir -p "$ELECTRON_CACHE"

ELECTRON_ZIP="$ELECTRON_CACHE/electron-v${ELECTRON_VERSION}-linux-x64.zip"
ELECTRON_BASE_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}"
ELECTRON_ZIP_URL="$ELECTRON_BASE_URL/electron-v${ELECTRON_VERSION}-linux-x64.zip"
ELECTRON_SHASUMS_URL="$ELECTRON_BASE_URL/SHASUMS256.txt"

# Fetch expected SHA from the release's SHASUMS256.txt
log "Fetching Electron SHA256 manifest ..."
SHASUMS="$(curl -fsSL "$ELECTRON_SHASUMS_URL")"
EXPECTED_SHA="$(echo "$SHASUMS" | grep "electron-v${ELECTRON_VERSION}-linux-x64\.zip$" | awk '{print $1}')"

if [[ -z "$EXPECTED_SHA" ]]; then
    log "ERROR: Could not find SHA256 for electron-v${ELECTRON_VERSION}-linux-x64.zip in release manifest."
    exit 1
fi
log "Expected SHA256: $EXPECTED_SHA"

# Cache hit: skip download if file exists and SHA matches
if [[ -f "$ELECTRON_ZIP" ]]; then
    CACHED_SHA="$(sha256sum "$ELECTRON_ZIP" | awk '{print $1}')"
    if [[ "$CACHED_SHA" == "$EXPECTED_SHA" ]]; then
        log "Electron zip   : $ELECTRON_ZIP (cached, SHA OK)"
    else
        log "Cached zip SHA mismatch ($CACHED_SHA) — re-downloading ..."
        rm -f "$ELECTRON_ZIP"
    fi
fi

if [[ ! -f "$ELECTRON_ZIP" ]]; then
    log "Downloading Electron $ELECTRON_VERSION ..."
    curl -fL --progress-bar -o "$ELECTRON_ZIP" "$ELECTRON_ZIP_URL"

    ACTUAL_SHA="$(sha256sum "$ELECTRON_ZIP" | awk '{print $1}')"
    if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
        log "ERROR: SHA256 mismatch after download."
        log "  Expected : $EXPECTED_SHA"
        log "  Got      : $ACTUAL_SHA"
        rm -f "$ELECTRON_ZIP"
        exit 1
    fi
    log "SHA256 verified: $ACTUAL_SHA"
fi

# ---------------------------------------------------------------------------
# Assemble AppDir
# ---------------------------------------------------------------------------
APPDIR="$BUILD_DIR/AppDir"
rm -rf "$APPDIR"
cp -a "$REPO_DIR/packaging/AppDir/." "$APPDIR/"

# App ASAR
mkdir -p "$APPDIR/usr/lib/claude-desktop"
cp "$BUILD_DIR/app.asar" "$APPDIR/usr/lib/claude-desktop/"
if [[ -d "$BUILD_DIR/app.asar.unpacked" ]]; then
    cp -a "$BUILD_DIR/app.asar.unpacked" "$APPDIR/usr/lib/claude-desktop/"
fi

# Bundled Electron
ELECTRON_DIR="$APPDIR/usr/lib/electron"
mkdir -p "$ELECTRON_DIR"
log "Extracting Electron into AppDir ..."
unzip -q "$ELECTRON_ZIP" -d "$ELECTRON_DIR"

# Icons from packaging/icons/
ICONS_DIR="$REPO_DIR/packaging/icons"
if [[ -d "$ICONS_DIR" ]] && ls "$ICONS_DIR"/*.png &>/dev/null; then
    log "Installing icons from $ICONS_DIR ..."

    # Largest PNG becomes the AppImage root icon (required by appimagetool)
    LARGEST_ICON="$(ls "$ICONS_DIR"/*.png | sort -V | tail -1)"
    cp "$LARGEST_ICON" "$APPDIR/claude-desktop.png"

    # Install into hicolor theme tree for desktop environments
    for PNG in "$ICONS_DIR"/*.png; do
        SIZE="$(basename "$PNG" | grep -oP '\d+x\d+' | head -1 || true)"
        [[ -z "$SIZE" ]] && continue
        ICON_DEST="$APPDIR/usr/share/icons/hicolor/$SIZE/apps"
        mkdir -p "$ICON_DEST"
        cp "$PNG" "$ICON_DEST/claude-desktop.png"
    done
else
    log "WARNING: No PNG icons found in $ICONS_DIR — generating placeholder icon."
    # appimagetool requires an icon file; generate a minimal 256x256 placeholder.
    if command -v convert &>/dev/null; then
        convert -size 256x256 xc:'#d97706' -fill white -gravity center \
            -pointsize 120 -annotate 0 'C' "$APPDIR/claude-desktop.png" 2>/dev/null || true
    fi
    # Fallback: 1x1 transparent PNG if convert is unavailable or failed
    if [[ ! -f "$APPDIR/claude-desktop.png" ]]; then
        printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$APPDIR/claude-desktop.png"
    fi
fi

# ---------------------------------------------------------------------------
# Build AppImage
# ---------------------------------------------------------------------------
APPIMAGE_OUT="$OUTPUT_DIR/claude-desktop-${APP_VERSION}-x86_64.AppImage"
log "Running appimagetool ..."
ARCH=x86_64 "$APPIMAGETOOL" "$APPDIR" "$APPIMAGE_OUT" 2>&1

chmod +x "$APPIMAGE_OUT"
sha256sum "$APPIMAGE_OUT" | awk '{print $1}' > "${APPIMAGE_OUT}.sha256"

log "AppImage : $APPIMAGE_OUT"
log "SHA256   : $(cat "${APPIMAGE_OUT}.sha256")"
log "Done."
