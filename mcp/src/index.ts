#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { SshPool, STATUS_COMMAND } from './ssh.js';

const config = loadConfig(process.argv.slice(2));
const pool = new SshPool(config.servers);

const server = new McpServer({ name: 'servercase-ssh', version: '0.1.0' });

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const fail = (s: string) => ({
  content: [{ type: 'text' as const, text: s }],
  isError: true,
});

/** Wraps a tool handler with error handling and the read-only guard. */
function tool<T>(
  mutating: boolean,
  handler: (args: T) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>,
) {
  return async (args: T) => {
    if (mutating && config.readOnly) {
      return fail('Server is in read-only mode; mutating tools are disabled.');
    }
    try {
      return await handler(args);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}

server.registerTool(
  'list_servers',
  {
    title: 'List servers',
    description: 'List the SSH servers available to this MCP server (no secrets).',
    inputSchema: {},
  },
  tool(false, async () => {
    const rows = pool.list().map((s) => ({
      id: s.id ?? s.name,
      name: s.name,
      host: s.host,
      port: s.port ?? 22,
      username: s.username,
    }));
    return text(JSON.stringify(rows, null, 2));
  }),
);

server.registerTool(
  'run_command',
  {
    title: 'Run command',
    description:
      'Run a shell command on a server over SSH and return stdout, stderr and the exit code.',
    inputSchema: {
      server: z.string().describe('Server id or name'),
      command: z.string().describe('Shell command to execute'),
    },
    annotations: { destructiveHint: true },
  },
  tool<{ server: string; command: string }>(true, async ({ server, command }) => {
    const r = await pool.exec(server, command);
    const parts = [`exit code: ${r.code ?? 'unknown'}`];
    if (r.stdout) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
    if (r.stderr) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
    return { content: [{ type: 'text', text: parts.join('\n') }], isError: r.code !== 0 };
  }),
);

server.registerTool(
  'server_status',
  {
    title: 'Server status',
    description:
      'Collect a system status snapshot (CPU/mem/disk/net/uptime) from /proc + df, returned as raw text.',
    inputSchema: { server: z.string().describe('Server id or name') },
  },
  tool<{ server: string }>(false, async ({ server }) => {
    const r = await pool.exec(server, STATUS_COMMAND);
    return text(r.stdout || r.stderr || '(no output)');
  }),
);

server.registerTool(
  'sftp_list',
  {
    title: 'List directory',
    description: 'List a directory on a server over SFTP.',
    inputSchema: {
      server: z.string(),
      path: z.string().default('.').describe('Remote directory path'),
    },
  },
  tool<{ server: string; path: string }>(false, async ({ server, path: dir }) => {
    const r = await pool.sftpList(server, dir);
    return text(JSON.stringify(r, null, 2));
  }),
);

server.registerTool(
  'sftp_read',
  {
    title: 'Read file',
    description: 'Read a text file on a server over SFTP.',
    inputSchema: { server: z.string(), path: z.string().describe('Remote file path') },
  },
  tool<{ server: string; path: string }>(false, async ({ server, path: file }) => {
    return text(await pool.sftpRead(server, file));
  }),
);

server.registerTool(
  'sftp_write',
  {
    title: 'Write file',
    description: 'Write (overwrite) a text file on a server over SFTP.',
    inputSchema: {
      server: z.string(),
      path: z.string().describe('Remote file path'),
      content: z.string().describe('New file contents'),
    },
    annotations: { destructiveHint: true },
  },
  tool<{ server: string; path: string; content: string }>(
    true,
    async ({ server, path: file, content }) => {
      await pool.sftpWrite(server, file, content);
      return text(`Wrote ${content.length} bytes to ${file}.`);
    },
  ),
);

server.registerTool(
  'sftp_mkdir',
  {
    title: 'Make directory',
    description: 'Create a directory on a server over SFTP.',
    inputSchema: { server: z.string(), path: z.string().describe('Remote directory path') },
  },
  tool<{ server: string; path: string }>(true, async ({ server, path: dir }) => {
    await pool.sftpMkdir(server, dir);
    return text(`Created ${dir}.`);
  }),
);

server.registerTool(
  'sftp_remove',
  {
    title: 'Remove path',
    description: 'Delete a file or directory on a server over SFTP.',
    inputSchema: {
      server: z.string(),
      path: z.string().describe('Remote path to delete'),
      directory: z.boolean().default(false).describe('Set true to remove a directory'),
    },
    annotations: { destructiveHint: true },
  },
  tool<{ server: string; path: string; directory: boolean }>(
    true,
    async ({ server, path: target, directory }) => {
      await pool.sftpRemove(server, target, directory);
      return text(`Deleted ${target}.`);
    },
  ),
);

server.registerTool(
  'disconnect',
  {
    title: 'Disconnect',
    description: 'Close the SSH connection to a server (it reconnects on next use).',
    inputSchema: { server: z.string() },
  },
  tool<{ server: string }>(false, async ({ server }) => {
    pool.disconnect(server);
    return text(`Disconnected ${server}.`);
  }),
);

process.on('SIGINT', () => {
  pool.disposeAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  pool.disposeAll();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
console.error(
  `servercase-ssh MCP server ready — ${config.servers.length} server(s)${config.readOnly ? ', read-only' : ''}.`,
);
