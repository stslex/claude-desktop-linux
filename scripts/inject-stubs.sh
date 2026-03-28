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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_DIR="$BUILD_DIR/app-extracted"

# ---------------------------------------------------------------------------
# Pre-flight: extracted ASAR must exist
# ---------------------------------------------------------------------------
if [[ ! -d "$APP_DIR" ]]; then
  log "ERROR: $APP_DIR not found."
  log "Run scripts/fetch-and-extract.sh first."
  exit 1
fi

# ---------------------------------------------------------------------------
# Target directories
# ---------------------------------------------------------------------------
NATIVE_DIR="$APP_DIR/node_modules/@ant/claude-native"
SWIFT_DIR="$APP_DIR/node_modules/@ant/claude-swift"

mkdir -p "$NATIVE_DIR"
mkdir -p "$SWIFT_DIR"

# ---------------------------------------------------------------------------
# Copy stubs (overwrites on re-run — idempotent)
# ---------------------------------------------------------------------------
log "Injecting @ant/claude-native stub..."
cp "$REPO_DIR/stubs/claude-native.js"       "$NATIVE_DIR/index.js"
cp "$REPO_DIR/stubs/claude-native-pkg.json"  "$NATIVE_DIR/package.json"

log "Injecting @ant/claude-swift stub..."
cp "$REPO_DIR/stubs/claude-swift.js"        "$SWIFT_DIR/index.js"
cp "$REPO_DIR/stubs/claude-swift-pkg.json"   "$SWIFT_DIR/package.json"

# ---------------------------------------------------------------------------
# Smoke checks — each stub must be require()-able by Node
# ---------------------------------------------------------------------------
log "Running smoke checks..."

if ! node -e "require('$NATIVE_DIR')" 2>/dev/null; then
  log "ERROR: smoke check failed for @ant/claude-native"
  node -e "require('$NATIVE_DIR')" || true
  exit 1
fi
log "  @ant/claude-native  OK"

if ! node -e "require('$SWIFT_DIR')" 2>/dev/null; then
  log "ERROR: smoke check failed for @ant/claude-swift"
  node -e "require('$SWIFT_DIR')" || true
  exit 1
fi
log "  @ant/claude-swift   OK"

# ---------------------------------------------------------------------------
# Summary with file sizes
# ---------------------------------------------------------------------------
NATIVE_JS_SIZE=$(du -sh "$NATIVE_DIR/index.js"      | awk '{print $1}')
NATIVE_PKG_SIZE=$(du -sh "$NATIVE_DIR/package.json" | awk '{print $1}')
SWIFT_JS_SIZE=$(du -sh "$SWIFT_DIR/index.js"        | awk '{print $1}')
SWIFT_PKG_SIZE=$(du -sh "$SWIFT_DIR/package.json"   | awk '{print $1}')

log "------------------------------------------------------------"
log "Stubs injected successfully"
log "  $NATIVE_DIR/index.js    ($NATIVE_JS_SIZE)"
log "  $NATIVE_DIR/package.json ($NATIVE_PKG_SIZE)"
log "  $SWIFT_DIR/index.js     ($SWIFT_JS_SIZE)"
log "  $SWIFT_DIR/package.json  ($SWIFT_PKG_SIZE)"
log "------------------------------------------------------------"
log "Done."
