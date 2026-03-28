#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# fetch-and-extract.sh
#
# 1. Download the official macOS Claude Desktop DMG from Anthropic's CDN.
# 2. SHA256-verify the download (idempotent — skips if checksum matches).
# 3. Convert DMG → raw image with dmg2img.
# 4. Extract the raw image with 7z.
# 5. Unpack app.asar with @electron/asar.
# 6. Write $BUILD_DIR/VERSION and $BUILD_DIR/ELECTRON_VERSION.
# 7. Extract icons to packaging/icons/ via ImageMagick convert.
#
# Env vars:
#   BUILD_DIR          default: /tmp/claude-build
#   OUTPUT_DIR         default: ./output
#   SKIP_DOWNLOAD      set to 1 to reuse existing $BUILD_DIR/claude.dmg
#   ELECTRON_OVERRIDE  force a specific Electron version (e.g. 37.0.0)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
BUILD_DIR="${BUILD_DIR:-/tmp/claude-build}"
OUTPUT_DIR="${OUTPUT_DIR:-./output}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GUARD="$BUILD_DIR/.fetch-and-extract-done"

# Idempotency guard — whole script.
if [[ -f "$GUARD" ]]; then
  log "Already done (remove $GUARD to re-run)."
  exit 0
fi

mkdir -p "$BUILD_DIR"
mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
check_dep() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" &>/dev/null; then
    log "ERROR: '$cmd' not found. $hint"
    exit 1
  fi
}

check_dep curl    "Install with: sudo dnf install curl"
check_dep dmg2img "Install with: sudo dnf install dmg2img"
check_dep 7z      "Install with: sudo dnf install p7zip-plugins  # or apt install p7zip-full"
check_dep node    "Install Node.js >= 20 from https://nodejs.org"
check_dep npx     "Comes with Node.js."
check_dep convert "Install with: sudo dnf install ImageMagick  # or apt install imagemagick"

# ---------------------------------------------------------------------------
# Resolve versioned DMG URL via redirect headers.
# ---------------------------------------------------------------------------
DMG_LATEST_URL="https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest-apple/Claude-latest.dmg"
DMG_FILE="$BUILD_DIR/claude.dmg"

log "Resolving latest DMG URL (following redirects)..."
VERSIONED_FILENAME=""

# Strategy 1: Follow redirects with a GET range request and check the
# effective URL.  Some CDNs only redirect GET (not HEAD) requests.
RESOLVED_URL="$(curl -sSL -o /dev/null -w '%{url_effective}' -r 0-0 "$DMG_LATEST_URL" 2>/dev/null || true)"
if [[ -n "$RESOLVED_URL" && "$RESOLVED_URL" != "$DMG_LATEST_URL" ]]; then
  VERSIONED_FILENAME="$(basename "$RESOLVED_URL")"
  log "Resolved via GET effective URL: $VERSIONED_FILENAME"
fi

# Strategy 2: Parse the Location header from redirect responses.
if [[ -z "$VERSIONED_FILENAME" || "$VERSIONED_FILENAME" == "Claude-latest.dmg" ]]; then
  REDIRECT_HEADERS=$(curl -sIL "$DMG_LATEST_URL" 2>/dev/null || true)
  LOCATION_LINE=$(echo "$REDIRECT_HEADERS" | grep -i "^location:" | tail -1 | tr -d '\r')
  if [[ -n "$LOCATION_LINE" ]]; then
    VERSIONED_FILENAME=$(echo "$LOCATION_LINE" | awk '{print $2}' | xargs -I{} basename {})
    log "Resolved via Location header: $VERSIONED_FILENAME"
  fi
fi

