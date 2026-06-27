/**
 * Config sync: a logged-in client pushes and pulls its single secret-free
 * {@link SyncPayload}. Concurrency is last-write-wins with optional optimistic
 * locking — a client may pass `baseVersion` and gets a 409 if the stored copy
 * has moved on since, so it can merge instead of clobbering another device.
 */
import { eq } from 'drizzle-orm';
import type { Ctx } from '../router.ts';
import { badRequest, conflict, json, notFound, readJson } from '../http.ts';
import { looksLikeSyncPayload } from '../shared.ts';
import { requireUser } from '../auth/session.ts';
import { getDb } from '../db/client.ts';
import { syncState } from '../db/schema.ts';

/** GET /v1/sync — the user's latest config snapshot, or 404 if never synced. */
export async function getSync(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const row = await getDb(ctx.env)
    .select()
    .from(syncState)
    .where(eq(syncState.userId, user.id))
    .get();
  if (!row) throw notFound('no config synced yet');

  return json({
    version: row.version,
    updatedAt: row.updatedAt,
    payload: JSON.parse(row.payload),
  });
}

/** PUT /v1/sync — replace the user's config snapshot. */
export async function putSync(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);

  const payload = body.payload;
  if (!looksLikeSyncPayload(payload)) {
    throw badRequest('payload must be a ServerCase sync snapshot (version 1)');
  }
  const baseVersion = body.baseVersion;
  if (baseVersion !== undefined && typeof baseVersion !== 'number') {
    throw badRequest('baseVersion must be a number');
  }

  const db = getDb(ctx.env);
  const current = await db
    .select({ version: syncState.version })
    .from(syncState)
    .where(eq(syncState.userId, user.id))
    .get();
  const currentVersion = current?.version ?? 0;

  if (baseVersion !== undefined && baseVersion !== currentVersion) {
    throw conflict(`stale base version (server is at ${currentVersion})`);
  }

  const nextVersion = currentVersion + 1;
  const now = Date.now();
  const serialized = JSON.stringify(payload);
  await db
    .insert(syncState)
    .values({ userId: user.id, version: nextVersion, payload: serialized, updatedAt: now })
    .onConflictDoUpdate({
      target: syncState.userId,
      set: { version: nextVersion, payload: serialized, updatedAt: now },
    });

  return json({ version: nextVersion, updatedAt: now });
}
