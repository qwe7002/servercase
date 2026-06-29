#!/usr/bin/env bash
#
# ServerCase probe installer.
#
# Installs the servercase-probe agent on a Linux host and wires it to post
# servercase.probe.v1 snapshots to the ServerCase Worker over HTTPS
# (probe stdout → curl → POST https://.../v1/ingest). Runs as a hardened
# systemd service that restarts automatically. Non-root installs use a
# per-user systemd service; root installs use a system-wide service.
#
# The probe stays a zero-dependency std-only Rust binary, and the host only
# needs curl (already present nearly everywhere) — no websocat or other extra
# binary has to be downloaded.
#
# Usage (already have a probe token):
#   ./install.sh --api https://worker.example.com --token scp_xxx
#
# Usage (auto-register this host with your account):
#   ./install.sh --api https://worker.example.com \
#                --session <your login token> --name "$(hostname)"
#
# Run `./install.sh --help` for all flags. Re-running upgrades in place.
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
API=""              # https base URL of the worker, e.g. https://worker.example.com
INGEST_URL=""       # full HTTP ingest URL (derived from --api when omitted)
TOKEN=""            # per-host probe token
SESSION=""          # user session token, for auto-registration
NAME="$(hostname)"  # host name to register
INTERVAL=10
PUBLIC_IP=""        # set to "--public-ip" to enable public-IP lookup
SECURITY_UPDATES="" # set to "--security-updates" to check package security updates
PROBE_URL=""        # download URL for the servercase-probe binary
PROBE_PATH=""       # path to a prebuilt servercase-probe binary
BUILD_DIR=""        # cargo source dir to build from (defaults to repo probe/)
GITHUB_REPO="${SERVERCASE_GITHUB_REPO:-qwe7002/servercase}"
GITHUB_TAG="${SERVERCASE_PROBE_VERSION:-latest}"
PREFIX=""
CONF_DIR=""
SERVICE_USER="servercase"
INSTALL_MODE="auto"  # auto | system | user
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
    --ingest-url)       INGEST_URL="$2"; shift 2;;
    --token)            TOKEN="$2"; shift 2;;
    --session)          SESSION="$2"; shift 2;;
    --name)             NAME="$2"; shift 2;;
    --interval)         INTERVAL="$2"; shift 2;;
    --public-ip)        PUBLIC_IP="--public-ip"; shift;;
    --security-updates) SECURITY_UPDATES="--security-updates"; shift;;
    --probe-url)        PROBE_URL="$2"; shift 2;;
    --probe-path)       PROBE_PATH="$2"; shift 2;;
    --build)            BUILD_DIR="$2"; shift 2;;
    --github-repo)      GITHUB_REPO="$2"; shift 2;;
    --probe-version)    GITHUB_TAG="$2"; shift 2;;
    --prefix)           PREFIX="$2"; shift 2;;
    --conf-dir)         CONF_DIR="$2"; shift 2;;
    --system)           INSTALL_MODE="system"; shift;;
    --user-service)     INSTALL_MODE="user"; shift;;
    --user)             SERVICE_USER="$2"; shift 2;;
    --uninstall)        UNINSTALL=1; shift;;
    -h|--help)          usage;;
    *)                  die "unknown argument: $1 (try --help)";;
  esac
done

SERVICE_NAME="servercase-probe"

if [ "$INSTALL_MODE" = "auto" ]; then
  if [ "$(id -u)" -eq 0 ]; then INSTALL_MODE="system"; else INSTALL_MODE="user"; fi
fi

case "$INSTALL_MODE" in
  system)
    [ "$(id -u)" -eq 0 ] || die "--system install must run as root"
    PREFIX="${PREFIX:-/opt/servercase-probe}"
    CONF_DIR="${CONF_DIR:-/etc/servercase-probe}"
    UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
    ;;
  user)
    [ "$(id -u)" -ne 0 ] || die "--user-service should not run as root"
    PREFIX="${PREFIX:-$HOME/.local/lib/servercase-probe}"
    CONF_DIR="${CONF_DIR:-$HOME/.config/servercase-probe}"
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    UNIT_PATH="${UNIT_DIR}/${SERVICE_NAME}.service"
    ;;
  *) die "unknown install mode: $INSTALL_MODE";;
