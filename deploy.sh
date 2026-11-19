#!/usr/bin/env bash
# PolySniper 5m — one-command install / update for a Linux VPS (1C1G friendly).
#
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/deploy.sh | sudo bash
#
# Optional env:
#   REPO_URL=https://github.com/OWNER/REPO.git
#   INSTALL_DIR=/opt/polysniper
#   PORT=8080
#   AUTH_PASSWORD=qq111111
#   BRANCH=main
set -euo pipefail

# --- filled in when the GitHub repo is created; override with REPO_URL ---
DEFAULT_REPO_URL="https://github.com/hrf100/polysniper-5m.git"
REPO_URL="${REPO_URL:-$DEFAULT_REPO_URL}"
INSTALL_DIR="${INSTALL_DIR:-/opt/polysniper}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-polysniper}"
PORT="${PORT:-8080}"
AUTH_PASSWORD="${AUTH_PASSWORD:-qq111111}"
DISPLAY_TZ="${DISPLAY_TZ:-Asia/Shanghai}"
NODE_MAJOR=22
SWAP_MB=1024

if [[ "$REPO_URL" == "__REPO_URL__" || -z "$REPO_URL" ]]; then
  echo "ERROR: Set REPO_URL, e.g. REPO_URL=https://github.com/you/polysniper-5m.git" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

log() { echo "[deploy] $*"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_packages() {
  if need_cmd apt-get; then
    apt-get update -y
    apt-get install -y ca-certificates curl git build-essential
  elif need_cmd dnf; then
    dnf install -y ca-certificates curl git gcc-c++ make
  elif need_cmd yum; then
    yum install -y ca-certificates curl git gcc-c++ make
  else
    echo "Unsupported package manager. Install curl git and Node.js ${NODE_MAJOR}+ manually." >&2
    exit 1
  fi
}

ensure_swap() {
  local avail_kb
  avail_kb=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  if [[ "$avail_kb" -gt 700000 ]]; then
    log "Memory available: ${avail_kb} kB — skip swap"
    return
  fi
  if swapon --show 2>/dev/null | grep -q .; then
    log "Swap already present"
    return
  fi
  if [[ -f /swapfile ]]; then
    swapon /swapfile || true
    return
  fi
  log "Creating ${SWAP_MB}MB swap (1C1G build safety)..."
  fallocate -l "${SWAP_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB"
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab 2>/dev/null; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
}

ensure_node() {
  local ver=0
  if need_cmd node; then
    ver=$(node -v | sed 's/^v//;s/\..*//')
  fi
  if [[ "$ver" -ge "$NODE_MAJOR" ]]; then
    log "Node $(node -v) OK"
    return
  fi
  log "Installing Node.js ${NODE_MAJOR}.x ..."
  if need_cmd apt-get; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  else
    echo "Please install Node.js ${NODE_MAJOR}+ then re-run." >&2
    exit 1
  fi
  node -v
}

sync_repo() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "Updating $INSTALL_DIR ($BRANCH)..."
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  else
    log "Cloning $REPO_URL → $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
}

write_env() {
  local env_file="$INSTALL_DIR/.env"
  if [[ -f "$env_file" ]]; then
    log ".env exists — keep AUTH_PASSWORD / PORT; refresh other defaults if missing"
    grep -q '^PORT=' "$env_file" || echo "PORT=$PORT" >> "$env_file"
    grep -q '^AUTH_PASSWORD=' "$env_file" || echo "AUTH_PASSWORD=$AUTH_PASSWORD" >> "$env_file"
    grep -q '^DISPLAY_TZ=' "$env_file" || echo "DISPLAY_TZ=$DISPLAY_TZ" >> "$env_file"
    grep -q '^DATA_DIR=' "$env_file" || echo "DATA_DIR=$INSTALL_DIR/data" >> "$env_file"
    grep -q '^NODE_ENV=' "$env_file" || echo "NODE_ENV=production" >> "$env_file"
    return
  fi
  cat > "$env_file" <<EOF
PORT=$PORT
AUTH_PASSWORD=$AUTH_PASSWORD
AUTH_SECRET=
DISPLAY_TZ=$DISPLAY_TZ
DATA_DIR=$INSTALL_DIR/data
NODE_ENV=production
TRUST_PROXY=loopback
EOF
  chmod 600 "$env_file"
  log "Wrote $env_file (default password: $AUTH_PASSWORD — change it)"
}

build_app() {
  cd "$INSTALL_DIR"
  log "Installing dependencies..."
  npm ci
  log "Building (frontend + bundled server.js)..."
  npm run build
  # Production runtime only — drop build tools to save disk/RAM
  rm -rf node_modules
  npm ci --omit=dev
  mkdir -p "$INSTALL_DIR/data"
}

install_systemd() {
  local unit="/etc/systemd/system/${SERVICE_NAME}.service"
  local node_bin
  node_bin=$(command -v node)
  cat > "$unit" <<EOF
[Unit]
Description=PolySniper 5m BTC reversal sniper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$node_bin --env-file-if-exists=.env --max-old-space-size=192 server.js
Restart=always
RestartSec=3
MemoryMax=320M
Environment=NODE_ENV=production
# Flush strategy state on stop
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
}

print_done() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo
  echo "=============================================="
  echo " PolySniper deployed"
  echo " Dir:      $INSTALL_DIR"
  echo " Service:  systemctl status $SERVICE_NAME"
  echo " URL:      http://${ip:-SERVER_IP}:$PORT"
  echo " Password: (see $INSTALL_DIR/.env AUTH_PASSWORD)"
  echo " Update:   curl -fsSL .../deploy.sh | sudo bash"
  echo "=============================================="
}

main() {
  log "Installing packages..."
  install_packages
  ensure_swap
  ensure_node
  sync_repo
  write_env
  build_app
  install_systemd
  sleep 1
  systemctl --no-pager --full status "$SERVICE_NAME" || true
  print_done
}

main "$@"
