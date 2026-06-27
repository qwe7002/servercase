/** Bindings configured in wrangler.toml / secrets. */
export interface Env {
  /** D1 database (accounts, sync, probes, push devices). */
  DB: D1Database;
  /** Durable Object namespace backing the streaming WebSocket ingest. */
  PROBE_SOCKET: DurableObjectNamespace;
  /** Durable Object namespace fanning live snapshots out to a user's clients. */
  USER_HUB: DurableObjectNamespace;
  /** HMAC secret used to sign session tokens. Set via `wrangler secret put`. */
  SESSION_SECRET: string;
  /** "1"/"true" to allow public registration. Defaults to allowed. */
  ALLOW_REGISTRATION?: string;
  /** Max history rows kept per probe host. Defaults to 240. "0" keeps latest only. */
  PROBE_HISTORY_LIMIT?: string;
}

export function registrationAllowed(env: Env): boolean {
  const raw = (env.ALLOW_REGISTRATION ?? '1').toLowerCase();
  return raw === '1' || raw === 'true';
}

export function probeHistoryLimit(env: Env): number {
  const n = Number.parseInt(env.PROBE_HISTORY_LIMIT ?? '240', 10);
  return Number.isFinite(n) && n >= 0 ? n : 240;
}
