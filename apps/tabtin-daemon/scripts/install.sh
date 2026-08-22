#!/usr/bin/env bash
set -euo pipefail

# TabTin Agent Daemon Installer
# Usage: curl -fsSL https://install.example.com | bash -s -- --token "eyJ..."

TABTIN_DAEMON_PKG="@tabtin/daemon"
MIN_NODE_VERSION=18
INSTALL_DIR="$HOME/.tabtin-daemon"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[tabtin]${NC} $*"; }
ok()   { echo -e "${GREEN}[tabtin]${NC} $*"; }
warn() { echo -e "${YELLOW}[tabtin]${NC} $*"; }
err()  { echo -e "${RED}[tabtin]${NC} $*" >&2; }

cleanup_on_error() {
  err "Installation failed. Please check the error above."
  err "If the issue persists, try manual installation:"
  err "  1. Install Node.js >= ${MIN_NODE_VERSION}: https://nodejs.org"
  err "  2. npm install -g ${TABTIN_DAEMON_PKG}"
  err "  3. tabtin-daemon init --token <your-token>"
  exit 1
}
trap cleanup_on_error ERR

TOKEN=""
SERVER=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --token)  TOKEN="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$TOKEN" ]]; then
  err "Missing --token. Usage:"
  err "  curl -fsSL https://install.example.com | bash -s -- --token \"eyJ...\""
  exit 1
fi

# --- OS Detection ---
detect_os() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    x86_64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
  esac
  echo "${os}-${arch}"
}

PLATFORM=$(detect_os)
log "Platform: $PLATFORM"

# --- Node.js Check/Install ---
check_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [[ "$ver" -ge "$MIN_NODE_VERSION" ]]; then
      ok "Node.js $(node -v) found"
      return 0
    else
      warn "Node.js $(node -v) is too old (need >= $MIN_NODE_VERSION)"
    fi
  fi
  return 1
}

install_node() {
  log "Installing Node.js..."

  if command -v fnm &>/dev/null; then
    log "Using fnm..."
    fnm install "$MIN_NODE_VERSION" && fnm use "$MIN_NODE_VERSION"
    return 0
  fi

  if command -v nvm &>/dev/null; then
    log "Using nvm..."
    nvm install "$MIN_NODE_VERSION" && nvm use "$MIN_NODE_VERSION"
    return 0
  fi

  # Direct binary download as fallback
  local os_name arch_name
  os_name="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch_name="$(uname -m)"
  case "$arch_name" in
    x86_64) arch_name="x64" ;;
    aarch64|arm64) arch_name="arm64" ;;
  esac

  local node_ver="v20.18.0"
  local tarball="node-${node_ver}-${os_name}-${arch_name}.tar.xz"
  local url="https://nodejs.org/dist/${node_ver}/${tarball}"

  log "Downloading Node.js ${node_ver}..."
  local tmp_dir
  tmp_dir=$(mktemp -d)
  curl -sSL "$url" | tar -xJ -C "$tmp_dir"

  local node_dir="${tmp_dir}/node-${node_ver}-${os_name}-${arch_name}"
  mkdir -p "$INSTALL_DIR/node"
  cp -r "$node_dir"/* "$INSTALL_DIR/node/"
  rm -rf "$tmp_dir"

  export PATH="$INSTALL_DIR/node/bin:$PATH"
  ok "Node.js $(node -v) installed to $INSTALL_DIR/node"
}

if ! check_node; then
  install_node
fi

# --- Install Daemon ---
DAEMON_VERSION="${TABTIN_DAEMON_VERSION:-latest}"
TARBALL_URL="https://releases.example.com/daemon/tabtin-daemon-${DAEMON_VERSION}.tgz"

install_from_npm() {
  log "Installing from npm registry..."
  npm install -g "${TABTIN_DAEMON_PKG}@${DAEMON_VERSION}" 2>&1
}

install_from_tarball() {
  log "Installing from tarball: $TARBALL_URL"
  npm install -g "$TARBALL_URL" 2>&1
}

log "Installing TabTin Daemon (${DAEMON_VERSION})..."
if ! install_from_npm 2>/dev/null; then
  warn "npm registry install failed, trying tarball download..."
  if ! install_from_tarball; then
    err "Installation failed."
    err "Possible causes:"
    err "  - No network access (proxy required?)"
    err "  - Permission denied (try with sudo)"
    err "  - Package not yet available"
    exit 1
  fi
fi

# --- Initialize ---
log "Initializing daemon..."
INIT_ARGS="--token-stdin"
if [[ -n "$SERVER" ]]; then
  INIT_ARGS="$INIT_ARGS --server $SERVER"
fi

echo "$TOKEN" | tabtin-daemon init $INIT_ARGS

# --- Install System Service & Start ---
log "Installing system service..."
SERVICE_INSTALLED=0
tabtin-daemon service install 2>/dev/null && SERVICE_INSTALLED=1 || {
  warn "System service installation skipped (may need sudo)"
  warn "You can install it manually: sudo tabtin-daemon service install"
}

log "Starting daemon..."
if [[ "$SERVICE_INSTALLED" -eq 1 ]]; then
  tabtin-daemon service start 2>/dev/null || tabtin-daemon start || {
    warn "Auto-start failed. Please start manually: tabtin-daemon start"
  }
else
  tabtin-daemon start &
  DAEMON_PID=$!
  sleep 2
  if kill -0 "$DAEMON_PID" 2>/dev/null; then
    ok "Daemon started (PID: $DAEMON_PID)"
  else
    warn "Auto-start failed. Please start manually: tabtin-daemon start"
  fi
fi

ok "============================================"
ok "  TabTin Daemon installed successfully!"
ok "============================================"
ok ""
ok "  Status:  tabtin-daemon status"
ok "  Doctor:  tabtin-daemon doctor"
ok "  Config:  $INSTALL_DIR/config.json"
ok ""
ok "  The daemon is connecting to TabTin backend."
ok "  Check your DevicePanel — the device should"
ok "  appear online within a few seconds."
ok ""
