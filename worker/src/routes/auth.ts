/** Account registration, login and "who am I" routes. */
import { eq } from 'drizzle-orm';
import type { Ctx } from '../router.ts';
import { registrationAllowed } from '../env.ts';
import { conflict, forbidden, json, readJson, requireString, unauthorized } from '../http.ts';
import { newId } from '../ids.ts';
import { hashPassword, verifyPassword } from '../auth/password.ts';
import { issueSession } from '../auth/jwt.ts';
import { requireUser } from '../auth/session.ts';
import { getDb } from '../db/client.ts';
import { users } from '../db/schema.ts';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function register(ctx: Ctx): Promise<Response> {
  if (!registrationAllowed(ctx.env)) throw forbidden('registration is closed');

  const body = await readJson(ctx.req);
  const email = normalizeEmail(requireString(body, 'email'));
  const password = requireString(body, 'password');
  if (!email.includes('@')) throw conflict('email is not valid');
  if (password.length < 8) throw conflict('password must be at least 8 characters');

  const id = newId();
  const passwordHash = await hashPassword(password);
  try {
    await getDb(ctx.env)
      .insert(users)
      .values({ id, email, passwordHash, createdAt: Date.now() });
  } catch (err) {
    // The unique index on email surfaces as a constraint failure.
    if (String(err).includes('UNIQUE')) throw conflict('email already registered');
    throw err;
  }

  const session = await issueSession(id, email, ctx.env.SESSION_SECRET);
  return json({ user: { id, email }, ...session }, 201);
}

export async function login(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req);
  const email = normalizeEmail(requireString(body, 'email'));
  const password = requireString(body, 'password');

  const row = await getDb(ctx.env)
    .select()
    .from(users)
    .where(eq(users.email, email))
    .get();

  // Always run a verification to keep timing roughly constant whether or not
  // the account exists.
  const ok = row
    ? await verifyPassword(password, row.passwordHash)
    : await verifyPassword(password, 'pbkdf2$210000$AAAA$AAAA');
  if (!row || !ok) throw unauthorized('invalid email or password');

  const session = await issueSession(row.id, row.email, ctx.env.SESSION_SECRET);
  return json({ user: { id: row.id, email: row.email }, ...session });
}

export async function me(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  return json({ user });
}
