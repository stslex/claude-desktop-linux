#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-rpm.sh
#
# Re-pack the patched ASAR and build an RPM from it.
#
# Env vars:
#   BUILD_DIR        default: /tmp/claude-build
#   OUTPUT_DIR       default: ./output  (relative to repo root)
#   GPG_KEY_ID       optional: sign the RPM with this key ID
#   VERSION_SUFFIX   optional: appended to version in filename/metadata
#                    (e.g. "~dev.20260404.abc1234" for dev channel)
# ---------------------------------------------------------------------------

log() { echo "[build-rpm] $*"; }

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

if ! command -v rpmbuild &>/dev/null; then
    log "ERROR: rpmbuild not found. Install: sudo dnf install rpm-build"
    exit 1
fi

VERSION="$(cat "$BUILD_DIR/VERSION")"
VERSION_SUFFIX="${VERSION_SUFFIX:-}"
FULL_VERSION="${VERSION}${VERSION_SUFFIX}"
ELECTRON_VERSION="${ELECTRON_OVERRIDE:-$(cat "$BUILD_DIR/ELECTRON_VERSION")}"
log "Version      : $FULL_VERSION"
log "Electron     : $ELECTRON_VERSION"

# ---------------------------------------------------------------------------
# Download / cache Electron binary (shared cache with build-appimage.sh)
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
# Use the canonical ASAR packed by build-packages.sh
# ---------------------------------------------------------------------------
ASAR_OUT="$BUILD_DIR/app-patched.asar"
if [[ ! -f "$ASAR_OUT" ]]; then
    log "ERROR: $ASAR_OUT not found. Run build-packages.sh or pack the ASAR first."
    exit 1
fi
log "ASAR         : $ASAR_OUT"

# ---------------------------------------------------------------------------
# Set up the rpmbuild tree
# ---------------------------------------------------------------------------
RPM_ROOT="$BUILD_DIR/rpmbuild"
mkdir -p "$RPM_ROOT"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

log "Copying sources into $RPM_ROOT/SOURCES/ ..."
cp "$ASAR_OUT" "$RPM_ROOT/SOURCES/app-patched.asar"
cp "$REPO_DIR/packaging/AppDir/usr/bin/claude-desktop" "$RPM_ROOT/SOURCES/claude-desktop"
cp "$REPO_DIR/packaging/AppDir/claude-desktop.desktop" "$RPM_ROOT/SOURCES/claude-desktop.desktop"

# Electron tarball — extract zip and re-pack as tar.gz for rpmbuild
log "Creating electron.tar.gz from cached zip..."
ELECTRON_TMP="$BUILD_DIR/electron-rpm-extract"
rm -rf "$ELECTRON_TMP"
mkdir -p "$ELECTRON_TMP"
unzip -q "$ELECTRON_ZIP" -d "$ELECTRON_TMP"
tar -czf "$RPM_ROOT/SOURCES/electron.tar.gz" -C "$ELECTRON_TMP" .
rm -rf "$ELECTRON_TMP"
log "Created electron.tar.gz"

# Write ELECTRON_VERSION file so the launcher can report the required version
echo "$ELECTRON_VERSION" > "$RPM_ROOT/SOURCES/ELECTRON_VERSION"

# Icons tarball — source is packaging/icons/ (written by fetch-and-extract.sh)
ICONS_DIR="$REPO_DIR/packaging/icons"
mkdir -p "$ICONS_DIR"
# If no PNGs were extracted, generate them from the bundled SVG
SVG_ICON="$REPO_DIR/packaging/claude-desktop.svg"
if ! ls "$ICONS_DIR"/claude-*.png &>/dev/null && [[ -f "$SVG_ICON" ]]; then
    log "No PNG icons found — generating from bundled SVG..."
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
fi
log "Creating icons.tar.gz ..."
tar -czf "$RPM_ROOT/SOURCES/icons.tar.gz" -C "$REPO_DIR/packaging" icons/

# SVG icon for scalable resolution support
if [[ -f "$SVG_ICON" ]]; then
    cp "$SVG_ICON" "$RPM_ROOT/SOURCES/claude-desktop.svg"
fi

# Copy spec
cp "$REPO_DIR/packaging/claude-desktop.spec" "$RPM_ROOT/SPECS/claude-desktop.spec"

# ---------------------------------------------------------------------------
# Build RPM
# ---------------------------------------------------------------------------
log "Running rpmbuild $FULL_VERSION ..."

REPACK_NUM="${REPACK_NUM:-0}"
log "Repack       : $REPACK_NUM"

RPMBUILD_ARGS=(
    --define "_topdir $RPM_ROOT"
    --define "_version $FULL_VERSION"
    --define "_repack $REPACK_NUM"
    -bb "$RPM_ROOT/SPECS/claude-desktop.spec"
)

# Conditional GPG signing
if [[ -n "${GPG_KEY_ID:-}" ]]; then
    log "GPG signing with key: $GPG_KEY_ID"
    RPMBUILD_ARGS+=(--define "gpg_sign 1" --define "_gpg_name $GPG_KEY_ID" --sign)
fi

rpmbuild "${RPMBUILD_ARGS[@]}" 2>&1

# ---------------------------------------------------------------------------
# Collect output
# ---------------------------------------------------------------------------
RPM_FILE="$(find "$RPM_ROOT/RPMS" -name "*.rpm" | head -1)"
if [[ -z "$RPM_FILE" ]]; then
    log "ERROR: rpmbuild produced no RPM."
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
DEST_RPM="$OUTPUT_DIR/claude-desktop-${FULL_VERSION}-x86_64.rpm"
cp "$RPM_FILE" "$DEST_RPM"
sha256sum "$DEST_RPM" | awk '{print $1}' > "${DEST_RPM}.sha256"

log "RPM          : $DEST_RPM"
log "SHA256       : $(cat "${DEST_RPM}.sha256")"
log "Done."
