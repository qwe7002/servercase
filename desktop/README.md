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
    Bitwarden vault via the `bw` CLI so secrets sync end-to-end across devices.
    When disabled, secrets stay on the device and are never written to the
    sync file.
  - **Snippets** — reusable shell commands, runnable in any terminal from the
    snippet menu.
  - **Auto-sync** — periodically export the server list and settings to a JSON
    file (secrets excluded), with manual *Sync now* / *Restore* actions.
- Server definitions persisted locally (zustand `persist`)

### Bitwarden keychain

ServerCase drives the official [`bw`](https://bitwarden.com/help/cli/) CLI:

1. Install `bw` and run `bw login` once in a terminal (login may require 2FA).
2. Open **Settings → Keychain**, enable Bitwarden, and unlock with your master
   password. The master password is exchanged for a session token held only in
   the main process — it is never persisted.
3. Each server maps to one vault item named `${prefix}${serverId}`; the full
   credential bundle is stored in the item's notes (and mirrored into the login
   fields for use from the regular Bitwarden apps).

Self-hosted users should point the CLI at their server first with
`bw config server <url>`.

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