# Strategy 3: Check Content-Disposition header for the original filename.
if [[ -z "$VERSIONED_FILENAME" || "$VERSIONED_FILENAME" == "Claude-latest.dmg" ]]; then
  HEADERS="$(curl -sI "$DMG_LATEST_URL" 2>/dev/null || true)"
  CD="$(echo "$HEADERS" | grep -i '^content-disposition:' | tr -d '\r')"
  if [[ -n "$CD" ]]; then
    FNAME="$(echo "$CD" | grep -oP 'filename="?\K[^";]+' || true)"
    if [[ -n "$FNAME" ]]; then
      VERSIONED_FILENAME="$FNAME"
      log "Resolved via Content-Disposition: $VERSIONED_FILENAME"
    fi
  fi
fi

# Pattern: Claude-X.X.XXXX.dmg
DMG_VERSION=$(echo "$VERSIONED_FILENAME" | grep -oP '(?<=Claude-)[\d]+\.[\d]+\.[\d]+(?=\.dmg)' || true)

if [[ -n "$VERSIONED_FILENAME" && "$VERSIONED_FILENAME" == Claude-*.dmg ]]; then
  # Reconstruct versioned URL from the same bucket prefix.
  DOWNLOAD_URL="${DMG_LATEST_URL%/*}/$VERSIONED_FILENAME"
  log "Resolved filename : $VERSIONED_FILENAME"
  log "Version from URL  : ${DMG_VERSION:-unknown}"
  log "Download URL      : $DOWNLOAD_URL"
else
  log "WARNING: Could not extract versioned filename — falling back to latest URL."
  DOWNLOAD_URL="$DMG_LATEST_URL"
  DMG_VERSION=""
fi

# ---------------------------------------------------------------------------
# Download DMG — skip if file exists and stored checksum matches.
# ---------------------------------------------------------------------------
_do_download() {
  log "Downloading DMG..."
  curl -L --progress-bar -o "$DMG_FILE" "$DOWNLOAD_URL"
}

if [[ "${SKIP_DOWNLOAD:-}" == "1" && -f "$DMG_FILE" ]]; then
  log "SKIP_DOWNLOAD=1 — reusing $DMG_FILE"
elif [[ -f "$DMG_FILE" && -f "${DMG_FILE}.sha256" ]]; then
  STORED_SHA=$(cat "${DMG_FILE}.sha256")
  ACTUAL_SHA=$(sha256sum "$DMG_FILE" | awk '{print $1}')
  if [[ "$STORED_SHA" == "$ACTUAL_SHA" ]]; then
    log "DMG already present and checksum matches — skipping download."
  else
    log "Checksum mismatch (stored: $STORED_SHA, actual: $ACTUAL_SHA) — re-downloading."
    _do_download
  fi
else
  _do_download
fi

# ---------------------------------------------------------------------------
# SHA256 — always recompute and write after (potential) download.
# ---------------------------------------------------------------------------
log "Computing SHA256..."
sha256sum "$DMG_FILE" | awk '{print $1}' > "${DMG_FILE}.sha256"
log "SHA256: $(cat "${DMG_FILE}.sha256")"

# ---------------------------------------------------------------------------
# Convert DMG → raw image
# ---------------------------------------------------------------------------
IMG_FILE="$BUILD_DIR/claude.img"
log "Converting DMG to raw image with dmg2img..."
dmg2img -i "$DMG_FILE" -o "$IMG_FILE"

# ---------------------------------------------------------------------------
# Extract raw image with 7z
# ---------------------------------------------------------------------------
EXTRACT_DIR="$BUILD_DIR/dmg-contents"
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
log "Extracting raw image with 7z..."
7z x -o"$EXTRACT_DIR" "$IMG_FILE" -y -bd 2>/dev/null || true

# ---------------------------------------------------------------------------
# Locate app.asar inside Claude.app/Contents/Resources/
# ---------------------------------------------------------------------------
ASAR_SRC=$(find "$EXTRACT_DIR" -path "*/Claude.app/Contents/Resources/app.asar" | head -1)
if [[ -z "$ASAR_SRC" ]]; then
  # Fallback: any app.asar not buried in node_modules.
  ASAR_SRC=$(find "$EXTRACT_DIR" -name "app.asar" -not -path "*/node_modules/*" | head -1)
fi
if [[ -z "$ASAR_SRC" ]]; then
  log "ERROR: app.asar not found inside extracted image."
  ls -R "$EXTRACT_DIR" | head -60
  exit 1
fi
log "Found app.asar: $ASAR_SRC"

# ---------------------------------------------------------------------------
# Copy app.asar (and app.asar.unpacked if present) to BUILD_DIR
# ---------------------------------------------------------------------------
ASAR_DEST="$BUILD_DIR/app.asar"
cp "$ASAR_SRC" "$ASAR_DEST"

ASAR_UNPACKED_SRC="${ASAR_SRC}.unpacked"
if [[ -d "$ASAR_UNPACKED_SRC" ]]; then
  cp -a "$ASAR_UNPACKED_SRC" "$BUILD_DIR/app.asar.unpacked"
  log "Copied app.asar.unpacked/"
fi

# ---------------------------------------------------------------------------
# Extract app.asar
# ---------------------------------------------------------------------------
APP_DIR="$BUILD_DIR/app-extracted"
rm -rf "$APP_DIR"
log "Unpacking app.asar with @electron/asar..."
npx --yes @electron/asar extract "$ASAR_DEST" "$APP_DIR"

# ---------------------------------------------------------------------------
# App version from package.json
# ---------------------------------------------------------------------------
PKG_JSON="$APP_DIR/package.json"
if [[ ! -f "$PKG_JSON" ]]; then
  log "ERROR: package.json not found inside extracted asar."
  exit 1
fi

APP_VERSION=$(node -e "process.stdout.write(require('$PKG_JSON').version)")
if [[ -z "$APP_VERSION" ]]; then
  log "ERROR: Could not read version from package.json."
  exit 1
fi

echo "$APP_VERSION" > "$BUILD_DIR/VERSION"
log "App version: $APP_VERSION"

# ---------------------------------------------------------------------------
# Electron version detection
#   1. engines.electron in package.json
#   2. devDependencies.electron in package.json
#   3. Scan .vite/build/ manifest files for an electron version reference
# ---------------------------------------------------------------------------
ELECTRON_VERSION=$(node -e "
const p = require('$PKG_JSON');
const raw = (p.engines && p.engines.electron)
         || (p.devDependencies && p.devDependencies.electron)
         || '';
process.stdout.write(raw.replace(/[^0-9.]/g, ''));
" 2>/dev/null || true)

if [[ -z "$ELECTRON_VERSION" ]]; then
  log "Electron not in package.json fields — scanning .vite/build/ manifests..."
  VITE_BUILD_DIR="$APP_DIR/.vite/build"
  if [[ -d "$VITE_BUILD_DIR" ]]; then
    ELECTRON_VERSION=$(node -e "
const fs   = require('fs');
const path = require('path');
const dir  = '$VITE_BUILD_DIR';
const files = fs.readdirSync(dir);
for (const f of files) {
  const fp = path.join(dir, f);
  try {
    const content = fs.readFileSync(fp, 'utf8');
    // JSON manifest: \"electron\": \"X.Y.Z\"
    const mJson = content.match(/[\"']electron[\"']\s*:\s*[\"']([0-9][0-9.]*)[\"']/);
    if (mJson) { process.stdout.write(mJson[1]); process.exit(0); }
    // JS bundle: process.versions.electron or similar reference
    const mJs = content.match(/electronVersion\s*[=:]\s*[\"']([0-9][0-9.]*)[\"']/);
    if (mJs) { process.stdout.write(mJs[1]); process.exit(0); }
  } catch (_) {}
}
" 2>/dev/null || true)
  fi
fi

# Honour ELECTRON_OVERRIDE if detection still came up empty.
if [[ -z "$ELECTRON_VERSION" && -n "${ELECTRON_OVERRIDE:-}" ]]; then
  log "Using ELECTRON_OVERRIDE: $ELECTRON_OVERRIDE"
  ELECTRON_VERSION="$ELECTRON_OVERRIDE"
fi

if [[ -z "$ELECTRON_VERSION" ]]; then
  log "WARNING: Could not detect Electron version. Set ELECTRON_OVERRIDE to provide one."
fi

echo "$ELECTRON_VERSION" > "$BUILD_DIR/ELECTRON_VERSION"
log "Electron version: ${ELECTRON_VERSION:-unknown}"

# ---------------------------------------------------------------------------
# Extract icons from claude.icns using ImageMagick convert
# Output: packaging/icons/claude-{16,32,48,64,128,256,512}.png
# ---------------------------------------------------------------------------
RESOURCES_DIR="$(dirname "$ASAR_SRC")"
ICNS_FILE=$(find "$RESOURCES_DIR" -name "claude.icns" | head -1 || true)

ICONS_DIR="$REPO_DIR/packaging/icons"
mkdir -p "$ICONS_DIR"
ICON_COUNT=0

if [[ -n "$ICNS_FILE" ]]; then
  log "Extracting icons from: $ICNS_FILE"
  for SIZE in 16 32 48 64 128 256 512; do
    OUT="$ICONS_DIR/claude-${SIZE}.png"
    if convert -background none "$ICNS_FILE" \
        -resize "${SIZE}x${SIZE}" -flatten "$OUT" 2>/dev/null; then
      ICON_COUNT=$((ICON_COUNT + 1))
    else
      log "WARNING: Failed to extract ${SIZE}x${SIZE} icon."
    fi
  done
  log "Icons written to $ICONS_DIR"
else
  log "WARNING: claude.icns not found in $RESOURCES_DIR — no icons extracted."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
ASAR_SIZE=$(du -sh "$ASAR_DEST" | awk '{print $1}')
log "------------------------------------------------------------"
log "Summary"
log "  Claude Desktop version : $APP_VERSION"
log "  Electron version       : ${ELECTRON_VERSION:-unknown}"
log "  app.asar size          : $ASAR_SIZE"
log "  Icons extracted        : $ICON_COUNT / 7"
log "------------------------------------------------------------"

touch "$GUARD"
log "Done."
