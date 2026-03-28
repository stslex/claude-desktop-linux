#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# update-appimage.sh
#
# Wrapper around AppImageUpdate that replaces the original AppImage file
# with the newly downloaded version in-place, keeping a stable filename.
#
# Usage:
#   ./update-appimage.sh [/path/to/claude-desktop.AppImage]
#
# Default path: ~/Apps/claude-desktop.AppImage
# ---------------------------------------------------------------------------

APPIMAGE="${1:-$HOME/Apps/claude-desktop.AppImage}"

if [[ ! -f "$APPIMAGE" ]]; then
    echo "ERROR: AppImage not found: $APPIMAGE" >&2
    exit 1
fi

if ! command -v AppImageUpdate &>/dev/null; then
    echo "ERROR: AppImageUpdate not found. Install it from:" >&2
    echo "  https://github.com/AppImageCommunity/AppImageUpdate/releases" >&2
    exit 1
fi

DIR="$(dirname "$APPIMAGE")"
BASE="$(basename "$APPIMAGE")"

# Snapshot existing AppImages before the update.
BEFORE="$(mktemp)"
find "$DIR" -maxdepth 1 -name "claude-desktop*.AppImage" | sort > "$BEFORE"

echo "Checking for updates: $APPIMAGE"
AppImageUpdate "$APPIMAGE" || true   # AppImageUpdate exits non-zero when already up to date on some versions

# Find files that appeared after the update.
AFTER="$(mktemp)"
find "$DIR" -maxdepth 1 -name "claude-desktop*.AppImage" | sort > "$AFTER"

NEW="$(comm -13 "$BEFORE" "$AFTER" | head -1)"
rm -f "$BEFORE" "$AFTER"

if [[ -z "$NEW" ]]; then
    echo "Already up to date — $BASE unchanged."
    exit 0
fi

echo "Downloaded: $(basename "$NEW")"
rm -f "$APPIMAGE"
mv "$NEW" "$APPIMAGE"
echo "Updated:    $APPIMAGE"
