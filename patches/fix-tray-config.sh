#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# fix-tray-config.sh
#
# Ensures menuBarEnabled is set to true in ~/.config/Claude/config.json.
#
# Claude Desktop gates tray icon creation behind this config flag, and removes
# the setting on updates. Run this script after updates or before launching
# Claude Desktop to ensure the tray icon remains enabled.
#
# Idempotent: safe to run repeatedly.
# ---------------------------------------------------------------------------

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Claude"
CONFIG_FILE="$CONFIG_DIR/config.json"

# ---------------------------------------------------------------------------
# Case 1: config file does not exist — create it.
# ---------------------------------------------------------------------------
if [[ ! -f "$CONFIG_FILE" ]]; then
  mkdir -p "$CONFIG_DIR"
  echo '{"menuBarEnabled":true}' > "$CONFIG_FILE"
  exit 0
fi

# ---------------------------------------------------------------------------
# Case 2: config file exists and already has menuBarEnabled: true — done.
# ---------------------------------------------------------------------------
if grep -q '"menuBarEnabled"[[:space:]]*:[[:space:]]*true' "$CONFIG_FILE" 2>/dev/null; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Case 3: config file exists but menuBarEnabled is missing or not true.
# Use jq if available; fall back to sed.
# ---------------------------------------------------------------------------
if command -v jq &>/dev/null; then
  # jq: set .menuBarEnabled = true, preserving all other keys.
  TMP="$(mktemp)"
  jq '.menuBarEnabled = true' "$CONFIG_FILE" > "$TMP" && mv "$TMP" "$CONFIG_FILE"
else
  # sed fallback: two sub-cases.
  if grep -q '"menuBarEnabled"' "$CONFIG_FILE" 2>/dev/null; then
    # Key exists but value is not true — replace it.
    sed -i 's/"menuBarEnabled"[[:space:]]*:[[:space:]]*[^,}]*/"menuBarEnabled":true/' "$CONFIG_FILE"
  else
    # Key is absent — inject it after the opening brace.
    sed -i 's/^{/{\"menuBarEnabled\":true,/' "$CONFIG_FILE"
  fi
fi
