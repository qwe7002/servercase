# ServerCase — SSH MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
AI assistant manage Linux servers over SSH, using the same connection model as
the ServerCase clients. It speaks MCP over stdio and drives
[`ssh2`](https://github.com/mscdex/ssh2) under the hood.

> ⚠️ This gives an AI shell and file access to whatever servers you configure.
> Only point it at servers you are authorized to manage, keep the config file
> private, and consider `readOnly` mode for inspection-only use.

## Tools

| Tool | Mutating | Description |
|------|----------|-------------|
| `list_servers` | – | List configured servers (no secrets). |
| `run_command` | ✓ | Run a shell command; returns stdout, stderr, exit code. |
| `server_status` | – | CPU/mem/disk/net/uptime snapshot from `/proc` + `df`. |
| `sftp_list` | – | List a remote directory. |
| `sftp_read` | – | Read a remote text file. |
| `sftp_write` | ✓ | Overwrite a remote text file. |
| `sftp_mkdir` | ✓ | Create a remote directory. |
| `sftp_remove` | ✓ | Delete a remote file or directory. |
| `disconnect` | – | Close a server's SSH connection. |

In `readOnly` mode the mutating tools are rejected.

## Configure

Create a JSON config (see `servercase-mcp.config.example.json`):

```json
{
  "readOnly": false,
  "servers": [
    { "id": "web1", "name": "Web 1", "host": "10.0.0.10", "username": "root", "password": "…" },
    { "id": "db1",  "name": "Database", "host": "10.0.0.20", "username": "admin",
      "privateKeyPath": "/home/you/.ssh/id_ed25519", "passphrase": "…" }
  ]
}
```

The config path is resolved from `--config <path>`, then
`SERVERCASE_MCP_CONFIG`, then `./servercase-mcp.config.json`.

## Build & run

```bash
npm install
npm run build           # tsc → dist/
node dist/index.js --config /path/to/servercase-mcp.config.json
```

## Register with an MCP client

For Claude Code / Claude Desktop, add to the MCP server list:

```json
{
  "mcpServers": {
    "servercase-ssh": {
      "command": "node",
      "args": ["/abs/path/to/servercase/mcp/dist/index.js"],
      "env": { "SERVERCASE_MCP_CONFIG": "/abs/path/to/servercase-mcp.config.json" }
    }
  }
}
```

Tools are referenced by server `id` (falling back to `name`).
