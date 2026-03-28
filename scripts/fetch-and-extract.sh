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
check_dep unzip   "Install with: sudo dnf install unzip  # or apt install unzip"
check_dep node    "Install Node.js >= 20 from https://nodejs.org"
check_dep npx     "Comes with Node.js."

# dmg2img and 7z are only needed for the legacy DMG path (fallback).
# convert (ImageMagick) is only needed for icon extraction from .icns.

# ---------------------------------------------------------------------------
# Resolve download URL via Anthropic's RELEASES.json (primary)
# or fall back to GCS DMG URL (legacy).
# ---------------------------------------------------------------------------
RELEASES_URL="https://downloads.claude.ai/releases/darwin/universal/RELEASES.json"
DOWNLOAD_FILE="$BUILD_DIR/claude-download"   # extension set later based on format
DOWNLOAD_FORMAT=""  # "zip" or "dmg"
DOWNLOAD_URL=""

log "Querying Anthropic RELEASES.json for latest version..."
RELEASES_JSON="$(curl -sSf --max-time 30 --retry 3 --retry-delay 5 "$RELEASES_URL" 2>/dev/null || true)"
if [[ -n "$RELEASES_JSON" ]]; then
  # Extract ZIP download URL from RELEASES.json (use node since it's already required).
  # Structure: { releases: [{ updateTo: { url: "https://...zip" } }] }
  ZIP_URL="$(echo "$RELEASES_JSON" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const u = d?.releases?.[0]?.updateTo?.url || d?.url || '';
    if (u) process.stdout.write(u);
  " 2>/dev/null || true)"
  if [[ -n "$ZIP_URL" && "$ZIP_URL" == *.zip ]]; then
    DOWNLOAD_URL="$ZIP_URL"
    DOWNLOAD_FORMAT="zip"
    DOWNLOAD_FILE="$BUILD_DIR/claude.zip"
    log "Download URL (from RELEASES.json): $DOWNLOAD_URL"
  fi
fi

if [[ -z "$DOWNLOAD_URL" ]]; then
  log "ERROR: Could not resolve download URL from RELEASES.json."
  log "  URL tried: $RELEASES_URL"
  if [[ -n "$RELEASES_JSON" ]]; then log "  Response: $RELEASES_JSON"; else log "  (empty response)"; fi
  exit 1
fi

# ---------------------------------------------------------------------------
# Download — skip if file exists and stored checksum matches.
# ---------------------------------------------------------------------------
_do_download() {
  log "Downloading ($DOWNLOAD_FORMAT)..."
  curl -fSL --progress-bar -o "$DOWNLOAD_FILE" "$DOWNLOAD_URL"
  local file_size
  file_size="$(stat -c%s "$DOWNLOAD_FILE" 2>/dev/null || echo 0)"
  if [[ "$file_size" -lt 1000000 ]]; then
    log "ERROR: Downloaded file is only ${file_size} bytes — likely an error page."
    head -c 500 "$DOWNLOAD_FILE" || true
    exit 1
  fi
}

if [[ "${SKIP_DOWNLOAD:-}" == "1" && -f "$DOWNLOAD_FILE" ]]; then
  log "SKIP_DOWNLOAD=1 — reusing $DOWNLOAD_FILE"
elif [[ -f "$DOWNLOAD_FILE" && -f "${DOWNLOAD_FILE}.sha256" ]]; then
  STORED_SHA=$(cat "${DOWNLOAD_FILE}.sha256")
  ACTUAL_SHA=$(sha256sum "$DOWNLOAD_FILE" | awk '{print $1}')
  if [[ "$STORED_SHA" == "$ACTUAL_SHA" ]]; then
    log "File already present and checksum matches — skipping download."
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
sha256sum "$DOWNLOAD_FILE" | awk '{print $1}' > "${DOWNLOAD_FILE}.sha256"
log "SHA256: $(cat "${DOWNLOAD_FILE}.sha256")"

# ---------------------------------------------------------------------------
# Extract application contents
# ---------------------------------------------------------------------------
EXTRACT_DIR="$BUILD_DIR/dmg-contents"
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"

if [[ "$DOWNLOAD_FORMAT" == "zip" ]]; then
  log "Extracting ZIP archive..."
  unzip -q -o "$DOWNLOAD_FILE" -d "$EXTRACT_DIR"
else
  # Legacy DMG path: convert to raw image, then extract with 7z.
  IMG_FILE="$BUILD_DIR/claude.img"
  log "Converting DMG to raw image with dmg2img..."
  dmg2img -i "$DOWNLOAD_FILE" -o "$IMG_FILE"
  log "Extracting raw image with 7z..."
  7z x -o"$EXTRACT_DIR" "$IMG_FILE" -y -bd 2>/dev/null || true
fi

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
  find "$EXTRACT_DIR" | head -60
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
# Copy extra resources (i18n, etc.) into app-extracted so they are in the
# repacked asar.  The app loads resources/i18n/en-US.json relative to
# app.getAppPath(), which resolves inside the asar.
# ---------------------------------------------------------------------------
log "Searching for i18n / resource files in extracted bundle..."
# Diagnostic: show where any i18n files live in the full extraction.
find "$EXTRACT_DIR" -name "*.json" -path "*/i18n/*" 2>/dev/null | head -20 | while read -r f; do
  log "  found: $f"
