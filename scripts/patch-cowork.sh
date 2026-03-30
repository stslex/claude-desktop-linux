#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# patch-cowork.sh
#
# Apply two patches to the main-process bundle:
#
#   1. Platform-gate patch  — replace the Cowork availability-check function
#      body with an unconditional `return { status: "supported" }` using the
#      AST-based find + apply pair in patches/.
#
#   2. Path-translator injection — prepend a one-line require() of
#      patches/path-translator.mjs so path/fs monkey-patching is active
#      from the first tick of the main process.
#
# Does NOT repack the ASAR — that is done once by build-packages.sh.
#
# Env vars:
#   BUILD_DIR          default: /tmp/claude-build
#   SKIP_COWORK_PATCH  set to 1 to skip this script entirely
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [patch-cowork] $*"
}

# ---------------------------------------------------------------------------
# Skip flag
# ---------------------------------------------------------------------------
if [[ "${SKIP_COWORK_PATCH:-}" == "1" ]]; then
  log "Skipping Cowork patch"
  exit 0
fi

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
BUILD_DIR="${BUILD_DIR:-/tmp/claude-build}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCHES_DIR="$REPO_DIR/patches"

GUARD="$BUILD_DIR/.patch-cowork-done"
if [[ -f "$GUARD" ]]; then
  log "Already done (remove $GUARD to re-run)."
  exit 0
fi

APP_DIR="$BUILD_DIR/app-extracted"

# ---------------------------------------------------------------------------
# Verify app-extracted/ exists
# ---------------------------------------------------------------------------
if [[ ! -d "$APP_DIR" ]]; then
  log "ERROR: $APP_DIR not found. Run fetch-and-extract.sh first."
  exit 1
fi

# ---------------------------------------------------------------------------
# Find the .vite/build/ directory (or an accepted alternative)
# ---------------------------------------------------------------------------
VITE_BUILD_DIR=""

if [[ -d "$APP_DIR/.vite/build" ]]; then
  VITE_BUILD_DIR="$APP_DIR/.vite/build"
else
  log "WARNING: $APP_DIR/.vite/build not found — trying alternative locations..."
  for candidate in \
    "$APP_DIR/dist" \
    "$APP_DIR/build" \
    "$APP_DIR/out" \
    "$APP_DIR/resources/app/.vite/build" \
    "$APP_DIR/resources/app/dist"
  do
    if [[ -d "$candidate" ]] && compgen -G "$candidate/*.js" > /dev/null 2>&1; then
      VITE_BUILD_DIR="$candidate"
      log "Using alternative build directory: $VITE_BUILD_DIR"
      break
    fi
  done
fi

if [[ -z "$VITE_BUILD_DIR" ]]; then
  log "ERROR: Could not find .vite/build/ or any alternative build directory under $APP_DIR"
  exit 1
fi

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
check_dep() {
  if ! command -v "$1" &>/dev/null; then
    log "ERROR: '$1' not found. $2"
    exit 1
  fi
}

check_dep node "Install Node.js >= 20."
check_dep npx  "Comes with Node.js."

if ! node --input-type=module -e "await import('acorn'); await import('acorn-walk');" 2>/dev/null; then
  log "Installing acorn and acorn-walk..."
  npm install --prefix "$REPO_DIR" acorn acorn-walk
fi

# ---------------------------------------------------------------------------
# Patch 1 — Find platform gate
# ---------------------------------------------------------------------------
# Scan the main build dir first; if not found, try the whole app-extracted/
# tree (covers renderer bundles and alternative layouts).
GATE_JSON="$BUILD_DIR/gate-location.json"
FIND_LOG="$BUILD_DIR/patch-find.log"
FIND_EXIT=1

for SCAN_DIR in "$VITE_BUILD_DIR" "$APP_DIR"; do
  log "Searching for platform-gate function(s) in $SCAN_DIR..."
  set +e
  node "$PATCHES_DIR/find-platform-gate.mjs" "$SCAN_DIR" \
    --all \
    --output "$GATE_JSON" \
    2>"$FIND_LOG"
  FIND_EXIT=$?
  set -e

  if [[ $FIND_EXIT -eq 0 ]]; then
    break
  fi

  log "Not found in $SCAN_DIR (exit $FIND_EXIT) — trying next location..."
  cat "$FIND_LOG" >&2
done

