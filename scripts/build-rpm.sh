#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-rpm.sh
#
# Re-pack the patched ASAR and build an RPM from it.
#
# Env vars:
#   BUILD_DIR      default: /tmp/claude-build
#   OUTPUT_DIR     default: ./output  (relative to repo root)
#   GPG_KEY_ID     optional: sign the RPM with this key ID
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
log "Version      : $VERSION"

# ---------------------------------------------------------------------------
# Re-pack the patched ASAR
# ---------------------------------------------------------------------------
ASAR_OUT="$BUILD_DIR/app-patched.asar"
log "Packing app-patched.asar from $BUILD_DIR/app-extracted ..."
npx --yes @electron/asar pack "$BUILD_DIR/app-extracted" "$ASAR_OUT"
log "Packed       : $ASAR_OUT"

# ---------------------------------------------------------------------------
# Set up the rpmbuild tree
# ---------------------------------------------------------------------------
RPM_ROOT="$BUILD_DIR/rpmbuild"
mkdir -p "$RPM_ROOT"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

log "Copying sources into $RPM_ROOT/SOURCES/ ..."
cp "$ASAR_OUT" "$RPM_ROOT/SOURCES/app-patched.asar"
cp "$REPO_DIR/packaging/AppDir/usr/bin/claude-desktop" "$RPM_ROOT/SOURCES/claude-desktop"
cp "$REPO_DIR/packaging/AppDir/claude-desktop.desktop" "$RPM_ROOT/SOURCES/claude-desktop.desktop"

# Icons tarball — always create it (may be empty if icon extraction was skipped)
ICONS_DIR="$BUILD_DIR/icons"
mkdir -p "$ICONS_DIR"
log "Creating icons.tar.gz ..."
tar -czf "$RPM_ROOT/SOURCES/icons.tar.gz" -C "$BUILD_DIR" icons/

# Copy spec
cp "$REPO_DIR/packaging/claude-desktop.spec" "$RPM_ROOT/SPECS/claude-desktop.spec"

# ---------------------------------------------------------------------------
# Build RPM
# ---------------------------------------------------------------------------
log "Running rpmbuild $VERSION ..."

RPMBUILD_ARGS=(
    --define "_topdir $RPM_ROOT"
    --define "_version $VERSION"
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
DEST_RPM="$OUTPUT_DIR/claude-desktop-${VERSION}-x86_64.rpm"
cp "$RPM_FILE" "$DEST_RPM"
sha256sum "$DEST_RPM" | awk '{print $1}' > "${DEST_RPM}.sha256"

log "RPM          : $DEST_RPM"
log "SHA256       : $(cat "${DEST_RPM}.sha256")"
log "Done."
