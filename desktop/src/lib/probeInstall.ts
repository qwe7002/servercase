const INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/qwe7002/servercase/main/probe/deploy/install.sh';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildProbeInstallCommand(apiUrl: string, token: string): string {
  return [
    'set -e',
    'tmp="$(mktemp)"',
    `if command -v curl >/dev/null 2>&1; then curl -fsSL ${shellQuote(
      INSTALL_SCRIPT_URL,
    )} -o "$tmp"; elif command -v wget >/dev/null 2>&1; then wget -O "$tmp" ${shellQuote(
      INSTALL_SCRIPT_URL,
    )}; else echo "need curl or wget"; exit 1; fi`,
    'chmod 700 "$tmp"',
    `bash "$tmp" --user-service --api ${shellQuote(apiUrl)} --token ${shellQuote(
      token,
    )} --interval 10 --public-ip`,
    'rm -f "$tmp"',
  ].join('; ');
}
