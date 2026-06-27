/**
 * Probe ingest, authenticated by a per-host bearer token (not a user session).
 * Two transports share the same auth and storage:
 *
 *   • POST /v1/ingest      — one snapshot per request (curl-friendly fallback).
 *   • GET  /v1/ingest/ws   — a WebSocket that streams one snapshot per text
 *                            frame, handled by the ProbeSocket Durable Object.
 */
import type { Ctx } from '../router.ts';
import { badRequest, bearer, json, unauthorized } from '../http.ts';
import { sha256Hex } from '../ids.ts';
import { looksLikeProbeSnapshot } from '../shared.ts';
import { storeSnapshot } from '../probe_store.ts';
import { dispatchAlerts } from '../push/index.ts';

interface AuthedHost {
  id: string;
  user_id: string;
}

/** Resolves a probe token (header or `?token=`) to its host, or throws 401. */
async function authProbe(ctx: Ctx): Promise<AuthedHost> {
  const token = bearer(ctx.req) ?? ctx.url.searchParams.get('token') ?? undefined;
  if (!token) throw unauthorized('missing probe token');
  const host = await ctx.env.DB.prepare(
    'SELECT id, user_id FROM probe_hosts WHERE token_hash = ?',
  )
    .bind(await sha256Hex(token))
    .first<AuthedHost>();
  if (!host) throw unauthorized('invalid probe token');
  return host;
}

/** POST /v1/ingest — upload one probe snapshot over HTTP. */
export async function ingest(ctx: Ctx): Promise<Response> {
  const host = await authProbe(ctx);

  let snapshot: unknown;
  try {
    snapshot = await ctx.req.json();
  } catch {
    throw badRequest('body must be valid probe JSON');
  }
  if (!looksLikeProbeSnapshot(snapshot)) {
    throw badRequest('expected a servercase.probe.v1 snapshot');
  }

  await storeSnapshot(ctx.env, host.id, snapshot);
  ctx.exec.waitUntil(dispatchAlerts(ctx.env, host.user_id, host.id, snapshot));
  return json({ received: true, collectedAt: snapshot.collected_at_ms });
}

/** GET /v1/ingest/ws — open a streaming WebSocket, routed to the host's DO. */
export async function openProbeSocket(ctx: Ctx): Promise<Response> {
  if ((ctx.req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    throw badRequest('expected a WebSocket upgrade');
  }
  const host = await authProbe(ctx);

  // One Durable Object per host keeps each host's socket and writes serialized.
  const stub = ctx.env.PROBE_SOCKET.get(ctx.env.PROBE_SOCKET.idFromName(host.id));

  // Forward the upgrade with the resolved identity (the DO trusts these headers
  // because only this authenticated path can set them).
  const headers = new Headers(ctx.req.headers);
  headers.set('X-Sc-Host-Id', host.id);
  headers.set('X-Sc-User-Id', host.user_id);
  return stub.fetch(new Request(ctx.req.url, { method: 'GET', headers }));
}
