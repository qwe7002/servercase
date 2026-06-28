# ServerCase Worker — management panel

A small React + TypeScript + Tailwind v4 + [shadcn/ui](https://ui.shadcn.com)
SPA that talks to the [worker](../)'s own API (same-origin, no CORS). Built to
`dist/` and served by the worker via Workers Static Assets.

- **Sign in / create account** → session token in `localStorage`.
- **Probes** — hosts updating live over the `/v1/stream` WebSocket; create a
  host (one-time token shown inline) or revoke one.
- **Devices** — list and unregister push devices.
- **Config** — the synced config revision, time and server count.

```bash
npm install
npm run dev        # Vite dev server (proxy /v1 to a running `wrangler dev`)
npm run build      # → dist/, which the worker serves
```

From the worker package, `npm run build:panel` does the install + build, and
`npm run deploy` runs it automatically (`predeploy`).
