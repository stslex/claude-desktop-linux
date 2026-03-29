#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-deb.sh
#
# Build a .deb package for Claude Desktop Linux.
#
# Env vars:
#   BUILD_DIR      default: /tmp/claude-build
#   OUTPUT_DIR     default: ./output  (relative to repo root)
# ---------------------------------------------------------------------------

log() { echo "[build-deb] $*"; }

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

if ! command -v dpkg-deb &>/dev/null; then
    log "ERROR: dpkg-deb not found. Install: sudo apt-get install dpkg"
    exit 1
fi

VERSION="$(cat "$BUILD_DIR/VERSION")"
ELECTRON_VERSION="${ELECTRON_OVERRIDE:-$(cat "$BUILD_DIR/ELECTRON_VERSION")}"
log "Version      : $VERSION"
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
# Assemble the deb directory tree
# ---------------------------------------------------------------------------
DEB_ROOT="$BUILD_DIR/deb-root"
rm -rf "$DEB_ROOT"

# Installed size in KB (rough estimate: asar + electron)
ASAR_SIZE_KB=$(( $(stat -c%s "$ASAR_OUT") / 1024 ))
ELECTRON_SIZE_KB=$(( $(stat -c%s "$ELECTRON_ZIP") / 1024 ))
INSTALLED_SIZE=$(( ASAR_SIZE_KB + ELECTRON_SIZE_KB ))

# DEBIAN/control
mkdir -p "$DEB_ROOT/DEBIAN"
cat > "$DEB_ROOT/DEBIAN/control" <<CTRL_EOF
Package: claude-desktop
Version: ${VERSION}
Architecture: amd64
Maintainer: Claude Desktop Linux <claude-desktop-linux@users.noreply.github.com>
Installed-Size: ${INSTALLED_SIZE}
Depends: bash, xdg-utils
Recommends: bubblewrap
Section: net
Priority: optional
Homepage: https://github.com/stslex/claude-desktop-linux
Description: Claude Desktop for Linux (unofficial rebuild)
 Unofficial repackage of the macOS Claude Desktop application for Linux.
 Extracts app.asar from the official macOS release, replaces macOS-native Node
 addons with pure-JS stubs, and patches the Cowork platform gate so Claude
 Code runs directly on Linux without a virtual machine.
 .
 Electron is bundled at /usr/lib/electron/. No system electron required.
CTRL_EOF

# DEBIAN/postinst
cat > "$DEB_ROOT/DEBIAN/postinst" <<'POST_EOF'
#!/bin/sh
set -e

# Register the claude:// URI scheme.
if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default claude-desktop.desktop x-scheme-handler/claude || true
fi

# Refresh the desktop database.
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
fi

# Refresh icon cache.
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -qf /usr/share/icons/hicolor || true
fi

# Create the /sessions symlink required by the path translator.
SESSION_TARGET=/var/lib/claude-desktop/sessions
if [ ! -L /sessions ] && [ ! -e /sessions ]; then
    mkdir -p "$SESSION_TARGET"
    ln -sf "$SESSION_TARGET" /sessions 2>/dev/null || \
        echo "claude-desktop: could not create /sessions — run manually:" \
        && echo "  sudo mkdir -p $SESSION_TARGET && sudo ln -sf $SESSION_TARGET /sessions"
fi
POST_EOF
chmod 755 "$DEB_ROOT/DEBIAN/postinst"

# DEBIAN/postrm
cat > "$DEB_ROOT/DEBIAN/postrm" <<'POSTRM_EOF'
#!/bin/sh
set -e

# Remove the /sessions symlink only if it points to our directory.
if [ -L /sessions ]; then
    target="$(readlink /sessions)"
    case "$target" in
        /var/lib/claude-desktop/sessions*)
            rm -f /sessions ;;
    esac
fi

# Refresh desktop database after removal.
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
fi
POSTRM_EOF
chmod 755 "$DEB_ROOT/DEBIAN/postrm"

# ---------------------------------------------------------------------------
# Install files
# ---------------------------------------------------------------------------
# App ASAR
install -D -m 644 "$ASAR_OUT" "$DEB_ROOT/usr/lib/claude-desktop/app.asar"

# Electron version hint
echo "$ELECTRON_VERSION" > "$BUILD_DIR/deb-electron-version"
install -D -m 644 "$BUILD_DIR/deb-electron-version" "$DEB_ROOT/usr/lib/claude-desktop/ELECTRON_VERSION"

# Bundled Electron
ELECTRON_DIR="$DEB_ROOT/usr/lib/electron"
mkdir -p "$ELECTRON_DIR"
log "Extracting Electron into deb tree..."
unzip -q "$ELECTRON_ZIP" -d "$ELECTRON_DIR"
chmod 755 "$ELECTRON_DIR/electron"

# Launcher script
install -D -m 755 "$REPO_DIR/packaging/AppDir/usr/bin/claude-desktop" \
    "$DEB_ROOT/usr/bin/claude-desktop"

# Desktop entry
install -D -m 644 "$REPO_DIR/packaging/AppDir/claude-desktop.desktop" \
    "$DEB_ROOT/usr/share/applications/claude-desktop.desktop"

# Icons
ICONS_DIR="$REPO_DIR/packaging/icons"
mkdir -p "$DEB_ROOT/usr/share/icons/hicolor"
if [[ -d "$ICONS_DIR" ]] && ls "$ICONS_DIR"/claude-*.png &>/dev/null; then
    log "Installing icons..."
    for PNG in "$ICONS_DIR"/claude-*.png; do
        N="$(basename "$PNG" | grep -oP '(?<=claude-)\d+(?=\.png)' || true)"
        [[ -z "$N" ]] && continue
        install -D -m 644 "$PNG" \
            "$DEB_ROOT/usr/share/icons/hicolor/${N}x${N}/apps/claude-desktop.png"
    done
else
    log "WARNING: No PNG icons found in $ICONS_DIR"
fi

# ---------------------------------------------------------------------------
# Build .deb
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
DEST_DEB="$OUTPUT_DIR/claude-desktop-${VERSION}-x86_64.deb"

log "Building .deb package..."
dpkg-deb --build --root-owner-group "$DEB_ROOT" "$DEST_DEB"

sha256sum "$DEST_DEB" | awk '{print $1}' > "${DEST_DEB}.sha256"

log "DEB          : $DEST_DEB"
log "SHA256       : $(cat "${DEST_DEB}.sha256")"
log "Done."
