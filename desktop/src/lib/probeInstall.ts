const PROBE_REPO = 'qwe7002/servercase';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Download the matching `servercase-probe` release binary and let it install
// itself as a per-user systemd service (the binary now carries the installer —
// there is no separate install.sh to fetch).
export function buildProbeInstallCommand(apiUrl: string, token: string, hostName: string): string {
  const releaseBase = `https://github.com/${PROBE_REPO}/releases/latest/download/servercase-probe`;
  return [
    'set -e',
    'arch="$(uname -m)"',
    'case "$arch" in ' +
      'x86_64|amd64) target=x86_64-unknown-linux-gnu ;; ' +
      'aarch64|arm64) target=aarch64-unknown-linux-gnu ;; ' +
      '*) echo "unsupported architecture: $arch" >&2; exit 1 ;; ' +
      'esac',
    `url=${shellQuote(releaseBase)}-"$target"`,
    'tmp="$(mktemp)"',
    'if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$tmp"; ' +
      'elif command -v wget >/dev/null 2>&1; then wget -O "$tmp" "$url"; ' +
      'else echo "need curl or wget" >&2; exit 1; fi',
    'chmod 700 "$tmp"',
    `"$tmp" install --user-service --api ${shellQuote(apiUrl)} --token ${shellQuote(
      token,
    )} --name ${shellQuote(hostName)} --interval 10 --public-ip --security-updates`,
    'rm -f "$tmp"',
  ].join('; ');
}