done

RESOURCES_SRC_DIR="$(dirname "$ASAR_SRC")"
COPIED_EXTRA=0

# Search several candidate locations where i18n files may reside.
I18N_CANDIDATES=(
  "$RESOURCES_SRC_DIR/resources/i18n"
  "$RESOURCES_SRC_DIR/i18n"
  "${ASAR_SRC}.unpacked/resources/i18n"
  "${ASAR_SRC}.unpacked/i18n"
)
# Also search the whole extracted tree for any i18n directory.
while IFS= read -r candidate; do
  I18N_CANDIDATES+=("$candidate")
done < <(find "$EXTRACT_DIR" -type d -name "i18n" 2>/dev/null)

for candidate in "${I18N_CANDIDATES[@]}"; do
  if [[ -d "$candidate" ]] && ls "$candidate"/*.json &>/dev/null; then
    mkdir -p "$APP_DIR/resources/i18n"
    cp -a "$candidate"/*.json "$APP_DIR/resources/i18n/"
    log "Copied i18n files from: $candidate"
    COPIED_EXTRA=$((COPIED_EXTRA + 1))
    break
  fi
done

# Fallback: if no i18n files were found anywhere, create a minimal stub
# so the app doesn't crash on launch.  The app uses i18n for UI strings
# and falls back to English keys when a translation is missing.
if [[ ! -f "$APP_DIR/resources/i18n/en-US.json" ]]; then
  log "WARNING: en-US.json not found in bundle — creating minimal stub."
  mkdir -p "$APP_DIR/resources/i18n"
  echo '{}' > "$APP_DIR/resources/i18n/en-US.json"
  COPIED_EXTRA=$((COPIED_EXTRA + 1))
fi

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
# Search order:
#   1. claude.icns (case-insensitive) — explicit app icon name
#   2. any *.icns that is not electron.icns — other bundled icons
#   3. electron.icns — Electron apps replace this file with the real app icon
ICNS_FILE=$(find "$RESOURCES_DIR" -iname "claude.icns" | head -1 || true)
if [[ -z "$ICNS_FILE" ]]; then
  ICNS_FILE=$(find "$RESOURCES_DIR" -iname "*.icns" ! -iname "electron.icns" | head -1 || true)
fi
if [[ -z "$ICNS_FILE" ]]; then
  ICNS_FILE=$(find "$RESOURCES_DIR" -iname "electron.icns" | head -1 || true)
fi
if [[ -z "$ICNS_FILE" ]]; then
  ICNS_FILE=$(find "$EXTRACT_DIR" -iname "*.icns" | head -1 || true)
fi

ICONS_DIR="$REPO_DIR/packaging/icons"
mkdir -p "$ICONS_DIR"
ICON_COUNT=0

if [[ -n "$ICNS_FILE" ]]; then
  log "Extracting icons from: $ICNS_FILE"

  # Strategy 1: icns2png (libicns-utils) — native icns decoder, extracts all
  # sizes at once into <name>_<size>x<size>x<depth>.png files.
  if command -v icns2png &>/dev/null; then
    ICNS_TMP="$(mktemp -d)"
    if icns2png -x -d 32 "$ICNS_FILE" -o "$ICNS_TMP" 2>/dev/null; then
      for SIZE in 16 32 48 64 128 256 512; do
        # icns2png names files like: electron_<SIZE>x<SIZE>x32.png
        SRC=$(find "$ICNS_TMP" -name "*_${SIZE}x${SIZE}x*.png" | head -1 || true)
        if [[ -n "$SRC" ]]; then
          cp "$SRC" "$ICONS_DIR/claude-${SIZE}.png"
          ICON_COUNT=$((ICON_COUNT + 1))
        else
          # Resize from the largest available
          LARGEST=$(find "$ICNS_TMP" -name "*.png" | sort -V | tail -1 || true)
          if [[ -n "$LARGEST" ]] && command -v convert &>/dev/null; then
            convert "$LARGEST" -resize "${SIZE}x${SIZE}" "$ICONS_DIR/claude-${SIZE}.png" 2>/dev/null \
              && ICON_COUNT=$((ICON_COUNT + 1)) || true
          fi
        fi
      done
    fi
    rm -rf "$ICNS_TMP"
  fi

  # Strategy 2: ImageMagick convert fallback
  if [[ $ICON_COUNT -eq 0 ]] && command -v convert &>/dev/null; then
    log "icns2png produced no icons — falling back to ImageMagick convert..."
    for SIZE in 16 32 48 64 128 256 512; do
      OUT="$ICONS_DIR/claude-${SIZE}.png"
      if convert -background none "$ICNS_FILE" \
          -resize "${SIZE}x${SIZE}" -flatten "$OUT" 2>/dev/null; then
        ICON_COUNT=$((ICON_COUNT + 1))
      fi
    done
  fi

  if [[ $ICON_COUNT -gt 0 ]]; then
    log "Icons written to $ICONS_DIR"
  else
    log "WARNING: could not extract any icons from $ICNS_FILE"
  fi
else
  log "WARNING: no .icns file found anywhere in extracted bundle — no icons extracted."
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
