# ServerCase Worker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) that provides
the **thin cloud side** of ServerCase:

1. **Account login** — email + password, so a user owns their cloud data.
2. **Config sync** — pull/push the secret-free `SyncPayload` across devices
   (the desktop, iOS and Android clients all sign in here under Settings → Cloud).
3. **Probe ingest** — receive `servercase.probe.v1` snapshots from the
   [`probe/`](../probe) agent over per-host tokens, keeping latest + history.
4. **Push** — threshold alerts (CPU / memory / disk) delivered to a user's
   registered devices over **Firebase Cloud Messaging**, fired on transition.
5. **Management panel** — a self-contained web dashboard served at `/` (sign in,
   live probe hosts, host tokens, push devices, config status).

```
ServerCase app ──login──> Worker ──> D1 (accounts, config, probes, devices)
probe agent  ──probe.v1──> Worker
```

Consistent with the rest of ServerCase, **secrets never reach the cloud**: SSH
credentials and the Bitwarden vault stay in the app. Stored server definitions
are secret-free and the Bitwarden API key is redacted before upload. Crypto
(PBKDF2 password hashing, HMAC session tokens, token hashing) uses the Workers
Web Crypto API; the only runtime dependency is [Drizzle ORM](https://orm.drizzle.team),
which types the D1 query layer and generates the migrations from the schema.

## Layout

| Path | Purpose |
|------|---------|
| `src/index.ts` | Entry point; route table. |
| `src/router.ts` | Tiny method + `:param` path router. |
| `src/auth/` | PBKDF2 passwords, HMAC session tokens, session middleware. |
| `src/routes/` | `auth`, `sync`, `probes`, `ingest`, `devices`. |
| `src/probe_socket.ts` | `ProbeSocket` Durable Object: hibernatable WebSocket ingest. |
| `src/user_hub.ts` | `UserHub` Durable Object: per-user live fan-out to clients. |
| `src/probe_store.ts` | Snapshot persistence shared by HTTP + WebSocket ingest. |
| `src/publish.ts` | Routes an ingested snapshot to its owner's `UserHub`. |
| `src/push/` | FCM transport (`fcm.ts`), threshold rules (`alerts.ts`), `dispatchAlerts`. |
| `src/db/schema.ts` | Drizzle schema — the single source of truth for tables. |
| `src/db/client.ts` | `getDb(env)` — a typed Drizzle client over D1. |
| `src/shared.ts` | Client-facing types (`SyncPayload`, `servercase.probe.v1`). |
| `panel/` | Management panel — React + shadcn/ui SPA, built to `panel/dist`. |
| `drizzle.config.ts` | drizzle-kit config (schema → `migrations/`). |
| `migrations/` | Generated D1 migrations (drizzle-kit) + drizzle `meta/`. |

## Setup

```bash
npm install
wrangler login

# Create the D1 database and paste the returned id into wrangler.toml.
wrangler d1 create servercase

# Apply the schema. Migrations are generated from src/db/schema.ts by
# drizzle-kit (committed under migrations/) and applied by wrangler:
npm run db:generate        # only after editing the schema
npm run migrate:local      # for `wrangler dev`
npm run migrate:remote     # for production

# Set the session-signing secret (never commit it).
wrangler secret put SESSION_SECRET
# For local dev, put it in .dev.vars instead:  SESSION_SECRET=dev-secret

npm run build:panel        # build the management panel into panel/dist
npm run dev                # local
npm run deploy             # production (builds the panel first)
```

Config (`wrangler.toml [vars]`):

| Var | Default | Meaning |
|-----|---------|---------|
| `ALLOW_REGISTRATION` | `1` | Set `0` to close public signup. |
| `PROBE_HISTORY_LIMIT` | `240` | History rows kept per host (`0` = latest only). |
| `PROBE_FLUSH_SECONDS` | `60` | Batch-flush interval for streaming ingest (min 5). |
| `ALERT_CPU_PCT` / `ALERT_MEM_PCT` / `ALERT_DISK_PCT` | `90` | Default alert thresholds (percent); per-user overrides via `PUT /v1/alerts`. |
| `SESSION_SECRET` | *(secret)* | HMAC key for session tokens. **Required.** |
| `FCM_SERVICE_ACCOUNT` | *(secret)* | Firebase service-account JSON for push. Optional. |

## Management panel

Open the worker's root URL (`https://<your-worker>/`) in a browser. It serves a
**React + [shadcn/ui](https://ui.shadcn.com)** dashboard (in [`panel/`](panel),
built to `panel/dist` and served via [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/);
non-asset requests fall through to the API): sign in or create an account, watch
your probe hosts update live over the WebSocket, mint/revoke host tokens, manage
push devices, and see the synced config revision. Same-origin, so no CORS — only
the session token is kept in `localStorage`.

`npm run deploy` builds the panel first (via `predeploy` → `build:panel`); run
`npm run build:panel` by hand for a `wrangler dev` session.

## API

All bodies are JSON. Authenticated client routes take
`Authorization: Bearer <session token>`; ingest takes the per-host probe token.
CORS is wildcard-open (bearer tokens only, never cookies), so the desktop
renderer and a browser panel can call the API directly.

### Accounts

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `POST` | `/v1/auth/register` | `{ email, password }` | `{ user, token, expiresAt }` |
| `POST` | `/v1/auth/login` | `{ email, password }` | `{ user, token, expiresAt }` |
| `GET`  | `/v1/auth/me` | — | `{ user }` |

### Config sync

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/v1/sync` | — | `{ version, updatedAt, payload }` (404 if never synced) |
| `PUT` | `/v1/sync` | `{ payload, baseVersion? }` | `{ version, updatedAt }` |

`payload` is the secret-free `SyncPayload` (`version: 1`). Pass the `version`
you last saw as `baseVersion` for optimistic locking — a concurrent change
returns **409** so you can merge instead of clobbering another device.

### Live status stream

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET` | `/v1/stream` | session | **WebSocket**: live snapshots for all your hosts. |

A logged-in client opens a WebSocket and receives a frame for every probe
snapshot as it is ingested, across all of its hosts. Because browsers can't set
headers on a WebSocket, the session token is passed as `?token=` (the
`Authorization` header also works). It is backed by a per-user `UserHub`
Durable Object (hibernating) that the ingest paths publish into. Messages:

```jsonc
{ "type": "hello", "at": 1719500000000 }
{ "type": "snapshot", "hostId": "…", "at": 1719500000123, "snapshot": { /* servercase.probe.v1 */ } }
```

### Probes

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET`    | `/v1/probes` | session | List hosts + their latest snapshot. |
| `POST`   | `/v1/probes` | session | `{ name }` → `{ host, token }` (**token shown once**). |
| `DELETE` | `/v1/probes/:id` | session | Revoke a host and its history. |
| `GET`    | `/v1/probes/:id/history?limit=&since=` | session | Metric points (CPU/mem %), oldest first, for charts. |
| `POST`   | `/v1/ingest` | probe token | Upload one `servercase.probe.v1` snapshot over HTTP. |
| `GET`    | `/v1/ingest/ws` | probe token | **WebSocket**: stream one snapshot per text frame. |

**WebSocket ingest (preferred).** The probe holds a single connection and sends
one `servercase.probe.v1` line per text frame. It is backed by a
`ProbeSocket` Durable Object — one instance per host — using the WebSocket
[Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
so idle connections cost nothing and pings are auto-answered. The token is sent
in the `Authorization` header (or `?token=` for clients that can't set headers).

To keep D1 writes low, the DO buffers samples in its own (hibernation-safe)
storage and flushes them to D1 in **one batch per `PROBE_FLUSH_SECONDS`** (one
`latest` update + one multi-row history insert + one trim) rather than writing
every sample. Live fan-out and alert evaluation still happen on every frame, so
the panel and push stay instant. The HTTP `POST /v1/ingest` fallback writes per
request.

Don't hand-roll a client: deploy the agent with [`probe/deploy/install.sh`](../probe/deploy),
which streams the probe's stdout through `websocat`:

```sh
servercase-probe --interval 10 \
  | websocat --ping-interval 25 -H "Authorization: Bearer $TOKEN" \
      wss://<your-worker>/v1/ingest/ws
```

**HTTP fallback.** Where WebSockets are blocked, post each line instead:

```sh
servercase-probe --interval 10 | while read -r line; do
  curl -fsS -X POST https://<your-worker>/v1/ingest \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "$line" >/dev/null
done
```

### Push notifications (FCM)

Threshold alerts are delivered over **Firebase Cloud Messaging**. On each
ingested snapshot the worker evaluates CPU / memory / per-mount disk against the
effective thresholds (per-user overrides resolved against the `ALERT_*_PCT`
defaults) and, on a *transition* (a metric crossing its threshold or
recovering), sends a push to the user's registered `fcm` devices. Tokens FCM
reports as dead are pruned automatically. Messages carry
`data: { hostId, type: "alert" | "recovery", metric }` for client routing.

| Method | Path | Body | Notes |
|--------|------|------|-------|
| `GET`    | `/v1/devices` | — | List registered devices. |
| `POST`   | `/v1/devices` | `{ platform, token, label? }` | `platform` ∈ `apns`/`fcm`/`webpush`; idempotent. |
| `DELETE` | `/v1/devices/:id` | — | Unregister. |
| `GET`    | `/v1/alerts` | — | `{ defaults, overrides, effective }` thresholds. |
| `PUT`    | `/v1/alerts` | `{ cpu?, mem?, disk? }` | Per-user overrides; a number sets it, `null` clears to default. |

**Enable it:** create a Firebase project, download a *service-account* key
(Project settings → Service accounts → Generate new private key), and store the
whole JSON as a secret:

```bash
wrangler secret put FCM_SERVICE_ACCOUNT   # paste the service-account JSON
```

Without that secret, push is disabled (alerts are simply not sent). The auth is
the Firebase service account: the worker signs a short-lived RS256 JWT with the
account key (Web Crypto), exchanges it for an OAuth2 token (cached), and calls
the FCM HTTP v1 API — no Firebase Admin SDK.

**Client side:** all three clients obtain an FCM registration token and
`POST /v1/devices { platform: "fcm", token }` once signed in to Cloud — Android
(`firebase-messaging`), iOS (Firebase SPM + APNs), and desktop (FCM web push,
dev/served origins only). Each needs its Firebase project config; see the
clients' READMEs.

## License

Original work, released under the [BSD 3-Clause License](../LICENSE).
