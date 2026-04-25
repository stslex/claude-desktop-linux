#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-pacman.sh
#
# Build an Arch Linux .pkg.tar.zst package for Claude Desktop Linux.
#
# Env vars:
#   BUILD_DIR        default: /tmp/claude-build
#   OUTPUT_DIR       default: ./output  (relative to repo root)
#   REPACK           default: 1  (repack number, used as pkgrel)
#   VERSION_SUFFIX   optional: appended to version in filename/metadata
#                    (e.g. "~dev.20260404.abc1234" for dev channel)
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
for cmd in bsdtar zstd unzip; do
    if ! command -v "$cmd" &>/dev/null; then
        log "ERROR: $cmd not found. Install: sudo apt-get install libarchive-tools zstd unzip"
        exit 1
    fi
    log "Found $cmd: $(command -v "$cmd") ($(${cmd} --version 2>&1 | head -1 || echo 'unknown version'))"
done

VERSION="$(cat "$BUILD_DIR/VERSION")"
VERSION_SUFFIX="${VERSION_SUFFIX:-}"
FULL_VERSION="${VERSION}${VERSION_SUFFIX}"
ELECTRON_VERSION="${ELECTRON_OVERRIDE:-$(cat "$BUILD_DIR/ELECTRON_VERSION")}"
PKGREL="${REPACK:-1}"
log "Version      : $FULL_VERSION"
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
    log "WARNING: No PNG icons found in $ICONS_DIR \u2014 generating from bundled SVG..."
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
                "$PKG_ROOT/usr/share/icons/hicolor/${N}x${N}/apps/claude-desktop.png"
        done
    fi
fi

# Always install SVG icon for scalable resolution support
SVG_ICON="$REPO_DIR/packaging/claude-desktop.svg"
if [[ -f "$SVG_ICON" ]]; then
    install -Dm644 "$SVG_ICON" \
        "$PKG_ROOT/usr/share/icons/hicolor/scalable/apps/claude-desktop.svg"
fi

# ---------------------------------------------------------------------------
# Generate .PKGINFO
# ---------------------------------------------------------------------------
# Compute installed size from usr/ only (files that consume filesystem space).
# Package metadata files (.PKGINFO, .INSTALL, .MTREE) are stored in pacman's
# database, not in /usr, so they must be excluded from the size calculation.
INSTALL_SIZE="$(du -sb "$PKG_ROOT/usr" | awk '{print $1}')"

cat > "$PKG_ROOT/.PKGINFO" <<PKGINFO_EOF
pkgname = claude-desktop
pkgbase = claude-desktop
pkgver = ${FULL_VERSION}-${PKGREL}
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
depend = alsa-lib
depend = at-spi2-atk
depend = atk
depend = cairo
depend = libcups
depend = dbus
depend = expat
depend = libdrm
depend = libx11
depend = libxcb
depend = libxcomposite
depend = libxdamage
depend = libxext
depend = libxfixes
depend = libxkbcommon
depend = libxrandr
depend = mesa
depend = nspr
depend = nss
depend = gtk3
depend = glib2
depend = pango
optdepend = bubblewrap: sandboxed Cowork sessions
optdepend = cowork-svc-linux: Cowork/Dispatch socket daemon for Linux
PKGINFO_EOF

# ---------------------------------------------------------------------------
# Generate install hooks (.INSTALL)
# ---------------------------------------------------------------------------
cat > "$PKG_ROOT/.INSTALL" <<'INSTALL_EOF'
post_install() {
    # Register the claude:// URI scheme.
    if command -v xdg-mime &>/dev/null; then
        if [ -n "${XDG_CONFIG_HOME:-}" ]; then
            config_home="$XDG_CONFIG_HOME"
        elif [ -n "${HOME:-}" ]; then
            config_home="$HOME/.config"
        else
            config_home="/root/.config"
        fi
        mkdir -p "$config_home"
        xdg-mime default claude-desktop.desktop x-scheme-handler/claude 2>/dev/null || true
    fi

    # Refresh the desktop database.
    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database -q /usr/share/applications || true
    fi

    # Refresh icon cache.
    if command -v gtk-update-icon-cache &>/dev/null; then
        gtk-update-icon-cache -qf /usr/share/icons/hicolor || true
    fi

    # NOTE: No /sessions symlink is needed — path-translator.mjs handles all
    # /sessions/… → ~/.local/share/claude-linux/sessions/… remapping in-process.
    # The launcher script creates the session directory via mkdir -p.
}

