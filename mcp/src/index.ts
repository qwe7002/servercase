#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { BridgeClient } from './bridge.js';

const config = loadConfig(process.argv.slice(2));
const bridge = new BridgeClient(config.url, config.token);

const server = new McpServer({ name: 'servercase-ssh', version: '0.2.0' });

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const fail = (s: string) => ({
  content: [{ type: 'text' as const, text: s }],
  isError: true,
});

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

const json = (v: unknown) => text(JSON.stringify(v, null, 2));

server.registerTool(
  'list_servers',
  {
    title: 'List servers',
    description:
      'List the servers ServerCase knows about and whether each is currently connected.',
    inputSchema: {},
  },
  tool(false, async () => json((await bridge.listServers()).servers)),
);

server.registerTool(
  'connect',
  {
    title: 'Connect',
    description:
      'Ask ServerCase to open an SSH connection to a server. ServerCase performs the login (resolving credentials from its keychain); this tool never sees secrets.',
    inputSchema: { server: z.string().describe('Server id or name') },
  },
  tool<{ server: string }>(false, async ({ server }) => json(await bridge.connect(server))),
);

server.registerTool(
  'run_command',
  {
    title: 'Run command',
    description:
      'Run a shell command on a connected server and return stdout, stderr and exit code. Connect the server first if needed.',
    inputSchema: {
      server: z.string().describe('Server id or name'),
      command: z.string().describe('Shell command to execute'),
    },
    annotations: { destructiveHint: true },
  },
  tool<{ server: string; command: string }>(true, async ({ server, command }) => {
    const r = await bridge.exec(server, command);
    const parts = [`exit code: ${r.code ?? 'unknown'}`];
    if (r.stdout) parts.push(`--- stdout ---\n${String(r.stdout).trimEnd()}`);
    if (r.stderr) parts.push(`--- stderr ---\n${String(r.stderr).trimEnd()}`);
    return { content: [{ type: 'text', text: parts.join('\n') }], isError: r.code !== 0 };
  }),
);

server.registerTool(
  'server_status',
  {
    title: 'Server status',
    description: 'Get a parsed system status snapshot (CPU/mem/disk/net/uptime) for a connected server.',
    inputSchema: { server: z.string().describe('Server id or name') },
  },
  tool<{ server: string }>(false, async ({ server }) => json(await bridge.status(server))),
);

server.registerTool(
  'sftp_list',
  {
    title: 'List directory',
    description: 'List a directory on a connected server over SFTP.',
    inputSchema: {
      server: z.string(),
      path: z.string().default('.').describe('Remote directory path'),
    },
  },
  tool<{ server: string; path: string }>(false, async ({ server, path }) =>
    json(await bridge.sftpList(server, path)),
  ),
);

server.registerTool(
  'sftp_read',
  {
    title: 'Read file',
    description: 'Read a text file on a connected server over SFTP.',
    inputSchema: { server: z.string(), path: z.string().describe('Remote file path') },
  },
  tool<{ server: string; path: string }>(false, async ({ server, path }) =>
    text((await bridge.sftpRead(server, path)).content ?? ''),
  ),
);

server.registerTool(
  'sftp_write',
  {
    title: 'Write file',
    description: 'Write (overwrite) a text file on a connected server over SFTP.',
    inputSchema: {
      server: z.string(),
      path: z.string().describe('Remote file path'),
      content: z.string().describe('New file contents'),
    },
    annotations: { destructiveHint: true },
  },
  tool<{ server: string; path: string; content: string }>(
    true,
    async ({ server, path, content }) => {
      await bridge.sftpWrite(server, path, content);
      return text(`Wrote ${content.length} bytes to ${path}.`);
    },
  ),
);

server.registerTool(
  'sftp_mkdir',
  {
    title: 'Make directory',
    description: 'Create a directory on a connected server over SFTP.',
    inputSchema: { server: z.string(), path: z.string().describe('Remote directory path') },
  },
  tool<{ server: string; path: string }>(true, async ({ server, path }) => {
    await bridge.sftpMkdir(server, path);
    return text(`Created ${path}.`);
  }),
);

server.registerTool(
  'sftp_remove',
  {
    title: 'Remove path',
    description: 'Delete a file or directory on a connected server over SFTP.',
    inputSchema: {
      server: z.string(),
      path: z.string().describe('Remote path to delete'),
      directory: z.boolean().default(false).describe('Set true to remove a directory'),
    },
    annotations: { destructiveHint: true },
  },
  tool<{ server: string; path: string; directory: boolean }>(
    true,
    async ({ server, path, directory }) => {
      await bridge.sftpRemove(server, path, directory);
      return text(`Deleted ${path}.`);
    },
  ),
);

await server.connect(new StdioServerTransport());
console.error(
  `servercase-ssh MCP server ready — proxying ${config.url}${config.readOnly ? ' (read-only)' : ''}.`,
);
