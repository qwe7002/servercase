/**
 * Client live-status stream. A logged-in client opens a WebSocket and receives
 * each probe snapshot as it is ingested, for every host it owns. Browsers can't
 * set headers on a WebSocket, so the session token is accepted as `?token=`
 * (the Authorization header also works for non-browser clients).
 */
import type { Ctx } from '../router.ts';
import { badRequest, bearer, unauthorized } from '../http.ts';
import { verifySession } from '../auth/jwt.ts';

/** GET /v1/stream — subscribe to live snapshots, routed to the user's hub. */
export async function openUserStream(ctx: Ctx): Promise<Response> {
  if ((ctx.req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    throw badRequest('expected a WebSocket upgrade');
  }
  const token = bearer(ctx.req) ?? ctx.url.searchParams.get('token') ?? undefined;
  if (!token) throw unauthorized('missing session token');
  const claims = await verifySession(token, ctx.env.SESSION_SECRET);
  if (!claims) throw unauthorized('invalid or expired session');

  const stub = ctx.env.USER_HUB.get(ctx.env.USER_HUB.idFromName(claims.sub));
  const headers = new Headers(ctx.req.headers);
  headers.set('X-Sc-User-Id', claims.sub);
  return stub.fetch(new Request(ctx.req.url, { method: 'GET', headers }));
}
