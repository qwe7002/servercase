export interface McpConfig {
  /** Base URL of the ServerCase control bridge. */
  url: string;
  /** Bearer token shown in ServerCase → Settings → AI. */
  token: string;
  /** When true, mutating tools (run_command, sftp_write/mkdir/remove) are off. */
  readOnly: boolean;
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Builds the config from CLI args / env. The MCP server never reads server
 * definitions or secrets — it only needs how to reach ServerCase.
 *   --url / SERVERCASE_MCP_URL        (default http://127.0.0.1:8765)
 *   --token / SERVERCASE_MCP_TOKEN    (required)
 *   --read-only / SERVERCASE_MCP_READONLY=1
 */
export function loadConfig(argv: string[]): McpConfig {
  const url =
    arg(argv, '--url') ?? process.env.SERVERCASE_MCP_URL ?? 'http://127.0.0.1:8765';
  const token = arg(argv, '--token') ?? process.env.SERVERCASE_MCP_TOKEN ?? '';
  const readOnly =
    argv.includes('--read-only') ||
    ['1', 'true'].includes((process.env.SERVERCASE_MCP_READONLY ?? '').toLowerCase());

  if (!token) {
    throw new Error(
      'No bridge token. Enable the AI bridge in ServerCase → Settings → AI, then set SERVERCASE_MCP_TOKEN (or pass --token).',
    );
  }
  return { url: url.replace(/\/+$/, ''), token, readOnly };
}
