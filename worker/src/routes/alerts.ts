/**
 * Per-user alert thresholds. `GET` returns the effective thresholds (the user's
 * overrides resolved against the ALERT_*_PCT env defaults) plus the raw
 * overrides; `PUT` saves overrides (a number sets it, null clears it back to
 * the default).
 */
import { eq } from 'drizzle-orm';
import type { Ctx } from '../router.ts';
import { badRequest, json, readJson } from '../http.ts';
import { requireUser } from '../auth/session.ts';
import { getDb } from '../db/client.ts';
import { alertRules } from '../db/schema.ts';
import { mergeThresholds, thresholdsFromEnv } from '../push/alerts.ts';

type Field = 'cpu' | 'mem' | 'disk';
const FIELDS: Field[] = ['cpu', 'mem', 'disk'];

/** GET /v1/alerts — effective thresholds + the user's raw overrides. */
export async function getAlerts(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const row = await getDb(ctx.env)
    .select({ cpu: alertRules.cpu, mem: alertRules.mem, disk: alertRules.disk })
    .from(alertRules)
    .where(eq(alertRules.userId, user.id))
    .get();

  const defaults = thresholdsFromEnv(ctx.env);
  return json({
    defaults,
    overrides: { cpu: row?.cpu ?? null, mem: row?.mem ?? null, disk: row?.disk ?? null },
    effective: mergeThresholds(defaults, row ?? null),
  });
}

/** PUT /v1/alerts — save overrides. Each field: number to set, null to clear. */
export async function putAlerts(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);

  const values: Record<Field, number | null> = { cpu: null, mem: null, disk: null };
  for (const field of FIELDS) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || v < 0 || v > 100) {
      throw badRequest(`"${field}" must be a number between 0 and 100, or null`);
    }
    values[field] = Math.round(v);
  }

  const now = Date.now();
  await getDb(ctx.env)
    .insert(alertRules)
    .values({ userId: user.id, ...values, updatedAt: now })
    .onConflictDoUpdate({
      target: alertRules.userId,
      set: { ...values, updatedAt: now },
    });

  const defaults = thresholdsFromEnv(ctx.env);
  return json({ overrides: values, effective: mergeThresholds(defaults, values) });
}