esac

systemctl_cmd() {
  if [ "$INSTALL_MODE" = "system" ]; then
    systemctl "$@"
  else
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user "$@"
  fi
}

# ── Uninstall ────────────────────────────────────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  log "Stopping and removing ${SERVICE_NAME}"
  systemctl_cmd disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl_cmd daemon-reload
  rm -rf "$PREFIX" "$CONF_DIR"
  if [ "$INSTALL_MODE" = "system" ]; then
    log "Removed. (The user '${SERVICE_USER}' was left in place.)"
  else
    log "Removed."
  fi
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
if [ -z "$INGEST_URL" ]; then
  [ -n "$API" ] || die "need --ingest-url or --api"
  case "$API" in
    http://*|https://*) INGEST_URL="${API%/}/v1/ingest";;
    *)                  die "--api must start with http:// or https://";;
  esac
fi

# The probe posts each snapshot with curl, so it is a hard runtime dependency.
command -v curl >/dev/null 2>&1 || die "the probe service needs curl on the host"

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
  SRC="${BUILD_DIR:-$SCRIPT_DIR/..}"
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

# ── Service user ─────────────────────────────────────────────────────────────
if [ "$INSTALL_MODE" = "system" ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user '${SERVICE_USER}'"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
fi

# ── Config (holds the token; keep it 0600) ───────────────────────────────────
install -d -m 0750 "$CONF_DIR"
ENV_FILE="$CONF_DIR/probe.env"
umask 077
cat > "$ENV_FILE" <<EOF
# Generated by probe/deploy/install.sh — contains the probe token; keep private.
PROBE_BIN=$PREFIX/servercase-probe
INGEST_URL=$INGEST_URL
TOKEN=$TOKEN
INTERVAL=$INTERVAL
PUBLIC_IP=$PUBLIC_IP
SECURITY_UPDATES=$SECURITY_UPDATES
EOF
if [ "$INSTALL_MODE" = "system" ]; then
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$CONF_DIR"
fi
chmod 0600 "$ENV_FILE"

# ── systemd unit ─────────────────────────────────────────────────────────────
# Note: `$$VAR` passes a literal `$VAR` through systemd to /bin/sh, which then
# expands it from EnvironmentFile — so the token is never rendered into systemd
# state by variable substitution.
log "Installing ${INSTALL_MODE} systemd unit"
if [ "$INSTALL_MODE" = "user" ]; then install -d -m 0755 "$UNIT_DIR"; fi
{
  cat <<EOF
[Unit]
Description=ServerCase probe -> cloud (HTTP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EOF
  if [ "$INSTALL_MODE" = "system" ]; then
    printf 'User=%s\n' "$SERVICE_USER"
  fi
  cat <<EOF
EnvironmentFile=$ENV_FILE
ExecStart=/bin/sh -c '"\$\$PROBE_BIN" --interval "\$\$INTERVAL" \$\$PUBLIC_IP \$\$SECURITY_UPDATES | while IFS= read -r line; do printf %s "\$\$line" | curl -fsS -m 20 -X POST -H "Authorization: Bearer \$\$TOKEN" -H "content-type: application/json" --data-binary @- "\$\$INGEST_URL" >/dev/null 2>&1 || true; done'
Restart=always
RestartSec=5
# Hardening — the probe only needs to read /proc and run df/ip/curl.
NoNewPrivileges=true
PrivateTmp=true
EOF
  if [ "$INSTALL_MODE" = "system" ]; then
    cat <<EOF
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
  else
    cat <<EOF

[Install]
WantedBy=default.target
EOF
  fi
} > "$UNIT_PATH"

systemctl_cmd daemon-reload
systemctl_cmd enable --now "$SERVICE_NAME"

log "Done. Posting to ${INGEST_URL}"
if [ "$INSTALL_MODE" = "system" ]; then
  log "  systemctl status ${SERVICE_NAME}"
  log "  journalctl -u ${SERVICE_NAME} -f"
else
  log "  systemctl --user status ${SERVICE_NAME}"
  log "  journalctl --user -u ${SERVICE_NAME} -f"
  warn "User services may stop after logout unless linger is enabled by an admin."
fi
