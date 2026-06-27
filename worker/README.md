# ServerCase Worker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) that provides
the **thin cloud side** of ServerCase. It does three things and prepares for a
fourth:

1. **Account login** — email + password, so a user owns their cloud data.
2. **Config sync** — pull/push the secret-free `SyncPayload` (the same snapshot
   the desktop app writes to its local sync file) across devices.
3. **Probe ingest** — receive `servercase.probe.v1` snapshots from the
   [`probe/`](../probe) agent over per-host tokens, keeping latest + history.
4. **Push scaffolding** — clients can already register push tokens, and the
   ingest path calls a delivery seam, but **no notifications are sent yet**.

```
ServerCase app ──login──> Worker ──> D1 (accounts, config, probes, devices)
probe agent  ──probe.v1──> Worker
```

Consistent with the rest of ServerCase, **secrets never reach the cloud**: SSH
credentials and the Bitwarden vault stay in the app. Stored server definitions
are secret-free and the Bitwarden API key is redacted before upload. It has **no
runtime dependencies** — everything (PBKDF2 password hashing, HMAC session
tokens, token hashing) uses the Workers Web Crypto API.

## Layout

| Path | Purpose |
|------|---------|
| `src/index.ts` | Entry point; route table. |
| `src/router.ts` | Tiny method + `:param` path router. |
| `src/auth/` | PBKDF2 passwords, HMAC session tokens, session middleware. |
| `src/routes/` | `auth`, `sync`, `probes`, `ingest`, `devices`. |
| `src/push/` | Notifier interface + no-op + `dispatchAlerts` seam (future-prep). |
| `src/shared.ts` | Client-facing types (`SyncPayload`, `servercase.probe.v1`). |
| `migrations/` | D1 schema. |

## Setup

```bash
npm install
wrangler login

# Create the D1 database and paste the returned id into wrangler.toml.
wrangler d1 create servercase

# Apply the schema.
npm run migrate:local      # for `wrangler dev`
npm run migrate:remote     # for production

# Set the session-signing secret (never commit it).
wrangler secret put SESSION_SECRET
# For local dev, put it in .dev.vars instead:  SESSION_SECRET=dev-secret

npm run dev                # local
npm run deploy             # production
```

Config (`wrangler.toml [vars]`):

| Var | Default | Meaning |
|-----|---------|---------|
| `ALLOW_REGISTRATION` | `1` | Set `0` to close public signup. |
| `PROBE_HISTORY_LIMIT` | `240` | History rows kept per host (`0` = latest only). |
| `SESSION_SECRET` | *(secret)* | HMAC key for session tokens. **Required.** |

## API

All bodies are JSON. Authenticated client routes take
`Authorization: Bearer <session token>`; ingest takes the per-host probe token.

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

### Probes

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET`    | `/v1/probes` | session | List hosts + their latest snapshot. |
| `POST`   | `/v1/probes` | session | `{ name }` → `{ host, token }` (**token shown once**). |
| `DELETE` | `/v1/probes/:id` | session | Revoke a host and its history. |
| `GET`    | `/v1/probes/:id/history?limit=` | session | Recent snapshots, newest first. |
| `POST`   | `/v1/ingest` | probe token | Upload one `servercase.probe.v1` snapshot. |

Point the probe at the worker (a tiny wrapper around the agent's stdout):

```sh
TOKEN=scp_...   # from POST /v1/probes
servercase-probe --interval 10 | while read -r line; do
  curl -fsS -X POST https://<your-worker>/v1/ingest \
    -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "$line" >/dev/null
done
```

### Push devices (future-prep)

| Method | Path | Body | Notes |
|--------|------|------|-------|
| `GET`    | `/v1/devices` | — | List registered devices. |
| `POST`   | `/v1/devices` | `{ platform, token, label? }` | `platform` ∈ `apns`/`fcm`/`webpush`; idempotent. |
| `DELETE` | `/v1/devices/:id` | — | Unregister. |

Tokens are stored so the apps can register today. Delivery is **not implemented
yet**: see [`src/push/`](src/push/index.ts) — the `Notifier` interface, the
`NoopNotifier`, and the `dispatchAlerts` hook the ingest path already calls.
Adding APNs/FCM/Web Push and user alert rules is then confined to that module.

## License

Original work, released under the [BSD 3-Clause License](../LICENSE).
