import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ServerEntry } from './ssh.js';

export interface McpConfig {
  /**
   * When true, mutating tools (run_command, sftp_write/mkdir/remove) are
   * rejected; only read-only inspection is allowed.
   */
  readOnly: boolean;
  servers: ServerEntry[];
}

/**
 * Loads the server config from (in order): the `--config <path>` CLI arg, the
 * `SERVERCASE_MCP_CONFIG` env var, or `./servercase-mcp.config.json`.
 */
export function loadConfig(argv: string[]): McpConfig {
  const flagIdx = argv.indexOf('--config');
  const file =
    (flagIdx >= 0 ? argv[flagIdx + 1] : undefined) ??
    process.env.SERVERCASE_MCP_CONFIG ??
    'servercase-mcp.config.json';

  const resolved = path.resolve(file);
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch {
    throw new Error(
      `Cannot read config "${resolved}". Pass --config <path> or set SERVERCASE_MCP_CONFIG.`,
    );
  }

  const parsed = JSON.parse(raw) as Partial<McpConfig>;
  if (!Array.isArray(parsed.servers) || parsed.servers.length === 0) {
    throw new Error(`Config "${resolved}" must define a non-empty "servers" array.`);
  }
  return { readOnly: parsed.readOnly === true, servers: parsed.servers };
}
