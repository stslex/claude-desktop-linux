#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-packages.sh
#
# Orchestrator: re-pack the patched ASAR, then build RPM, DEB, and AppImage.
#
# Env vars:
#   BUILD_DIR        default: /tmp/claude-build
#   OUTPUT_DIR       default: ./output  (relative to repo root)
#   KEEP_BUILD_DIR   set to 1 to preserve BUILD_DIR after the run
# ---------------------------------------------------------------------------

log() { echo "[build-packages] $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BUILD_DIR="${BUILD_DIR:-/tmp/claude-build}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_DIR/output}"

# ---------------------------------------------------------------------------
# Cleanup trap — removed unless KEEP_BUILD_DIR=1
# ---------------------------------------------------------------------------
# shellcheck disable=SC2329  # invoked via trap EXIT below
cleanup() {
    if [[ "${KEEP_BUILD_DIR:-}" != "1" ]]; then
        log "Cleaning up $BUILD_DIR ..."
        rm -rf "$BUILD_DIR"
    fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
if [[ ! -d "$BUILD_DIR/app-extracted" ]]; then
    log "ERROR: $BUILD_DIR/app-extracted not found."
    log "Run inject-stubs.sh and patch-cowork.sh first."
    exit 1
fi

if [[ ! -f "$BUILD_DIR/VERSION" ]]; then
    log "ERROR: $BUILD_DIR/VERSION not found. Run fetch-and-extract.sh first."
    exit 1
fi

APP_VERSION="$(cat "$BUILD_DIR/VERSION")"
log "Claude Desktop : $APP_VERSION"

# ---------------------------------------------------------------------------
# Re-pack the patched app into app-patched.asar
# ---------------------------------------------------------------------------
log "Packing $BUILD_DIR/app-patched.asar ..."
npx --yes @electron/asar pack "$BUILD_DIR/app-extracted" "$BUILD_DIR/app-patched.asar"
log "Packed: $BUILD_DIR/app-patched.asar"

mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Build RPM — continue on failure (rpmbuild may not be available)
# ---------------------------------------------------------------------------
log "--- RPM ---"
RPM_OK=false
if BUILD_DIR="$BUILD_DIR" OUTPUT_DIR="$OUTPUT_DIR" REPACK_NUM="${REPACK_NUM:-0}" "$SCRIPT_DIR/build-rpm.sh"; then
    RPM_OK=true
    log "RPM build succeeded."
else
    log "RPM build failed (rpmbuild may not be available — skipping)."
fi

# ---------------------------------------------------------------------------
# Build DEB — continue on failure (dpkg-deb may not be available)
# ---------------------------------------------------------------------------
log "--- DEB ---"
DEB_OK=false
if BUILD_DIR="$BUILD_DIR" OUTPUT_DIR="$OUTPUT_DIR" "$SCRIPT_DIR/build-deb.sh"; then
    DEB_OK=true
    log "DEB build succeeded."
else
    log "DEB build failed (dpkg-deb may not be available — skipping)."
fi

# ---------------------------------------------------------------------------
# Build AppImage
# ---------------------------------------------------------------------------
log "--- AppImage ---"
APPIMAGE_OK=false
if BUILD_DIR="$BUILD_DIR" OUTPUT_DIR="$OUTPUT_DIR" "$SCRIPT_DIR/build-appimage.sh"; then
    APPIMAGE_OK=true
    log "AppImage build succeeded."
else
    log "AppImage build failed."
fi

# ---------------------------------------------------------------------------
# List output with sizes
# ---------------------------------------------------------------------------
log ""
log "Output files:"
ls -lh "$OUTPUT_DIR"/claude-desktop-* 2>/dev/null || log "(none)"

# ---------------------------------------------------------------------------
# Verify .sha256 files exist and match their respective packages
# ---------------------------------------------------------------------------
verify_sha256() {
    local pkg="$1"
    local sha_file="${pkg}.sha256"

    if [[ ! -f "$sha_file" ]]; then
        log "WARNING: ${sha_file##*/} not found — skipping verification."
        return 1
    fi

    local expected actual
    expected="$(cat "$sha_file")"
    actual="$(sha256sum "$pkg" | awk '{print $1}')"

    if [[ "$expected" == "$actual" ]]; then
        log "SHA256 OK : $(basename "$pkg")"
    else
        log "ERROR: SHA256 mismatch for $(basename "$pkg")"
        log "  Expected : $expected"
        log "  Got      : $actual"
        return 1
    fi
}

RPM_PKG="$OUTPUT_DIR/claude-desktop-${APP_VERSION}-x86_64.rpm"
DEB_PKG="$OUTPUT_DIR/claude-desktop-${APP_VERSION}-x86_64.deb"
APPIMAGE_PKG="$OUTPUT_DIR/claude-desktop-${APP_VERSION}-x86_64.AppImage"

[[ -f "$RPM_PKG"      ]] && verify_sha256 "$RPM_PKG"      || true
[[ -f "$DEB_PKG"      ]] && verify_sha256 "$DEB_PKG"      || true
[[ -f "$APPIMAGE_PKG" ]] && verify_sha256 "$APPIMAGE_PKG" || true

# ---------------------------------------------------------------------------
# Exit 0 only if at least one package was built successfully
# ---------------------------------------------------------------------------
if [[ "$RPM_OK" == "true" || "$DEB_OK" == "true" || "$APPIMAGE_OK" == "true" ]]; then
    log "Done."
    exit 0
else
    log "ERROR: No packages were built successfully."
    exit 1
fi
