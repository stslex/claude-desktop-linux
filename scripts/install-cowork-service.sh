#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# install-cowork-service.sh
#
# Downloads and installs the claude-cowork-service daemon from
# https://github.com/patrickjaja/claude-cowork-service/releases
#
# The daemon speaks the same length-prefixed JSON-over-Unix-socket protocol
# that Claude Desktop uses on Windows (named pipe) and macOS (vsock).  On
# Linux it listens on a Unix domain socket and delegates to os/exec — no VM.
#
# Idempotent: re-running updates the binary and restarts the service.
#
# Requirements:
#   - curl or wget
#   - systemd (for user service management)
#   - sha256sum (for binary verification)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [install-cowork-service] $*"
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="cowork-svc-linux"
BINARY_PATH="$INSTALL_DIR/$BINARY_NAME"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="claude-cowork"
SERVICE_FILE="$SYSTEMD_DIR/${SERVICE_NAME}.service"
SOCKET_NAME="cowork-vm-service.sock"

GITHUB_REPO="patrickjaja/claude-cowork-service"
GITHUB_API="https://api.github.com/repos/$GITHUB_REPO/releases/latest"

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
check_dep() {
  if ! command -v "$1" &>/dev/null; then
    log "ERROR: '$1' not found. $2"
    exit 1
  fi
}

check_dep node "Install Node.js (required for JSON parsing)."
check_dep systemctl "This script requires systemd. Non-systemd systems are not supported."
check_dep sha256sum "Install coreutils."

DOWNLOADER=""
if command -v curl &>/dev/null; then
  DOWNLOADER="curl"
elif command -v wget &>/dev/null; then
  DOWNLOADER="wget"
else
  log "ERROR: Neither curl nor wget found. Install one of them."
  exit 1
fi

# ---------------------------------------------------------------------------
# Detect architecture
# ---------------------------------------------------------------------------
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH_SUFFIX="amd64" ;;
  aarch64) ARCH_SUFFIX="arm64" ;;
  *)
    log "ERROR: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

log "Detected architecture: $ARCH ($ARCH_SUFFIX)"

# ---------------------------------------------------------------------------
# Fetch latest release info
# ---------------------------------------------------------------------------
log "Fetching latest release from $GITHUB_REPO..."

RELEASE_JSON=""
if [[ "$DOWNLOADER" == "curl" ]]; then
  RELEASE_JSON="$(curl -fsSL "$GITHUB_API")" || {
    log "ERROR: Failed to fetch release info from GitHub API."
    exit 1
  }
else
  RELEASE_JSON="$(wget -qO- "$GITHUB_API")" || {
    log "ERROR: Failed to fetch release info from GitHub API."
    exit 1
  }
fi

# Extract the download URL for the correct architecture binary.
# The release assets follow the pattern: cowork-svc-linux-<arch>
# or claude-cowork-service-linux-<arch> or similar.
DOWNLOAD_URL=""
DOWNLOAD_URL="$(echo "$RELEASE_JSON" | \
  node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const assets = data.assets || [];
    const archPatterns = ['linux-${ARCH_SUFFIX}', 'linux_${ARCH_SUFFIX}', '${ARCH}'];
    for (const asset of assets) {
      const name = asset.name.toLowerCase();
      if (name.includes('linux') && !name.endsWith('.sha256') && !name.endsWith('.md5')) {
        for (const pat of archPatterns) {
          if (name.includes(pat)) {
            process.stdout.write(asset.browser_download_url);
            process.exit(0);
          }
        }
      }
    }
    // If no arch-specific match, try any linux binary
    for (const asset of assets) {
      const name = asset.name.toLowerCase();
      if (name.includes('linux') && !name.endsWith('.sha256') && !name.endsWith('.md5') && !name.endsWith('.txt')) {
        process.stdout.write(asset.browser_download_url);
        process.exit(0);
      }
    }
    process.exit(1);
  " 2>/dev/null)" || true

if [[ -z "$DOWNLOAD_URL" ]]; then
  log "ERROR: Could not find a Linux $ARCH_SUFFIX binary in the latest release."
  log "Available assets:"
  echo "$RELEASE_JSON" | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    (data.assets || []).forEach(a => console.error('  - ' + a.name));
  " 2>&1 || true
  exit 1
fi

