# ServerCase — SSH MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
AI assistant manage Linux servers over SSH **through the ServerCase app**.

It is a thin proxy: it holds only the URL and token of the ServerCase *control
bridge*. **ServerCase owns login** — the server list, credential storage and
the Bitwarden vault all stay in the app, and the actual SSH sockets live there
too. The MCP server never sees a password, private key or vault. It simply asks
ServerCase to act on connections you have authenticated.

```
AI client ──MCP/stdio──> servercase-mcp ──HTTP(127.0.0.1 + token)──> ServerCase app ──SSH──> servers
                          (no secrets)                                (login + Bitwarden)
```

> ⚠️ While enabled, the bridge lets an AI run commands and modify files on your
> connected servers. Keep the token private and consider read-only mode.

## Setup

1. In **ServerCase → Settings → AI**, enable *Let an AI control SSH* and copy
   the **Bridge URL** and **Token** (the token is regenerated on each app
   start).
2. Build this package and point it at the bridge:

```bash
npm install
npm run build
SERVERCASE_MCP_URL=http://127.0.0.1:8765 \
SERVERCASE_MCP_TOKEN=<token> \
  node dist/index.js
```

Config is read from CLI args / env:

| Option | Env | Default |
|--------|-----|---------|
| `--url <url>` | `SERVERCASE_MCP_URL` | `http://127.0.0.1:8765` |
| `--token <token>` | `SERVERCASE_MCP_TOKEN` | *(required)* |
| `--read-only` | `SERVERCASE_MCP_READONLY=1` | off |

## Tools

| Tool | Mutating | Description |
|------|----------|-------------|
| `list_servers` | – | List servers and their connection state. |
| `connect` | – | Ask ServerCase to connect (it does the login). |
| `run_command` | ✓ | Run a shell command; returns stdout/stderr/exit code. |
| `server_status` | – | Parsed CPU/mem/disk/net/uptime snapshot. |
| `sftp_list` | – | List a remote directory. |
| `sftp_read` | – | Read a remote text file. |
| `sftp_write` | ✓ | Overwrite a remote text file. |
| `sftp_mkdir` | ✓ | Create a remote directory. |
| `sftp_remove` | ✓ | Delete a remote file or directory. |

In read-only mode the mutating tools are rejected. Commands and file ops only
work on **connected** servers — use `connect` (or connect in the app) first.

## Register with an MCP client

```json
{
  "mcpServers": {
    "servercase-ssh": {
      "command": "node",
      "args": ["/abs/path/to/servercase/mcp/dist/index.js"],
      "env": {
        "SERVERCASE_MCP_URL": "http://127.0.0.1:8765",
        "SERVERCASE_MCP_TOKEN": "<token from ServerCase>"
      }
    }
  }
}
```
