/**
 * Config sync: a logged-in client pushes and pulls its single secret-free
 * {@link SyncPayload}. Concurrency is last-write-wins with optional optimistic
 * locking — a client may pass `baseVersion` and gets a 409 if the stored copy
 * has moved on since, so it can merge instead of clobbering another device.
 */
import { eq } from 'drizzle-orm';
import type { Ctx } from '../router.ts';
import { badRequest, conflict, json, notFound, readJson } from '../http.ts';
import { looksLikeSyncPayload, type SyncPayload } from '../shared.ts';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function idOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function mergeById(remote: unknown[], incoming: unknown[]): unknown[] {
  const merged: unknown[] = [];
  const positions = new Map<string, number>();

  for (const item of remote) {
    const id = idOf(item);
    if (id) positions.set(id, merged.length);
    merged.push(item);
  }

  for (const item of incoming) {
    const id = idOf(item);
    if (!id) {
      merged.push(item);
      continue;
    }

    const pos = positions.get(id);
    if (pos === undefined) {
      positions.set(id, merged.length);
      merged.push(item);
    } else {
      merged[pos] = item;
    }
  }

  return merged;
}

function mergeValue(remote: unknown, incoming: unknown): unknown {
  if (Array.isArray(remote) && Array.isArray(incoming)) {
    return mergeById(remote, incoming);
  }

  if (isRecord(remote) && isRecord(incoming)) {
    const result: Record<string, unknown> = { ...remote };
    for (const [key, value] of Object.entries(incoming)) {
      result[key] = key in remote ? mergeValue(remote[key], value) : value;
    }
    return result;
  }

  return incoming;
}

function mergeSyncPayload(remote: SyncPayload | null, incoming: SyncPayload): SyncPayload {
  if (!remote) return incoming;
  return {
    version: 1,
    exportedAt: Math.max(remote.exportedAt, incoming.exportedAt),
    servers: mergeById(remote.servers, incoming.servers),
    settings: mergeValue(remote.settings, incoming.settings) as Record<string, unknown>,
  };
}

/** PUT /v1/sync — replace or merge the user's config snapshot. */
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
  const merge = body.merge === true;
  if (body.merge !== undefined && typeof body.merge !== 'boolean') {
    throw badRequest('merge must be a boolean');
  }

  const db = getDb(ctx.env);
  const current = await db
    .select({ version: syncState.version, payload: syncState.payload })
    .from(syncState)
    .where(eq(syncState.userId, user.id))
    .get();
  const currentVersion = current?.version ?? 0;

  if (!merge && baseVersion !== undefined && baseVersion !== currentVersion) {
    throw conflict(`stale base version (server is at ${currentVersion})`);
  }

  const nextVersion = currentVersion + 1;
  const now = Date.now();
  const nextPayload = merge
    ? mergeSyncPayload(current ? (JSON.parse(current.payload) as SyncPayload) : null, payload)
    : payload;
  const serialized = JSON.stringify(nextPayload);
  await db
    .insert(syncState)
    .values({ userId: user.id, version: nextVersion, payload: serialized, updatedAt: now })
    .onConflictDoUpdate({
      target: syncState.userId,
      set: { version: nextVersion, payload: serialized, updatedAt: now },
    });

  return json({ version: nextVersion, updatedAt: now, payload: nextPayload });
}