if [[ $FIND_EXIT -ne 0 ]]; then
  log "ERROR: find-platform-gate.mjs failed in all scan directories. Log preserved at $FIND_LOG"
  log "Re-running with --dump-candidates for additional diagnostics..."
  node "$PATCHES_DIR/find-platform-gate.mjs" "$APP_DIR" \
    --dump-candidates >> "$FIND_LOG" 2>&1 || true
  exit 1
fi

log "Gate location(s): $(cat "$GATE_JSON")"

# Extract a summary of found gates (file + count) for the log message.
GATE_SUMMARY="$(node -e \
  "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
   if(j.gates){process.stdout.write(j.gates.length+' gate(s) across '+[...new Set(j.gates.map(g=>g.file))].length+' file(s)');}
   else{process.stdout.write('1 gate: '+j.file+' ['+j.start+'..'+j.end+']');}" \
  -- "$GATE_JSON" 2>/dev/null || echo "unknown")"

# ---------------------------------------------------------------------------
# Patch 1 — Apply platform gate
# ---------------------------------------------------------------------------
log "Applying platform-gate patch ($GATE_SUMMARY)..."

APPLY_LOG="$BUILD_DIR/patch-apply.log"

set +e
node "$PATCHES_DIR/apply-platform-gate.mjs" \
  --input "$GATE_JSON" \
  2>"$APPLY_LOG"
APPLY_EXIT=$?
set -e

if [[ $APPLY_EXIT -ne 0 ]]; then
  log "ERROR: apply-platform-gate.mjs failed (exit $APPLY_EXIT). Log preserved at $APPLY_LOG"
  cat "$APPLY_LOG" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Patch 2 — CCD platform: add linux-x64/linux-arm64 support
# ---------------------------------------------------------------------------
log "Locating CCD getHostPlatform / getBinaryPathIfReady..."

CCD_FIND_LOG="$BUILD_DIR/patch-ccd-find.log"
CCD_JSON="$BUILD_DIR/ccd-platform-location.json"

set +e
node "$PATCHES_DIR/find-ccd-platform.mjs" \
  2>"$CCD_FIND_LOG"
CCD_FIND_EXIT=$?
set -e

cat "$CCD_FIND_LOG" >&2

if [[ $CCD_FIND_EXIT -ne 0 ]]; then
  log "WARNING: find-ccd-platform.mjs failed — plugins will show 'Unsupported platform' on Linux."
else
  CCD_APPLY_LOG="$BUILD_DIR/patch-ccd-apply.log"
  set +e
  node "$PATCHES_DIR/apply-ccd-platform.mjs" \
    --input "$CCD_JSON" \
    2>"$CCD_APPLY_LOG"
  CCD_APPLY_EXIT=$?
  set -e
  cat "$CCD_APPLY_LOG" >&2
  if [[ $CCD_APPLY_EXIT -ne 0 ]]; then
    log "WARNING: apply-ccd-platform.mjs failed — plugins may not work on Linux."
  else
    log "CCD platform patch applied."
  fi
fi

# ---------------------------------------------------------------------------
# Patch 3 — VM download step: skip on Linux
# ---------------------------------------------------------------------------
log "Locating VM download step (download_and_sdk_prepare)..."

VM_DL_FIND_LOG="$BUILD_DIR/patch-vm-dl-find.log"
VM_DL_JSON="$BUILD_DIR/vm-download-location.json"

set +e
node "$PATCHES_DIR/find-vm-download.mjs" \
  2>"$VM_DL_FIND_LOG"
VM_DL_FIND_EXIT=$?
set -e

cat "$VM_DL_FIND_LOG" >&2

if [[ $VM_DL_FIND_EXIT -ne 0 ]]; then
  log "WARNING: find-vm-download.mjs failed — VM download step will not be skipped on Linux."
else
  VM_DL_APPLY_LOG="$BUILD_DIR/patch-vm-dl-apply.log"
  set +e
  node "$PATCHES_DIR/apply-vm-download.mjs" \
    --input "$VM_DL_JSON" \
    2>"$VM_DL_APPLY_LOG"
  VM_DL_APPLY_EXIT=$?
  set -e
  cat "$VM_DL_APPLY_LOG" >&2
  if [[ $VM_DL_APPLY_EXIT -ne 0 ]]; then
    log "WARNING: apply-vm-download.mjs failed — VM download step will not be skipped on Linux."
  else
    log "VM download step patched (returns early on Linux)."
  fi
fi

# ---------------------------------------------------------------------------
# Patch 4 — Find main entry point
# ---------------------------------------------------------------------------
log "Locating main entry point..."

MAIN_ENTRY=""
PKG_JSON="$APP_DIR/package.json"

