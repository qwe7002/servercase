/**
 * Config sync: a logged-in client pushes and pulls its single secret-free
 * {@link SyncPayload}. Concurrency is last-write-wins with optional optimistic
 * locking — a client may pass `baseVersion` and gets a 409 if the stored copy
 * has moved on since, so it can merge instead of clobbering another device.
 */
import type { Ctx } from '../router.ts';
import { badRequest, conflict, json, notFound, readJson } from '../http.ts';
import { looksLikeSyncPayload } from '../shared.ts';
import { requireUser } from '../auth/session.ts';

interface SyncRow {
  version: number;
  payload: string;
  updated_at: number;
}

/** GET /v1/sync — the user's latest config snapshot, or 404 if never synced. */
export async function getSync(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const row = await ctx.env.DB.prepare(
    'SELECT version, payload, updated_at FROM sync_state WHERE user_id = ?',
  )
    .bind(user.id)
    .first<SyncRow>();
  if (!row) throw notFound('no config synced yet');

  return json({
    version: row.version,
    updatedAt: row.updated_at,
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

  const current = await ctx.env.DB.prepare('SELECT version FROM sync_state WHERE user_id = ?')
    .bind(user.id)
    .first<{ version: number }>();
  const currentVersion = current?.version ?? 0;

  if (baseVersion !== undefined && baseVersion !== currentVersion) {
    throw conflict(`stale base version (server is at ${currentVersion})`);
  }

  const nextVersion = currentVersion + 1;
  const now = Date.now();
  await ctx.env.DB.prepare(
    `INSERT INTO sync_state (user_id, version, payload, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       version = excluded.version,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  )
    .bind(user.id, nextVersion, JSON.stringify(payload), now)
    .run();

  return json({ version: nextVersion, updatedAt: now });
}
