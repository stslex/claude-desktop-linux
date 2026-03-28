#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-packages.sh
#
# Assemble the final RPM and AppImage packages from the patched app.asar.
#
# Env vars:
#   BUILD_DIR         default: /tmp/claude-build
#   OUTPUT_DIR        default: ./output  (relative to repo root)
#   ELECTRON_OVERRIDE force a specific Electron version (e.g. 37.0.0)
# ---------------------------------------------------------------------------

BUILD_DIR="${BUILD_DIR:-/tmp/claude-build}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_DIR/output}"

GUARD="$BUILD_DIR/.build-packages-done"

if [[ -f "$GUARD" ]]; then
  echo "[build-packages] Already done (remove $GUARD to re-run)."
  exit 0
fi

# ---------------------------------------------------------------------------
# Read discovered versions
# ---------------------------------------------------------------------------
if [[ ! -f "$BUILD_DIR/VERSION" ]]; then
  echo "[build-packages] ERROR: $BUILD_DIR/VERSION not found. Run fetch-and-extract.sh first."
  exit 1
fi

APP_VERSION="$(cat "$BUILD_DIR/VERSION")"
ELECTRON_VERSION="${ELECTRON_OVERRIDE:-$(cat "$BUILD_DIR/ELECTRON_VERSION")}"

echo "[build-packages] Claude Desktop : $APP_VERSION"
echo "[build-packages] Electron       : $ELECTRON_VERSION"

mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
check_dep() {
  if ! command -v "$1" &>/dev/null; then
    echo "[build-packages] WARNING: '$1' not found — $2"
    return 1
  fi
  return 0
}

BUILD_RPM=true
BUILD_APPIMAGE=true

check_dep rpmbuild    "RPM build will be skipped. Install: sudo dnf install rpm-build" || BUILD_RPM=false
check_dep appimagetool "AppImage build will be skipped. Download from https://appimage.github.io/appimagetool/" || BUILD_APPIMAGE=false

if [[ "$BUILD_RPM" == "false" && "$BUILD_APPIMAGE" == "false" ]]; then
  echo "[build-packages] ERROR: Neither rpmbuild nor appimagetool available. Nothing to build."
  exit 1
fi

# ---------------------------------------------------------------------------
# Shared assets — extract PNG icons from the ASAR if available
# ---------------------------------------------------------------------------
ICONS_DIR="$BUILD_DIR/icons"
mkdir -p "$ICONS_DIR"

ICNS_FILE="$(find "$BUILD_DIR/dmg-contents" -name "*.icns" 2>/dev/null | head -1 || true)"
if [[ -n "$ICNS_FILE" ]]; then
  echo "[build-packages] Extracting icons from $ICNS_FILE ..."
  if command -v icns2png &>/dev/null; then
    icns2png -x -d 32 -o "$ICONS_DIR" "$ICNS_FILE" 2>/dev/null || true
  elif command -v magick &>/dev/null; then
    for SIZE in 16 32 48 64 128 256 512; do
      magick "$ICNS_FILE[$((SIZE * SIZE))]" -resize "${SIZE}x${SIZE}" \
        "$ICONS_DIR/claude-desktop_${SIZE}x${SIZE}.png" 2>/dev/null || true
    done
  else
    echo "[build-packages] WARNING: Neither icns2png nor ImageMagick found — icons will be missing."
  fi
fi

