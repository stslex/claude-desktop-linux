#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# validate-bundle.sh
#
# Standalone JS syntax validation for the patched bundle.
# Runs acorn on every .js file in .vite/build/ and on native module stubs.
# Can be called from patch-cowork.sh (belt-and-suspenders) or independently
# in CI as a separate validation step.
#
# Env vars:
#   BUILD_DIR   default: /tmp/claude-build
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-/tmp/claude-build}"
APP_DIR="$BUILD_DIR/app-extracted"

log() { printf '[%s] [validate-bundle] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }

log "Validating JavaScript syntax in patched bundle..."

# ---------------------------------------------------------------------------
# Locate the .vite/build directory (same logic as patch-cowork.sh)
# ---------------------------------------------------------------------------
VITE_BUILD_DIR=""

if [[ -d "$APP_DIR/.vite/build" ]]; then
  VITE_BUILD_DIR="$APP_DIR/.vite/build"
else
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
# Ensure acorn is available
# ---------------------------------------------------------------------------
if ! node -e "require('acorn')" 2>/dev/null; then
  log "Installing acorn..."
  npm install --prefix "$REPO_DIR" acorn
fi

# ---------------------------------------------------------------------------
# Validate all .js files in the build directory
# ---------------------------------------------------------------------------
FAILED=0
CHECKED=0

while IFS= read -r -d '' js_file; do
  [[ -f "$js_file" ]] || continue
  CHECKED=$((CHECKED + 1))

  if ! (
    cd "$REPO_DIR" &&
    node -e "
      const acorn = require('acorn');
      const fs = require('fs');
      const path = require('path');
      const file = process.argv[1];
      const src = fs.readFileSync(file, 'utf8');
      try {
        acorn.parse(src, {
          ecmaVersion: 'latest',
          sourceType: 'module',
          allowHashBang: true,
          allowReturnOutsideFunction: true,
        });
      } catch (e1) {
        try {
          acorn.parse(src, {
            ecmaVersion: 'latest',
            sourceType: 'script',
            allowHashBang: true,
            allowReturnOutsideFunction: true,
          });
        } catch (e2) {
          console.error('SYNTAX ERROR in ' + path.basename(file) + ':');
          console.error('  ' + e2.message);
          console.error('  at byte offset ' + (e2.pos || 'unknown'));
          process.exit(1);
        }
      }
    " "$js_file"
  ) 2>&1; then
    log "FAIL: $(basename "$js_file") has syntax errors"
    FAILED=1
  fi
done < <(find "$VITE_BUILD_DIR" -type f \( -name '*.js' -o -name '*.mjs' \) -print0)

# ---------------------------------------------------------------------------
# Validate native module stubs
# ---------------------------------------------------------------------------
for stub_file in "$APP_DIR/node_modules/@ant/claude-native/index.js" \
                 "$APP_DIR/node_modules/@ant/claude-swift/index.js"; do
  [[ -f "$stub_file" ]] || continue
  CHECKED=$((CHECKED + 1))
  if ! node -c "$stub_file" 2>/dev/null; then
    log "FAIL: stub $(basename "$(dirname "$stub_file")")/index.js has syntax errors"
    FAILED=1
  fi
done

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if [[ "$FAILED" == "1" ]]; then
  log "FATAL: Bundle validation failed ($CHECKED files checked). NOT safe to repack asar. Fix patches and retry."
  exit 1
fi

log "Bundle validation passed ($CHECKED files checked)."
