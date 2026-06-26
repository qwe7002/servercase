# ServerCase — Desktop (Electron + React)

A desktop client for managing Linux servers over SSH. Built with Electron,
React, TypeScript, Vite, Tailwind CSS and shadcn/ui.

## Features

- Add / edit / delete servers (password or private-key auth)
- Live status dashboard: CPU%, memory, swap, per-mount disk usage, network
  throughput, load average and uptime — parsed entirely from `/proc` + `df`
- Interactive SSH terminal (xterm.js) with a full PTY shell
- **SFTP file manager** with a FileZilla-style layout: remote directory tree,
  detailed file listing (size / type / modified / permissions), inline text
  editor, upload / download, mkdir / rename / delete, and a transfer log
- **Global settings** (gear icon in the sidebar):
  - **Keychain (Bitwarden)** — store usernames, passwords and SSH keys in your
    Bitwarden vault so secrets sync end-to-end across devices. Reached directly
    over the Bitwarden REST API with a clean-room crypto implementation (no
    `bw` CLI or official SDK). When disabled, secrets stay on the device and
    are never written to the sync file.
  - **Snippets** — reusable shell commands, runnable in any terminal from the
    snippet menu.
  - **Auto-sync** — periodically export the server list and settings to a JSON
    file (secrets excluded), with manual *Sync now* / *Restore* actions.
  - **AI control (MCP bridge)** — a loopback, token-protected endpoint that lets
    the [`mcp/`](../mcp) server drive your *connected* servers (run commands,
    status, SFTP). Login and secrets never leave the app; the bridge only acts
    on connections you've authenticated.
- Server definitions persisted locally (zustand `persist`)

### Bitwarden keychain (clean-room)

ServerCase talks to the Bitwarden REST API directly and reimplements the
account crypto in `electron/bitwarden.ts` — no `bw` CLI and no official SDK.

1. In the Bitwarden web vault, get your **personal API key** (Account Settings
   → Security → Keys → *View API Key*) — a `client_id` / `client_secret`.
2. Open **Settings → Keychain**, enable Bitwarden, fill in the server URL
   (blank for the cloud), your account email, and the API key, then unlock with
   your master password.
3. Auth uses OAuth `client_credentials` (no 2FA prompt). The master password is
   used only to derive the vault key locally (PBKDF2 **or Argon2id** → HKDF →
   AES‑CBC‑256 + HMAC‑SHA256) and is never sent to the server or persisted.
   Each server maps to one vault item named `${prefix}${serverId}`.

Notes:
- Both the **PBKDF2** and **Argon2id** KDFs are supported (Argon2id via the
  MIT-licensed `@noble/hashes`, verified against the RFC 9106 test vector).
- The KDF parameters and per-cipher keys follow the documented Bitwarden
  security model — referenced from the protocol, not from any official client
  code (which is GPL and license-incompatible with this BSD-3 project).
- The API key `client_secret` is stored locally and is redacted from the sync
  file.
- **Test vault** (shown once unlocked) round-trips a throwaway item — encrypt,
  upload, fetch, decrypt, verify, delete — to confirm the whole path works.

## Architecture

```
electron/                Main process (Node) — owns all SSH sockets
  main.ts                Window + IPC wiring
  preload.ts             contextBridge → window.servercase (typed)
  shared.ts              Types shared with the renderer
  bitwarden.ts           Bitwarden secret vault driven via the `bw` CLI
  ssh/sshManager.ts      ssh2 connections: exec (status) + shell + SFTP
  ssh/statusCollector.ts /proc parsing + CPU/net delta computation
src/                     React renderer
  components/ui/         shadcn/ui primitives
  store/servers.ts       zustand store (persisted server list + vault sync)
  store/settings.ts      zustand store (keychain / snippets / auto-sync)
  lib/sync.ts            export/import of the secret-free config file
  useConnections.ts      connection events + 3s status polling
  useGlobalSettings.ts   vault configuration, secret loading, auto-sync timer
  components/            ServerList, ServerForm, Dashboard, StatusCard,
                         Terminal, Sftp, Settings
```

Secrets, when the Bitwarden keychain is enabled, are stripped from the
renderer's local storage on persist and live only in the vault; they are
fetched back into memory on unlock and on demand when connecting.

Secrets never reach the renderer's network: the renderer talks only to the
main process over IPC, and the main process holds the SSH connections.

## Develop

```bash
npm install              # use ELECTRON_SKIP_BINARY_DOWNLOAD=1 behind a proxy
npm run dev              # Vite dev server + Electron with HMR
```

## Build

```bash
npm run typecheck        # tsc --noEmit (renderer + electron)
npm run build            # renderer → dist/, main/preload → dist-electron/
npm start                # run the built app
```