# ---------------------------------------------------------------------------
# RPM
# ---------------------------------------------------------------------------
if [[ "$BUILD_RPM" == "true" ]]; then
  echo "[build-packages] Building RPM..."

  RPM_ROOT="$BUILD_DIR/rpmbuild"
  mkdir -p "$RPM_ROOT"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

  STAGING="$RPM_ROOT/BUILDROOT/claude-desktop-${APP_VERSION}-1.x86_64"
  mkdir -p "$STAGING/usr/lib/claude-desktop"
  mkdir -p "$STAGING/usr/bin"
  mkdir -p "$STAGING/usr/share/applications"
  mkdir -p "$STAGING/usr/share/icons/hicolor"

  # App files
  cp "$BUILD_DIR/app.asar" "$STAGING/usr/lib/claude-desktop/"
  if [[ -d "$BUILD_DIR/app.asar.unpacked" ]]; then
    cp -a "$BUILD_DIR/app.asar.unpacked" "$STAGING/usr/lib/claude-desktop/"
  fi
  echo "$ELECTRON_VERSION" > "$STAGING/usr/lib/claude-desktop/ELECTRON_VERSION"

  # Launcher
  cp "$REPO_DIR/packaging/AppDir/usr/bin/claude-desktop" "$STAGING/usr/bin/claude-desktop"
  chmod 755 "$STAGING/usr/bin/claude-desktop"

  # Desktop file
  cp "$REPO_DIR/packaging/AppDir/claude-desktop.desktop" "$STAGING/usr/share/applications/"

  # Icons
  for PNG in "$ICONS_DIR"/*.png; do
    [[ -f "$PNG" ]] || continue
    SIZE="$(basename "$PNG" | grep -oP '\d+x\d+' | head -1)"
    [[ -z "$SIZE" ]] && continue
    ICON_DIR="$STAGING/usr/share/icons/hicolor/$SIZE/apps"
    mkdir -p "$ICON_DIR"
    cp "$PNG" "$ICON_DIR/claude-desktop.png"
  done

  # Spec
  rpmbuild \
    --define "_topdir $RPM_ROOT" \
    --define "_builddir $RPM_ROOT/BUILD" \
    --define "_rpmdir $RPM_ROOT/RPMS" \
    --define "_version $APP_VERSION" \
    --define "_buildroot $STAGING" \
    --bb "$REPO_DIR/packaging/claude-desktop.spec" \
    --noclean 2>&1

  RPM_FILE="$(find "$RPM_ROOT/RPMS" -name "*.rpm" | head -1)"
  if [[ -z "$RPM_FILE" ]]; then
    echo "[build-packages] ERROR: rpmbuild did not produce an RPM."
    exit 1
  fi

  DEST_RPM="$OUTPUT_DIR/claude-desktop-${APP_VERSION}-x86_64.rpm"
  cp "$RPM_FILE" "$DEST_RPM"
  sha256sum "$DEST_RPM" | awk '{print $1}' > "${DEST_RPM}.sha256"
  echo "[build-packages] RPM: $DEST_RPM"
fi

# ---------------------------------------------------------------------------
# AppImage
# ---------------------------------------------------------------------------
if [[ "$BUILD_APPIMAGE" == "true" ]]; then
  echo "[build-packages] Building AppImage (Electron $ELECTRON_VERSION)..."

  APPDIR="$BUILD_DIR/AppDir"
  # Start from the packaging skeleton.
  cp -a "$REPO_DIR/packaging/AppDir/." "$APPDIR/"

  # App files
  mkdir -p "$APPDIR/usr/lib/claude-desktop"
  cp "$BUILD_DIR/app.asar" "$APPDIR/usr/lib/claude-desktop/"
  if [[ -d "$BUILD_DIR/app.asar.unpacked" ]]; then
    cp -a "$BUILD_DIR/app.asar.unpacked" "$APPDIR/usr/lib/claude-desktop/"
  fi
  echo "$ELECTRON_VERSION" > "$APPDIR/usr/lib/claude-desktop/ELECTRON_VERSION"

  # Download Electron if not cached.
  ELECTRON_CACHE="$BUILD_DIR/electron-cache"
  ELECTRON_TARBALL="$ELECTRON_CACHE/electron-v${ELECTRON_VERSION}-linux-x64.zip"
  mkdir -p "$ELECTRON_CACHE"

  if [[ ! -f "$ELECTRON_TARBALL" ]]; then
    ELECTRON_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-x64.zip"
    echo "[build-packages] Downloading Electron $ELECTRON_VERSION ..."
    curl -L --progress-bar -o "$ELECTRON_TARBALL" "$ELECTRON_URL"
  fi

  # Extract Electron into AppDir.
  ELECTRON_DIR="$APPDIR/usr/lib/electron"
  mkdir -p "$ELECTRON_DIR"
  unzip -q "$ELECTRON_TARBALL" -d "$ELECTRON_DIR"

  # Set AppImage icon (use largest PNG available).
  ICON_SRC="$(find "$ICONS_DIR" -name "*.png" | sort -t_ -k2 -V | tail -1 || true)"
  if [[ -n "$ICON_SRC" ]]; then
    cp "$ICON_SRC" "$APPDIR/claude-desktop.png"
  fi

  # Build AppImage.
  APPIMAGE_OUT="$OUTPUT_DIR/claude-desktop-${APP_VERSION}-x86_64.AppImage"
  ARCH=x86_64 appimagetool "$APPDIR" "$APPIMAGE_OUT" 2>&1
  chmod +x "$APPIMAGE_OUT"

  sha256sum "$APPIMAGE_OUT" | awk '{print $1}' > "${APPIMAGE_OUT}.sha256"
  echo "[build-packages] AppImage: $APPIMAGE_OUT"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "[build-packages] Output:"
ls -lh "$OUTPUT_DIR"/claude-desktop-* 2>/dev/null || true

touch "$GUARD"
echo "[build-packages] Done."