if [[ -f "$PKG_JSON" ]]; then
  MAIN_FIELD="$(node -e \
    "try{const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(p.main)process.stdout.write(p.main);}catch(e){}" \
    -- "$PKG_JSON" 2>/dev/null || true)"
  if [[ -n "$MAIN_FIELD" ]]; then
    if [[ "$MAIN_FIELD" = /* ]]; then
      CANDIDATE="$MAIN_FIELD"
    else
      CANDIDATE="$APP_DIR/$MAIN_FIELD"
    fi
    if [[ -f "$CANDIDATE" ]]; then
      MAIN_ENTRY="$CANDIDATE"
      log "Found main entry from package.json: $MAIN_ENTRY"
    else
      log "WARNING: package.json main='$MAIN_FIELD' → $CANDIDATE not found; trying fallbacks."
    fi
  fi
fi

if [[ -z "$MAIN_ENTRY" ]]; then
  for candidate in \
    "$APP_DIR/.vite/build/index.js" \
    "$APP_DIR/.vite/build/main.js" \
    "$VITE_BUILD_DIR/index.js" \
    "$VITE_BUILD_DIR/main.js" \
    "$APP_DIR/dist/main.js" \
    "$APP_DIR/build/main.js" \
    "$APP_DIR/index.js"
  do
    if [[ -f "$candidate" ]]; then
      MAIN_ENTRY="$candidate"
      log "Found main entry via fallback pattern: $MAIN_ENTRY"
      break
    fi
  done
fi

if [[ -z "$MAIN_ENTRY" ]]; then
  log "ERROR: Could not locate main entry point under $APP_DIR"
  exit 1
fi

# ---------------------------------------------------------------------------
# Patch 2 — Prepend path-translator and open-url-bridge (idempotent)
# ---------------------------------------------------------------------------
# The main bundle is CJS (uses require()).  Prepending an `import` statement
# would force Node to reparse the file as ESM, breaking every require() call.
# So we convert path-translator from ESM to CJS on the fly and use require().
#
# Both helper files are copied into the same directory as the main entry so
# the require() uses a relative path — avoids baking an absolute CI build
# path into the asar.
MAIN_ENTRY_DIR="$(dirname "$MAIN_ENTRY")"

# -- path-translator ---------------------------------------------------------
TRANSLATOR_SRC="$PATCHES_DIR/path-translator.mjs"
TRANSLATOR_DEST="$MAIN_ENTRY_DIR/path-translator.js"
sed \
  -e "s/^import path from 'path';/const path = require('path');/" \
  -e "s/^import fs   from 'fs';/const fs   = require('fs');/" \
  -e "s/^import os   from 'os';/const os   = require('os');/" \
  -e "s/^export function translatePath/module.exports.translatePath = function translatePath/" \
  "$TRANSLATOR_SRC" > "$TRANSLATOR_DEST"
log "Copied path-translator to $TRANSLATOR_DEST"

# -- open-url-bridge (already CJS, just copy) --------------------------------
BRIDGE_SRC="$PATCHES_DIR/open-url-bridge.js"
BRIDGE_DEST="$MAIN_ENTRY_DIR/open-url-bridge.js"
cp "$BRIDGE_SRC" "$BRIDGE_DEST"
log "Copied open-url-bridge to $BRIDGE_DEST"

# -- native-frame (already CJS, just copy) ------------------------------------
FRAME_SRC="$PATCHES_DIR/native-frame.js"
FRAME_DEST="$MAIN_ENTRY_DIR/native-frame.js"
cp "$FRAME_SRC" "$FRAME_DEST"
log "Copied native-frame to $FRAME_DEST"

# -- app icon (for BrowserWindow) ----------------------------------------------
# Copy the best available icon next to native-frame.js so it can load it.
# Prefer the largest extracted PNG; fall back to the bundled SVG.
ICONS_DIR="$REPO_DIR/packaging/icons"
ICON_COPIED=""
if [[ -d "$ICONS_DIR" ]] && ls "$ICONS_DIR"/claude-*.png &>/dev/null; then
  # Pick the largest PNG (e.g. claude-512.png)
  BEST_PNG="$(find "$ICONS_DIR" -maxdepth 1 -name 'claude-*.png' | sort -V | tail -1)"
  if [[ -n "$BEST_PNG" ]]; then
    cp "$BEST_PNG" "$MAIN_ENTRY_DIR/claude-desktop.png"
    ICON_COPIED="$BEST_PNG"
    log "Copied app icon (PNG) to $MAIN_ENTRY_DIR/claude-desktop.png"
  fi
fi
if [[ -z "$ICON_COPIED" ]]; then
  SVG_ICON="$REPO_DIR/packaging/claude-desktop.svg"
  if [[ -f "$SVG_ICON" ]]; then
    # Try to convert SVG to PNG for better Electron nativeImage compatibility
    if command -v rsvg-convert &>/dev/null; then
      rsvg-convert -w 256 -h 256 "$SVG_ICON" \
        -o "$MAIN_ENTRY_DIR/claude-desktop.png" 2>/dev/null \
        && ICON_COPIED="svg-converted" \
        && log "Converted SVG to PNG icon at $MAIN_ENTRY_DIR/claude-desktop.png"
    elif command -v convert &>/dev/null; then
      convert -background none "$SVG_ICON" -resize 256x256 \
        "$MAIN_ENTRY_DIR/claude-desktop.png" 2>/dev/null \
        && ICON_COPIED="svg-converted" \
        && log "Converted SVG to PNG icon at $MAIN_ENTRY_DIR/claude-desktop.png"
    fi
    if [[ -z "$ICON_COPIED" ]]; then
      cp "$SVG_ICON" "$MAIN_ENTRY_DIR/claude-desktop.svg"
      ICON_COPIED="svg"
      log "Copied SVG icon to $MAIN_ENTRY_DIR/claude-desktop.svg"
    fi
  else
    log "WARNING: No icon file found — windows will have no custom icon."
  fi
fi

# -- module-load-patch (shared Module._load registry — must be first) ----------
MODULE_LOAD_SRC="$PATCHES_DIR/module-load-patch.js"
MODULE_LOAD_DEST="$MAIN_ENTRY_DIR/module-load-patch.js"
cp "$MODULE_LOAD_SRC" "$MODULE_LOAD_DEST"
log "Copied module-load-patch to $MODULE_LOAD_DEST"

# -- shell-env-patch (already CJS, just copy) ---------------------------------
SHELL_ENV_SRC="$PATCHES_DIR/shell-env-patch.js"
SHELL_ENV_DEST="$MAIN_ENTRY_DIR/shell-env-patch.js"
cp "$SHELL_ENV_SRC" "$SHELL_ENV_DEST"
log "Copied shell-env-patch to $SHELL_ENV_DEST"

# -- platform-override (already CJS, just copy) -------------------------------
PLAT_OVERRIDE_SRC="$PATCHES_DIR/platform-override.js"
PLAT_OVERRIDE_DEST="$MAIN_ENTRY_DIR/platform-override.js"
cp "$PLAT_OVERRIDE_SRC" "$PLAT_OVERRIDE_DEST"
log "Copied platform-override to $PLAT_OVERRIDE_DEST"

# -- Prepend all requires (idempotent: skip if already present) ---------------
if grep -qF 'module-load-patch' "$MAIN_ENTRY"; then
  log "Patches already injected into $MAIN_ENTRY — skipping prepend."
else
  TMPFILE="$(mktemp)"
  {
    echo "require('./module-load-patch.js');"
    echo "require('./shell-env-patch.js');"
    echo "require('./platform-override.js');"
    echo "require('./native-frame.js');"
    echo "require('./open-url-bridge.js');"
    echo "require('./path-translator.js');"
    cat "$MAIN_ENTRY"
  } > "$TMPFILE"
  mv "$TMPFILE" "$MAIN_ENTRY"
  log "Prepended module-load-patch + shell-env-patch + platform-override + native-frame + open-url-bridge + path-translator to $MAIN_ENTRY"
fi

touch "$GUARD"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log "------------------------------------------------------------"
log "Patch summary"
log "  Platform-gate patch : $GATE_SUMMARY (all gates patched to return {status:\"supported\"})"
log "  CCD platform patch  : linux-x64/linux-arm64 added to getHostPlatform + getBinaryPathIfReady"
log "  VM download patch   : download_and_sdk_prepare returns early on Linux"
log "  Patches injected    : $MAIN_ENTRY"
log "    module-load-patch.js (shared Module._load interceptor registry)"
log "    shell-env-patch.js (fix shell path worker not found on Linux)"
log "    platform-override.js (runtime fallback for platform gate)"
log "    native-frame.js    (icon injection + tray click handler for Linux)"
log "    open-url-bridge.js (second-instance → open-url bridge for Linux OAuth)"
log "    path-translator.js (/sessions/… path remapping)"
log "------------------------------------------------------------"
log "Done."
