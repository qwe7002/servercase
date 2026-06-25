# ServerCase — Desktop (Electron + React)

A desktop client for managing Linux servers over SSH. Built with
Electron, React, TypeScript and Vite.

## Features

- Add / edit / delete servers (password or private-key auth)
- Live status dashboard: CPU%, memory, swap, per-mount disk usage, network
  throughput, load average and uptime — parsed entirely from `/proc` + `df`
- Interactive SSH terminal (xterm.js) with a full PTY shell
- Server definitions persisted locally (zustand `persist`)

## Architecture

```
electron/                Main process (Node) — owns all SSH sockets
  main.ts                Window + IPC wiring
  preload.ts             contextBridge → window.servercase (typed)
  shared.ts              Types shared with the renderer
  ssh/sshManager.ts      ssh2 connections: exec (status) + shell (terminal)
  ssh/statusCollector.ts /proc parsing + CPU/net delta computation
src/                     React renderer
  store/servers.ts       zustand store (persisted server list)
  useConnections.ts      connection events + 3s status polling
  components/            ServerList, ServerForm, Dashboard, StatusCard, Terminal
```

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
