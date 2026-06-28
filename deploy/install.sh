#!/usr/bin/env bash
#
# ServerCase probe installer.
#
# Installs the servercase-probe agent on a Linux host and wires it to stream
# servercase.probe.v1 snapshots to the ServerCase Worker over a WebSocket
# (probe stdout → websocat → wss://.../v1/ingest/ws). Runs as a hardened
# systemd service that reconnects automatically.
#
# The probe stays a zero-dependency std-only Rust binary; websocat (a single
# static binary) provides the TLS WebSocket client, so nothing has to be built
# on the host.
#
# Usage (already have a probe token):
#   sudo ./install.sh --api https://worker.example.com --token scp_xxx
#
# Usage (auto-register this host with your account):
#   sudo ./install.sh --api https://worker.example.com \
#                     --session <your login token> --name "$(hostname)"
#
# Run `./install.sh --help` for all flags. Re-running upgrades in place.
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
API=""              # https base URL of the worker, e.g. https://worker.example.com
WS_URL=""           # full wss ingest URL (derived from --api when omitted)
TOKEN=""            # per-host probe token
SESSION=""          # user session token, for auto-registration
NAME="$(hostname)"  # host name to register
INTERVAL=10
PUBLIC_IP=""        # set to "--public-ip" to enable public-IP lookup
PROBE_URL=""        # download URL for the servercase-probe binary
PROBE_PATH=""       # path to a prebuilt servercase-probe binary
BUILD_DIR=""        # cargo source dir to build from (defaults to repo ../probe)
GITHUB_REPO="${SERVERCASE_GITHUB_REPO:-qwe7002/servercase}"
GITHUB_TAG="${SERVERCASE_PROBE_VERSION:-latest}"
WEBSOCAT_URL=""     # override websocat download URL
WEBSOCAT_VERSION="1.13.0"
PREFIX="/opt/servercase-probe"
CONF_DIR="/etc/servercase-probe"
SERVICE_USER="servercase"
UNINSTALL=0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ── Args ─────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --api)              API="$2"; shift 2;;
    --ws-url)           WS_URL="$2"; shift 2;;
    --token)            TOKEN="$2"; shift 2;;
    --session)          SESSION="$2"; shift 2;;
    --name)             NAME="$2"; shift 2;;
    --interval)         INTERVAL="$2"; shift 2;;
    --public-ip)        PUBLIC_IP="--public-ip"; shift;;
    --probe-url)        PROBE_URL="$2"; shift 2;;
    --probe-path)       PROBE_PATH="$2"; shift 2;;
    --build)            BUILD_DIR="$2"; shift 2;;
    --github-repo)      GITHUB_REPO="$2"; shift 2;;
    --probe-version)    GITHUB_TAG="$2"; shift 2;;
    --websocat-url)     WEBSOCAT_URL="$2"; shift 2;;
    --prefix)           PREFIX="$2"; shift 2;;
    --user)             SERVICE_USER="$2"; shift 2;;
    --uninstall)        UNINSTALL=1; shift;;
    -h|--help)          usage;;
    *)                  die "unknown argument: $1 (try --help)";;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"

SERVICE_NAME="servercase-probe"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

# ── Uninstall ────────────────────────────────────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  log "Stopping and removing ${SERVICE_NAME}"
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  rm -rf "$PREFIX" "$CONF_DIR"
  log "Removed. (The user '${SERVICE_USER}' was left in place.)"
  exit 0
fi

# ── Download helper ──────────────────────────────────────────────────────────
fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$2" "$1"
  else
    die "need curl or wget to download $1"
  fi
}

case "$(uname -m)" in
  x86_64|amd64)   ARCH="x86_64"; PROBE_TARGET="x86_64-unknown-linux-gnu";;
  aarch64|arm64)  ARCH="aarch64"; PROBE_TARGET="aarch64-unknown-linux-gnu";;
  *)              die "unsupported architecture: $(uname -m)";;
esac

probe_release_url() {
  asset="servercase-probe-${PROBE_TARGET}"
  if [ "$GITHUB_TAG" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/%s\n' "$GITHUB_REPO" "$asset"
  else
    printf 'https://github.com/%s/releases/download/%s/%s\n' "$GITHUB_REPO" "$GITHUB_TAG" "$asset"
  fi
}

# ── Resolve the ingest URL ───────────────────────────────────────────────────
if [ -z "$WS_URL" ]; then
  [ -n "$API" ] || die "need --ws-url or --api"
  case "$API" in
    https://*) WS_URL="wss://${API#https://}/v1/ingest/ws";;
    http://*)  WS_URL="ws://${API#http://}/v1/ingest/ws";;
    *)         die "--api must start with http:// or https://";;
  esac
