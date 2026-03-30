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

if [[ ! -f "$BUILD_DIR/app-patched.asar" ]]; then
    log "ERROR: $BUILD_DIR/app-patched.asar not found. Run build-packages.sh first."
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
cp "$BUILD_DIR/app-patched.asar" "$APPDIR/usr/lib/claude-desktop/app.asar"
if [[ -d "$BUILD_DIR/app-patched.asar.unpacked" ]]; then
    cp -a "$BUILD_DIR/app-patched.asar.unpacked" "$APPDIR/usr/lib/claude-desktop/app.asar.unpacked"
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
    LARGEST_ICON="$(find "$ICONS_DIR" -maxdepth 1 -name '*.png' | sort -V | tail -1)"
    cp "$LARGEST_ICON" "$APPDIR/claude-desktop.png"

    # Install into hicolor theme tree for desktop environments.
    # Icons are named claude-<N>.png (e.g. claude-256.png); convert to <N>x<N>
    # directory name required by the freedesktop hicolor spec.
    for PNG in "$ICONS_DIR"/*.png; do
        N="$(basename "$PNG" | grep -oP '(?<=claude-)\d+(?=\.png)' || true)"
        [[ -z "$N" ]] && continue
        ICON_DEST="$APPDIR/usr/share/icons/hicolor/${N}x${N}/apps"
        mkdir -p "$ICON_DEST"
        cp "$PNG" "$ICON_DEST/claude-desktop.png"
    done
    # Also install the SVG icon for scalable resolution support
    SVG_ICON="$REPO_DIR/packaging/claude-desktop.svg"
    if [[ -f "$SVG_ICON" ]]; then
        mkdir -p "$APPDIR/usr/share/icons/hicolor/scalable/apps"
        cp "$SVG_ICON" "$APPDIR/usr/share/icons/hicolor/scalable/apps/claude-desktop.svg"
    fi
else
    log "WARNING: No PNG icons found in $ICONS_DIR — using bundled SVG icon."
    # Generate PNGs from the bundled SVG if rsvg-convert or convert is available.
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
        # Re-check: install any PNGs that were generated
        if ls "$ICONS_DIR"/*.png &>/dev/null; then
            LARGEST_ICON="$(find "$ICONS_DIR" -maxdepth 1 -name '*.png' | sort -V | tail -1)"
            cp "$LARGEST_ICON" "$APPDIR/claude-desktop.png"
            for PNG in "$ICONS_DIR"/*.png; do
                N="$(basename "$PNG" | grep -oP '(?<=claude-)\d+(?=\.png)' || true)"
                [[ -z "$N" ]] && continue
                ICON_DEST="$APPDIR/usr/share/icons/hicolor/${N}x${N}/apps"
                mkdir -p "$ICON_DEST"
                cp "$PNG" "$ICON_DEST/claude-desktop.png"
            done
        fi
    fi
    # Install the SVG into the scalable icon directory
    if [[ -f "$SVG_ICON" ]]; then
        mkdir -p "$APPDIR/usr/share/icons/hicolor/scalable/apps"
        cp "$SVG_ICON" "$APPDIR/usr/share/icons/hicolor/scalable/apps/claude-desktop.svg"
    fi
    # Fallback: appimagetool requires a root icon file
    if [[ ! -f "$APPDIR/claude-desktop.png" ]]; then
        if [[ -f "$SVG_ICON" ]]; then
            cp "$SVG_ICON" "$APPDIR/claude-desktop.svg"
        else
            printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$APPDIR/claude-desktop.png"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Build AppImage
# ---------------------------------------------------------------------------
APPIMAGE_OUT="$OUTPUT_DIR/claude-desktop-${APP_VERSION}-x86_64.AppImage"

# Embed zsync update info so AppImageUpdate can fetch the latest release.
# Pattern matches the repack-N filename used in GitHub releases.
REPO="${GITHUB_REPOSITORY:-stslex/claude-desktop-linux}"
REPO_USER="${REPO%%/*}"
REPO_NAME="${REPO##*/}"
UPDATE_INFO="gh-releases-zsync|${REPO_USER}|${REPO_NAME}|latest|claude-desktop-*-x86_64.AppImage.zsync"

log "Running appimagetool ..."
ARCH=x86_64 "$APPIMAGETOOL" \
    --updateinformation "$UPDATE_INFO" \
    "$APPDIR" "$APPIMAGE_OUT" 2>&1

chmod +x "$APPIMAGE_OUT"
sha256sum "$APPIMAGE_OUT" | awk '{print $1}' > "${APPIMAGE_OUT}.sha256"

# Generate zsync file for delta updates.
# zsyncmake is optional — skip gracefully if not installed.
ZSYNC_OUT="${APPIMAGE_OUT}.zsync"
if command -v zsyncmake &>/dev/null; then
    log "Generating zsync delta file..."
    zsyncmake -u "$(basename "$APPIMAGE_OUT")" -o "$ZSYNC_OUT" "$APPIMAGE_OUT"
    log "zsync    : $ZSYNC_OUT"
else
    log "WARNING: zsyncmake not found — skipping .zsync generation (install zsync package)."
fi

log "AppImage : $APPIMAGE_OUT"
log "SHA256   : $(cat "${APPIMAGE_OUT}.sha256")"
log "Done."
