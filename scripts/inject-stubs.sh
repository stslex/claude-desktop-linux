#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# inject-stubs.sh
#
# Replace the two macOS-native Node.js addons inside the extracted ASAR
# with the pure-JS stubs from stubs/.
#
# Env vars:
#   BUILD_DIR   default: /tmp/claude-build
# ---------------------------------------------------------------------------

BUILD_DIR="${BUILD_DIR:-/tmp/claude-build}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STUBS_DIR="$REPO_DIR/stubs"

GUARD="$BUILD_DIR/.inject-stubs-done"

if [[ -f "$GUARD" ]]; then
  echo "[inject-stubs] Already done (remove $GUARD to re-run)."
  exit 0
fi

APP_DIR="$BUILD_DIR/app-extracted"

if [[ ! -d "$APP_DIR" ]]; then
  echo "[inject-stubs] ERROR: $APP_DIR not found. Run fetch-and-extract.sh first."
  exit 1
fi

# ---------------------------------------------------------------------------
# Helper: replace a native module directory with our stub.
#
# $1 — package name under node_modules (e.g. @ant/claude-native)
# $2 — stub JS file (basename in stubs/)
# $3 — stub package.json file (basename in stubs/)
# ---------------------------------------------------------------------------
inject_stub() {
  local pkg="$1"
  local stub_js="$2"
  local stub_pkg="$3"

  local mod_dir="$APP_DIR/node_modules/$pkg"

  if [[ ! -d "$mod_dir" ]]; then
    echo "[inject-stubs] WARNING: $mod_dir not found — skipping."
    return
  fi

  echo "[inject-stubs] Replacing $pkg ..."

  # Remove everything inside the module directory.
  rm -rf "${mod_dir:?}"/*

  # Copy our stub in place.
  cp "$STUBS_DIR/$stub_js"  "$mod_dir/index.js"
  cp "$STUBS_DIR/$stub_pkg" "$mod_dir/package.json"

  echo "[inject-stubs]   → wrote $mod_dir/index.js + package.json"
}

inject_stub "@ant/claude-native" "claude-native.js" "claude-native-pkg.json"
inject_stub "@ant/claude-swift"  "claude-swift.js"  "claude-swift-pkg.json"

touch "$GUARD"
echo "[inject-stubs] Done."