fi

# ── Resolve the probe token (register if needed) ─────────────────────────────
if [ -z "$TOKEN" ]; then
  [ -n "$SESSION" ] || die "need --token, or --session (+--api) to auto-register"
  [ -n "$API" ] || die "auto-registration needs --api"
  command -v curl >/dev/null 2>&1 || die "auto-registration needs curl"
  log "Registering host '${NAME}' with ${API}"
  RESP="$(curl -fsS -X POST "${API%/}/v1/probes" \
    -H "Authorization: Bearer ${SESSION}" \
    -H 'content-type: application/json' \
    -d "{\"name\":$(printf '%s' "$NAME" | sed 's/"/\\"/g; s/.*/"&"/')}")" \
    || die "registration request failed"
  TOKEN="$(printf '%s' "$RESP" | grep -oE '"token":"[^"]+"' | head -n1 | sed 's/.*:"//; s/"$//')"
  [ -n "$TOKEN" ] || die "could not read token from response: $RESP"
  log "Host registered; token captured."
fi

# ── Install binaries ─────────────────────────────────────────────────────────
install -d -m 0755 "$PREFIX"

log "Installing servercase-probe"
if [ -n "$PROBE_PATH" ]; then
  install -m 0755 "$PROBE_PATH" "$PREFIX/servercase-probe"
elif [ -n "$PROBE_URL" ]; then
  fetch "$PROBE_URL" "$PREFIX/servercase-probe"
  chmod 0755 "$PREFIX/servercase-probe"
else
  # Build from the repo's probe/ crate if we're running inside a checkout.
  SRC="${BUILD_DIR:-$SCRIPT_DIR/../probe}"
  if [ -f "$SRC/Cargo.toml" ] && command -v cargo >/dev/null 2>&1; then
    log "Building probe from $SRC (cargo)"
    ( cd "$SRC" && cargo build --release )
    install -m 0755 "$SRC/target/release/servercase-probe" "$PREFIX/servercase-probe"
  else
    URL="$(probe_release_url)"
    log "Downloading probe from ${URL}"
    fetch "$URL" "$PREFIX/servercase-probe" \
      || die "could not download probe binary; pass --probe-path or --probe-url"
    chmod 0755 "$PREFIX/servercase-probe"
  fi
fi

log "Installing websocat (${ARCH})"
WS_BIN="$PREFIX/websocat"
if command -v websocat >/dev/null 2>&1 && [ -z "$WEBSOCAT_URL" ]; then
  ln -sf "$(command -v websocat)" "$WS_BIN"
else
  URL="${WEBSOCAT_URL:-https://github.com/vi/websocat/releases/download/v${WEBSOCAT_VERSION}/websocat.${ARCH}-unknown-linux-musl}"
  fetch "$URL" "$WS_BIN"
  chmod 0755 "$WS_BIN"
fi

# ── Service user ─────────────────────────────────────────────────────────────
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user '${SERVICE_USER}'"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
fi

# ── Config (holds the token; keep it 0600) ───────────────────────────────────
install -d -m 0750 "$CONF_DIR"
ENV_FILE="$CONF_DIR/probe.env"
umask 077
cat > "$ENV_FILE" <<EOF
# Generated by deploy/install.sh — contains the probe token; keep private.
PROBE_BIN=$PREFIX/servercase-probe
WEBSOCAT_BIN=$WS_BIN
WS_URL=$WS_URL
TOKEN=$TOKEN
INTERVAL=$INTERVAL
PUBLIC_IP=$PUBLIC_IP
EOF
chown -R "$SERVICE_USER":"$SERVICE_USER" "$CONF_DIR"
chmod 0600 "$ENV_FILE"

# ── systemd unit ─────────────────────────────────────────────────────────────
# Note: `$$VAR` passes a literal `$VAR` through systemd to /bin/sh, which then
# expands it from EnvironmentFile — so the token is never rendered into systemd
# state by variable substitution.
log "Installing systemd unit"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=ServerCase probe -> cloud (WebSocket)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
EnvironmentFile=$ENV_FILE
ExecStart=/bin/sh -c '"\$\$PROBE_BIN" --interval "\$\$INTERVAL" \$\$PUBLIC_IP | "\$\$WEBSOCAT_BIN" --ping-interval 25 --ping-timeout 60 -H "Authorization: Bearer \$\$TOKEN" "\$\$WS_URL"'
Restart=always
RestartSec=5
# Hardening — the probe only needs to read /proc and run df/ip/curl.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

log "Done. Streaming to ${WS_URL}"
log "  systemctl status ${SERVICE_NAME}"
log "  journalctl -u ${SERVICE_NAME} -f"
