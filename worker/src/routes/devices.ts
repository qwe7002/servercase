/**
 * Push device registration (future-prep). Clients register the token issued by
 * their platform (APNs/FCM/Web Push) so the worker can reach them once delivery
 * is implemented. Registration is idempotent per (user, platform, token).
 */
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../router.ts';
import { badRequest, json, notFound, optionalString, readJson, requireString } from '../http.ts';
import { newId } from '../ids.ts';
import { requireUser } from '../auth/session.ts';
import { getDb } from '../db/client.ts';
import { pushDevices } from '../db/schema.ts';
import type { PushPlatform } from '../push/index.ts';

const PLATFORMS: PushPlatform[] = ['apns', 'fcm', 'webpush'];

/** GET /v1/devices — list the user's registered push devices. */
export async function listDevices(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const rows = await getDb(ctx.env)
    .select({
      id: pushDevices.id,
      platform: pushDevices.platform,
      label: pushDevices.label,
      createdAt: pushDevices.createdAt,
      lastSeenAt: pushDevices.lastSeenAt,
    })
    .from(pushDevices)
    .where(eq(pushDevices.userId, user.id))
    .orderBy(pushDevices.createdAt)
    .all();
  return json({ devices: rows });
}

/** POST /v1/devices — register (or refresh) a push token. */
export async function registerDevice(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const platform = requireString(body, 'platform') as PushPlatform;
  if (!PLATFORMS.includes(platform)) {
    throw badRequest(`platform must be one of: ${PLATFORMS.join(', ')}`);
  }
  const token = requireString(body, 'token');
  const label = optionalString(body, 'label') ?? null;
  const now = Date.now();
  const db = getDb(ctx.env);

  // Upsert on the (user, platform, token) unique index: re-registering the same
  // token just refreshes its label and last-seen time.
  await db
    .insert(pushDevices)
    .values({ id: newId(), userId: user.id, platform, token, label, createdAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [pushDevices.userId, pushDevices.platform, pushDevices.token],
      set: { label, lastSeenAt: now },
    });

  const row = await db
    .select({ id: pushDevices.id })
    .from(pushDevices)
    .where(
      and(
        eq(pushDevices.userId, user.id),
        eq(pushDevices.platform, platform),
        eq(pushDevices.token, token),
      ),
    )
    .get();

  return json({ device: { id: row?.id, platform, label } }, 201);
}

/** DELETE /v1/devices/:id — unregister a push device. */
export async function deleteDevice(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const deleted = await getDb(ctx.env)
    .delete(pushDevices)
    .where(and(eq(pushDevices.id, ctx.params.id), eq(pushDevices.userId, user.id)))
    .returning({ id: pushDevices.id });
  if (deleted.length === 0) throw notFound('device not found');
  return json({ deleted: true });
}
