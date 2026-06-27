/**
 * Push device registration (future-prep). Clients register the token issued by
 * their platform (APNs/FCM/Web Push) so the worker can reach them once delivery
 * is implemented. Registration is idempotent per (user, platform, token).
 */
import type { Ctx } from '../router.ts';
import { badRequest, json, notFound, optionalString, readJson, requireString } from '../http.ts';
import { newId } from '../ids.ts';
import { requireUser } from '../auth/session.ts';
import type { PushPlatform } from '../push/index.ts';

const PLATFORMS: PushPlatform[] = ['apns', 'fcm', 'webpush'];

interface DeviceRow {
  id: string;
  platform: string;
  label: string | null;
  created_at: number;
  last_seen_at: number | null;
}

/** GET /v1/devices — list the user's registered push devices. */
export async function listDevices(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, platform, label, created_at, last_seen_at
     FROM push_devices WHERE user_id = ? ORDER BY created_at`,
  )
    .bind(user.id)
    .all<DeviceRow>();
  return json({
    devices: (results ?? []).map((r) => ({
      id: r.id,
      platform: r.platform,
      label: r.label,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    })),
  });
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
  const id = newId();

  // Upsert on the (user, platform, token) unique index: re-registering the same
  // token just refreshes its label and last-seen time.
  await ctx.env.DB.prepare(
    `INSERT INTO push_devices (id, user_id, platform, token, label, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, platform, token) DO UPDATE SET
       label = excluded.label,
       last_seen_at = excluded.last_seen_at`,
  )
    .bind(id, user.id, platform, token, label, now, now)
    .run();

  const row = await ctx.env.DB.prepare(
    'SELECT id FROM push_devices WHERE user_id = ? AND platform = ? AND token = ?',
  )
    .bind(user.id, platform, token)
    .first<{ id: string }>();

  return json({ device: { id: row?.id ?? id, platform, label } }, 201);
}

/** DELETE /v1/devices/:id — unregister a push device. */
export async function deleteDevice(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const result = await ctx.env.DB.prepare(
    'DELETE FROM push_devices WHERE id = ? AND user_id = ?',
  )
    .bind(ctx.params.id, user.id)
    .run();
  if (!result.meta.changes) throw notFound('device not found');
  return json({ deleted: true });
}
