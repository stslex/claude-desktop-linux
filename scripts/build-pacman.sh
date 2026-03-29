#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-pacman.sh
#
# Build an Arch Linux .pkg.tar.zst package for Claude Desktop Linux.
#
# Env vars:
#   BUILD_DIR      default: /tmp/claude-build
#   OUTPUT_DIR     default: ./output  (relative to repo root)
#   REPACK         default: 1  (repack number, used as pkgrel)
# ---------------------------------------------------------------------------

log() { echo "[build-pacman] $*"; }

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

# We build the package manually with bsdtar instead of requiring makepkg,
# so this script works on any Linux distro (including ubuntu CI runners).
for cmd in bsdtar zstd; do
    if ! command -v "$cmd" &>/dev/null; then
        log "ERROR: $cmd not found. Install: sudo apt-get install libarchive-tools zstd"
        exit 1
    fi
done

VERSION="$(cat "$BUILD_DIR/VERSION")"
ELECTRON_VERSION="${ELECTRON_OVERRIDE:-$(cat "$BUILD_DIR/ELECTRON_VERSION")}"
PKGREL="${REPACK:-1}"
log "Version      : $VERSION"
log "Electron     : $ELECTRON_VERSION"
log "Pkg release  : $PKGREL"

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
# Assemble the package directory tree
# ---------------------------------------------------------------------------
PKG_ROOT="$BUILD_DIR/pacman-root"
rm -rf "$PKG_ROOT"

# Install files
install -Dm644 "$ASAR_OUT" "$PKG_ROOT/usr/lib/claude-desktop/app.asar"

echo "$ELECTRON_VERSION" > "$BUILD_DIR/pacman-electron-version"
install -Dm644 "$BUILD_DIR/pacman-electron-version" "$PKG_ROOT/usr/lib/claude-desktop/ELECTRON_VERSION"

# Bundled Electron
ELECTRON_DIR="$PKG_ROOT/usr/lib/electron"
mkdir -p "$ELECTRON_DIR"
log "Extracting Electron into package tree..."
unzip -q "$ELECTRON_ZIP" -d "$ELECTRON_DIR"
chmod 755 "$ELECTRON_DIR/electron"

# Launcher script
install -Dm755 "$REPO_DIR/packaging/AppDir/usr/bin/claude-desktop" \
    "$PKG_ROOT/usr/bin/claude-desktop"

# Desktop entry
install -Dm644 "$REPO_DIR/packaging/AppDir/claude-desktop.desktop" \
    "$PKG_ROOT/usr/share/applications/claude-desktop.desktop"

# Icons
ICONS_DIR="$REPO_DIR/packaging/icons"
if [[ -d "$ICONS_DIR" ]] && ls "$ICONS_DIR"/claude-*.png &>/dev/null; then
    log "Installing icons..."
    for PNG in "$ICONS_DIR"/claude-*.png; do
        N="$(basename "$PNG" | grep -oP '(?<=claude-)\d+(?=\.png)' || true)"
        [[ -z "$N" ]] && continue
        install -Dm644 "$PNG" \
            "$PKG_ROOT/usr/share/icons/hicolor/${N}x${N}/apps/claude-desktop.png"
    done
else
    log "WARNING: No PNG icons found in $ICONS_DIR"
fi

# ---------------------------------------------------------------------------
# Generate .PKGINFO
# ---------------------------------------------------------------------------
# Compute installed size in bytes
INSTALL_SIZE="$(du -sb "$PKG_ROOT" | awk '{print $1}')"

cat > "$PKG_ROOT/.PKGINFO" <<PKGINFO_EOF
pkgname = claude-desktop
pkgbase = claude-desktop
pkgver = ${VERSION}-${PKGREL}
xdata = pkgtype=pkg
pkgdesc = Claude Desktop for Linux (unofficial rebuild)
url = https://github.com/stslex/claude-desktop-linux
builddate = $(date +%s)
packager = Claude Desktop Linux CI
size = ${INSTALL_SIZE}
arch = x86_64
license = Proprietary
depend = bash
depend = xdg-utils
depend = hicolor-icon-theme
optdepend = bubblewrap: sandboxed Cowork sessions
PKGINFO_EOF

# ---------------------------------------------------------------------------
# Generate install hooks (.INSTALL)
# ---------------------------------------------------------------------------
cat > "$PKG_ROOT/.INSTALL" <<'INSTALL_EOF'
post_install() {
    # Register the claude:// URI scheme.
    if command -v xdg-mime &>/dev/null; then
        xdg-mime default claude-desktop.desktop x-scheme-handler/claude || true
    fi

    # Refresh the desktop database.
    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database -q /usr/share/applications || true
    fi

    # Refresh icon cache.
    if command -v gtk-update-icon-cache &>/dev/null; then
        gtk-update-icon-cache -qf /usr/share/icons/hicolor || true
    fi

    # Create the /sessions symlink required by the path translator.
    SESSION_TARGET=/var/lib/claude-desktop/sessions
    if [ ! -L /sessions ] && [ ! -e /sessions ]; then
        mkdir -p "$SESSION_TARGET"
        ln -sf "$SESSION_TARGET" /sessions 2>/dev/null || {
            echo "claude-desktop: could not create /sessions — run manually:"
            echo "  sudo mkdir -p $SESSION_TARGET && sudo ln -sf $SESSION_TARGET /sessions"
        }
    fi
}

post_upgrade() {
    post_install
}

post_remove() {
    # Remove the /sessions symlink only if it points to our directory.
    if [ -L /sessions ]; then
        target="$(readlink /sessions)"
        case "$target" in
            /var/lib/claude-desktop/sessions*)
                rm -f /sessions ;;
        esac
    fi

    # Refresh desktop database after removal.
    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database -q /usr/share/applications || true
    fi
}
INSTALL_EOF

# ---------------------------------------------------------------------------
# Build .pkg.tar.zst using bsdtar
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
DEST_PKG="$OUTPUT_DIR/claude-desktop-${VERSION}-x86_64.pkg.tar.zst"

log "Building pacman package..."
# bsdtar must run from the package root so paths are relative
(cd "$PKG_ROOT" && bsdtar --uid 0 --gid 0 -cf - .PKGINFO .INSTALL usr/ | zstd -T0 -19 -o "$DEST_PKG")

sha256sum "$DEST_PKG" | awk '{print $1}' > "${DEST_PKG}.sha256"

log "PKG          : $DEST_PKG"
log "SHA256       : $(cat "${DEST_PKG}.sha256")"
log "Done."
