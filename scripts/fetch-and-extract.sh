#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# fetch-and-extract.sh
#
# 1. Download the official macOS Claude Desktop DMG from Anthropic's CDN.
# 2. SHA256-verify the download.
# 3. Convert DMG → raw image with dmg2img.
# 4. Extract the raw image with 7z.
# 5. Unpack app.asar with @electron/asar.
# 6. Write $BUILD_DIR/VERSION and $BUILD_DIR/ELECTRON_VERSION.
#
# Env vars:
#   BUILD_DIR       default: /tmp/claude-build
#   SKIP_DOWNLOAD   set to 1 to reuse existing $BUILD_DIR/claude.dmg
# ---------------------------------------------------------------------------

BUILD_DIR="${BUILD_DIR:-/tmp/claude-build}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GUARD="$BUILD_DIR/.fetch-and-extract-done"

# Idempotency guard.
if [[ -f "$GUARD" ]]; then
  echo "[fetch-and-extract] Already done (remove $GUARD to re-run)."
  exit 0
fi

mkdir -p "$BUILD_DIR"

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
check_dep() {
  if ! command -v "$1" &>/dev/null; then
    echo "[fetch-and-extract] ERROR: '$1' not found. $2"
    exit 1
  fi
}

check_dep dmg2img  "Install with: sudo dnf install dmg2img   # or apt install dmg2img"
check_dep 7z       "Install with: sudo dnf install p7zip-plugins   # or apt install p7zip-full"
check_dep node     "Install Node.js >= 20 from https://nodejs.org"
check_dep npx      "Comes with Node.js."

# ---------------------------------------------------------------------------
# DMG URL — follow redirect to discover the versioned URL.
# ---------------------------------------------------------------------------
DMG_LATEST_URL="https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest-apple/Claude-latest.dmg"
DMG_FILE="$BUILD_DIR/claude.dmg"

if [[ "${SKIP_DOWNLOAD:-}" == "1" && -f "$DMG_FILE" ]]; then
  echo "[fetch-and-extract] SKIP_DOWNLOAD=1 — reusing $DMG_FILE"
else
  echo "[fetch-and-extract] Resolving latest DMG URL..."
  RESOLVED_URL="$(curl -sSL --head -o /dev/null -w '%{url_effective}' "$DMG_LATEST_URL")"
  echo "[fetch-and-extract] Downloading: $RESOLVED_URL"
  curl -L --progress-bar -o "$DMG_FILE" "$RESOLVED_URL"
fi

# ---------------------------------------------------------------------------
# SHA256 verification (store alongside the file for reproducibility).
# ---------------------------------------------------------------------------
echo "[fetch-and-extract] Computing SHA256..."
sha256sum "$DMG_FILE" | awk '{print $1}' > "$DMG_FILE.sha256"
echo "[fetch-and-extract] SHA256: $(cat "$DMG_FILE.sha256")"

# ---------------------------------------------------------------------------
# Convert DMG → raw image
# ---------------------------------------------------------------------------
IMG_FILE="$BUILD_DIR/claude.img"
echo "[fetch-and-extract] Converting DMG to raw image..."
dmg2img -i "$DMG_FILE" -o "$IMG_FILE"

# ---------------------------------------------------------------------------
# Extract raw image with 7z
# ---------------------------------------------------------------------------
EXTRACT_DIR="$BUILD_DIR/dmg-contents"
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
echo "[fetch-and-extract] Extracting raw image..."
7z x -o"$EXTRACT_DIR" "$IMG_FILE" -y -bd 2>/dev/null || true

# Locate app.asar — it lives inside Claude.app/Contents/Resources/
ASAR_SRC="$(find "$EXTRACT_DIR" -name "app.asar" -not -path "*/node_modules/*" | head -1)"
if [[ -z "$ASAR_SRC" ]]; then
  echo "[fetch-and-extract] ERROR: app.asar not found inside extracted image."
  ls -R "$EXTRACT_DIR" | head -60
  exit 1
fi
echo "[fetch-and-extract] Found: $ASAR_SRC"

# Also look for the unpacked dir.
ASAR_UNPACKED_SRC="${ASAR_SRC}.unpacked"

# ---------------------------------------------------------------------------
# Copy asar + unpacked to BUILD_DIR
# ---------------------------------------------------------------------------
ASAR_DEST="$BUILD_DIR/app.asar"
cp "$ASAR_SRC" "$ASAR_DEST"
if [[ -d "$ASAR_UNPACKED_SRC" ]]; then
  cp -a "$ASAR_UNPACKED_SRC" "$BUILD_DIR/app.asar.unpacked"
fi

# ---------------------------------------------------------------------------
# Unpack app.asar
# ---------------------------------------------------------------------------
APP_DIR="$BUILD_DIR/app-extracted"
rm -rf "$APP_DIR"
echo "[fetch-and-extract] Unpacking app.asar..."
npx --yes @electron/asar extract "$ASAR_DEST" "$APP_DIR"

# ---------------------------------------------------------------------------
# Detect versions from package.json inside the asar.
# ---------------------------------------------------------------------------
PKG_JSON="$APP_DIR/package.json"
if [[ ! -f "$PKG_JSON" ]]; then
  echo "[fetch-and-extract] ERROR: package.json not found inside app.asar."
  exit 1
fi

APP_VERSION="$(node -e "process.stdout.write(require('$PKG_JSON').version)")"
ELECTRON_VERSION="$(node -e "
  const p = require('$PKG_JSON');
  const ev = (p.engines && p.engines.electron) || '';
  // Strip semver range operators.
  process.stdout.write(ev.replace(/[^0-9.]/g, ''));
")"

if [[ -z "$APP_VERSION" ]]; then
  echo "[fetch-and-extract] ERROR: Could not read version from package.json."
  exit 1
fi

echo "$APP_VERSION"       > "$BUILD_DIR/VERSION"
echo "$ELECTRON_VERSION"  > "$BUILD_DIR/ELECTRON_VERSION"

echo "[fetch-and-extract] Claude Desktop version : $APP_VERSION"
echo "[fetch-and-extract] Electron engine version: $ELECTRON_VERSION"

touch "$GUARD"
echo "[fetch-and-extract] Done."
