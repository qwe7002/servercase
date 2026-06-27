/** Session middleware: resolves the bearer token to an authenticated user. */
import type { Ctx } from '../router.ts';
import { bearer, unauthorized } from '../http.ts';
import { verifySession } from './jwt.ts';

export interface AuthedUser {
  id: string;
  email: string;
}

/** Requires a valid session token; throws 401 otherwise. */
export async function requireUser(ctx: Ctx): Promise<AuthedUser> {
  const token = bearer(ctx.req);
  if (!token) throw unauthorized('missing bearer token');
  const claims = await verifySession(token, ctx.env.SESSION_SECRET);
  if (!claims) throw unauthorized('invalid or expired session');
  return { id: claims.sub, email: claims.email };
}
