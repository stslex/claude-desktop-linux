#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# patch-cowork.sh
#
# Apply two patches to the main-process bundle (.vite/build/index.js):
#
#   1. Platform-gate patch — replace the Cowork availability check function
#      body with an unconditional `return { status: "supported" }` using the
#      AST-based find + apply pair in patches/.
#
#   2. Path-translator injection — prepend a one-line require of
#      patches/path-translator.mjs so path/fs monkey-patching is active
#      from the first tick of the main process.
#
# After patching, repack app-extracted/ back into app.asar.
#
# Env vars:
#   BUILD_DIR   default: /tmp/claude-build
# ---------------------------------------------------------------------------

BUILD_DIR="${BUILD_DIR:-/tmp/claude-build}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCHES_DIR="$REPO_DIR/patches"

GUARD="$BUILD_DIR/.patch-cowork-done"

if [[ -f "$GUARD" ]]; then
  echo "[patch-cowork] Already done (remove $GUARD to re-run)."
  exit 0
fi

APP_DIR="$BUILD_DIR/app-extracted"
BUNDLE="$APP_DIR/.vite/build/index.js"

if [[ ! -f "$BUNDLE" ]]; then
  echo "[patch-cowork] ERROR: $BUNDLE not found. Run fetch-and-extract.sh first."
  exit 1
fi

check_dep() {
  if ! command -v "$1" &>/dev/null; then
    echo "[patch-cowork] ERROR: '$1' not found. $2"
    exit 1
  fi
}

check_dep node  "Install Node.js >= 20."
check_dep npx   "Comes with Node.js."

# Ensure acorn and acorn-walk are available.
# Use top-level await (--input-type=module) so the dynamic imports actually resolve.
if ! node --input-type=module -e "await import('acorn'); await import('acorn-walk');" 2>/dev/null; then
  echo "[patch-cowork] Installing acorn and acorn-walk..."
  npm install --prefix "$REPO_DIR" acorn acorn-walk
fi

# ---------------------------------------------------------------------------
# Patch 1 — Platform gate
# ---------------------------------------------------------------------------
echo "[patch-cowork] Searching for platform-gate function..."

OFFSETS_FILE="$BUILD_DIR/platform-gate-offsets.json"
VITE_BUILD_DIR="$APP_DIR/.vite/build"

if ! node "$PATCHES_DIR/find-platform-gate.mjs" "$VITE_BUILD_DIR" \
     --output "$OFFSETS_FILE" > "$OFFSETS_FILE"; then
  echo "[patch-cowork] ERROR: find-platform-gate.mjs failed."
  echo "[patch-cowork] Re-running with --dump-candidates for diagnostics..."
  node "$PATCHES_DIR/find-platform-gate.mjs" "$VITE_BUILD_DIR" --dump-candidates || true
  exit 1
fi

echo "[patch-cowork] Offsets: $(cat "$OFFSETS_FILE")"
echo "[patch-cowork] Applying platform-gate patch..."

node "$PATCHES_DIR/apply-platform-gate.mjs" "$BUNDLE" "$OFFSETS_FILE"

# ---------------------------------------------------------------------------
# Patch 2 — Path translator injection
# ---------------------------------------------------------------------------
echo "[patch-cowork] Injecting path-translator..."

TRANSLATOR_PATH="$PATCHES_DIR/path-translator.mjs"
PREPEND_LINE="import '$TRANSLATOR_PATH';"

# Only prepend if not already present (idempotency within a single run).
if ! head -1 "$BUNDLE" | grep -qF 'path-translator'; then
  # Prepend via a temp file to avoid reading and writing the same file.
  TMPFILE="$(mktemp)"
  { echo "$PREPEND_LINE"; cat "$BUNDLE"; } > "$TMPFILE"
  mv "$TMPFILE" "$BUNDLE"
  echo "[patch-cowork] Prepended: $PREPEND_LINE"
else
  echo "[patch-cowork] path-translator already injected — skipping prepend."
fi

# ---------------------------------------------------------------------------
# Repack app.asar
# ---------------------------------------------------------------------------
echo "[patch-cowork] Repacking app.asar..."
npx --yes @electron/asar pack "$APP_DIR" "$BUILD_DIR/app.asar"

echo "[patch-cowork] app.asar written to $BUILD_DIR/app.asar"

touch "$GUARD"
echo "[patch-cowork] Done."