# Also look for a .sha256 file for the binary
SHA256_URL=""
SHA256_URL="$(echo "$RELEASE_JSON" | \
  node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const assets = data.assets || [];
    const binaryUrl = '${DOWNLOAD_URL}';
    const binaryName = binaryUrl.split('/').pop();
    for (const asset of assets) {
      if (asset.name === binaryName + '.sha256' || asset.name === binaryName + '.sha256sum') {
        process.stdout.write(asset.browser_download_url);
        process.exit(0);
      }
    }
    process.exit(1);
  " 2>/dev/null)" || true

RELEASE_TAG="$(echo "$RELEASE_JSON" | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(data.tag_name || 'unknown');
" 2>/dev/null)" || RELEASE_TAG="unknown"

log "Latest release: $RELEASE_TAG"
log "Download URL: $DOWNLOAD_URL"

# ---------------------------------------------------------------------------
# Download binary
# ---------------------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
TMP_BINARY="$(mktemp)"
trap 'rm -f "$TMP_BINARY"' EXIT

log "Downloading $BINARY_NAME..."
if [[ "$DOWNLOADER" == "curl" ]]; then
  curl -fSL -o "$TMP_BINARY" "$DOWNLOAD_URL"
else
  wget -q -O "$TMP_BINARY" "$DOWNLOAD_URL"
fi

# ---------------------------------------------------------------------------
# SHA256 verification
# ---------------------------------------------------------------------------
ACTUAL_SHA256="$(sha256sum "$TMP_BINARY" | awk '{print $1}')"

if [[ -n "$SHA256_URL" ]]; then
  log "Downloading SHA256 checksum..."
  EXPECTED_SHA256=""
  if [[ "$DOWNLOADER" == "curl" ]]; then
    EXPECTED_SHA256="$(curl -fsSL "$SHA256_URL" | awk '{print $1}')"
  else
    EXPECTED_SHA256="$(wget -qO- "$SHA256_URL" | awk '{print $1}')"
  fi

  if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
    log "ERROR: SHA256 mismatch!"
    log "  Expected: $EXPECTED_SHA256"
    log "  Actual:   $ACTUAL_SHA256"
    exit 1
  fi
  log "SHA256 verified: $ACTUAL_SHA256"
else
  log "WARNING: No .sha256 file found in release. Recording checksum for audit."
  log "SHA256: $ACTUAL_SHA256"
fi

# Store checksum alongside binary
echo "$ACTUAL_SHA256  $BINARY_NAME" > "$BINARY_PATH.sha256" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Install binary
# ---------------------------------------------------------------------------
mv "$TMP_BINARY" "$BINARY_PATH"
chmod 755 "$BINARY_PATH"
trap - EXIT  # binary moved, no temp to clean
log "Installed $BINARY_PATH"

# ---------------------------------------------------------------------------
# Create systemd user service
# ---------------------------------------------------------------------------
mkdir -p "$SYSTEMD_DIR"

cat > "$SERVICE_FILE" <<'UNIT'
[Unit]
Description=Claude Cowork Service (Linux native backend)
After=default.target

[Service]
Type=simple
ExecStart=%h/.local/bin/cowork-svc-linux
Restart=on-failure
RestartSec=5
Environment=XDG_RUNTIME_DIR=%t

[Install]
WantedBy=default.target
UNIT

log "Created systemd user service: $SERVICE_FILE"

# ---------------------------------------------------------------------------
# Enable and start the service
# ---------------------------------------------------------------------------
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

log "Service enabled and started."

# ---------------------------------------------------------------------------
# Verify socket
# ---------------------------------------------------------------------------
XDG_RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
SOCKET_PATH="$XDG_RUNTIME/$SOCKET_NAME"

# Give the service a moment to create the socket
for i in 1 2 3 4 5; do
  if [[ -S "$SOCKET_PATH" ]]; then
    break
  fi
  sleep 1
done

if [[ -S "$SOCKET_PATH" ]]; then
  log "OK: Socket exists at $SOCKET_PATH"
else
  log "WARNING: Socket not found at $SOCKET_PATH after 5s."
  log "Check service status: systemctl --user status $SERVICE_NAME"
  log "Check service logs:   journalctl --user -u $SERVICE_NAME -f"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log "------------------------------------------------------------"
log "Installation complete."
log "  Binary:  $BINARY_PATH"
log "  Service: $SERVICE_FILE"
log "  Socket:  $SOCKET_PATH"
log "  Version: $RELEASE_TAG"
log ""
log "Useful commands:"
log "  systemctl --user status $SERVICE_NAME"
log "  journalctl --user -u $SERVICE_NAME -f"
log "  systemctl --user restart $SERVICE_NAME"
log "------------------------------------------------------------"