post_upgrade() {
    post_install
}

post_remove() {
    # Refresh desktop database after removal.
    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database -q /usr/share/applications || true
    fi
}
INSTALL_EOF

# ---------------------------------------------------------------------------
# Generate .MTREE (file-level integrity metadata, used by pacman -Qk)
# ---------------------------------------------------------------------------
log "Generating .MTREE..."
if ! (cd "$PKG_ROOT" && LANG=C bsdtar --uid 0 --gid 0 -czf .MTREE --format=mtree \
    --options='!all,use-set,type,uid,gid,mode,time,size,md5,sha256,link' \
    .PKGINFO .INSTALL usr/) 2>/dev/null; then
    log "WARNING: bsdtar --format=mtree failed — creating minimal .MTREE"
    # Fallback: create a gzipped empty mtree (pacman can install without it).
    (cd "$PKG_ROOT" && echo '#mtree' | gzip > .MTREE)
fi

# ---------------------------------------------------------------------------
# Build .pkg.tar.zst using bsdtar
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
DEST_PKG="$OUTPUT_DIR/claude-desktop-${FULL_VERSION}-x86_64.pkg.tar.zst"

log "Pre-build package tree summary:"
log "  PKG_ROOT    : $PKG_ROOT"
log "  DEST_PKG    : $DEST_PKG"
(cd "$PKG_ROOT" && du -sh usr/ .PKGINFO .INSTALL .MTREE 2>&1) | while IFS= read -r line; do
    log "  $line"
done

log "Building pacman package..."
# bsdtar must run from the package root so paths are relative.
# Use zstd level 10 instead of 19 — level 19 is extremely memory-hungry
# under multi-threading (-T0) and can cause OOM kills on CI runners,
# while level 10 is ~2x faster and only ~5% larger.
set +e
(cd "$PKG_ROOT" && bsdtar --uid 0 --gid 0 -cf - .PKGINFO .INSTALL .MTREE usr/ | zstd -T0 -10 -o "$DEST_PKG") 2>&1
PACK_RC=$?
set -e

if [[ $PACK_RC -ne 0 ]]; then
    log "ERROR: bsdtar | zstd pipeline failed (exit $PACK_RC)"
    log "Retrying with single-threaded zstd -1 as fallback..."
    rm -f "$DEST_PKG"
    (cd "$PKG_ROOT" && bsdtar --uid 0 --gid 0 -cf - .PKGINFO .INSTALL .MTREE usr/ | zstd -1 -o "$DEST_PKG")
fi

sha256sum "$DEST_PKG" | awk '{print $1}' > "${DEST_PKG}.sha256"

# ---------------------------------------------------------------------------
# Verify the package is a readable archive before publishing
# ---------------------------------------------------------------------------
log "Verifying package archive..."
# Use zstd decompress + bsdtar pipeline for broader compatibility (avoids
# depending on libarchive having built-in zstd support).
if ! zstd -d -c "$DEST_PKG" 2>/dev/null | bsdtar -tf - > /dev/null 2>&1; then
    log "ERROR: Built package is not a valid archive: $DEST_PKG"
    exit 1
fi
PKGINFO_CHECK="$(zstd -d -c "$DEST_PKG" 2>/dev/null | bsdtar -xf - -O .PKGINFO 2>/dev/null | grep '^pkgname = ' | head -1)"
if [[ -z "$PKGINFO_CHECK" || "$PKGINFO_CHECK" != "pkgname = claude-desktop" ]]; then
    log "ERROR: .PKGINFO missing or unreadable in built package (got: '${PKGINFO_CHECK}')"
    exit 1
fi
log "Package verification OK"

log "PKG          : $DEST_PKG"
log "SHA256       : $(cat "${DEST_PKG}.sha256")"
log "Done."
