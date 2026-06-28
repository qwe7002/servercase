/**
 * Probe host management (user-authenticated). A user creates a named host,
 * which mints a per-host bearer token the probe agent uses to upload snapshots.
 * The raw token is returned exactly once at creation.
 */
import { and, desc, eq, gte } from 'drizzle-orm';
import type { Ctx } from '../router.ts';
import { json, notFound, readJson, requireString } from '../http.ts';
import { newId, newProbeToken, sha256Hex } from '../ids.ts';
import { requireUser } from '../auth/session.ts';
import { getDb } from '../db/client.ts';
import { probeHosts, probeSnapshots } from '../db/schema.ts';

type HostRow = typeof probeHosts.$inferSelect;

function presentHost(row: HostRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    latest: row.latestSnapshot ? JSON.parse(row.latestSnapshot) : null,
  };
}

/** GET /v1/probes — list the user's hosts with their latest snapshot. */
export async function listProbes(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const rows = await getDb(ctx.env)
    .select()
    .from(probeHosts)
    .where(eq(probeHosts.userId, user.id))
    .orderBy(probeHosts.createdAt)
    .all();
  return json({ hosts: rows.map(presentHost) });
}

/** POST /v1/probes — create a host and return its one-time probe token. */
export async function createProbe(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const name = requireString(body, 'name');

  const id = newId();
  const token = newProbeToken();
  await getDb(ctx.env).insert(probeHosts).values({
    id,
    userId: user.id,
    name,
    tokenHash: await sha256Hex(token),
    createdAt: Date.now(),
  });

  // `token` is shown once here and never again — only its hash is stored.
  return json({ host: { id, name }, token }, 201);
}

/** DELETE /v1/probes/:id — revoke a host and drop its history. */
export async function deleteProbe(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const deleted = await getDb(ctx.env)
    .delete(probeHosts)
    .where(and(eq(probeHosts.id, ctx.params.id), eq(probeHosts.userId, user.id)))
    .returning({ id: probeHosts.id });
  if (deleted.length === 0) throw notFound('probe host not found');
  return json({ deleted: true });
}

/**
 * GET /v1/probes/:id/history — recent metric points for one host, oldest first
 * (chart-ready). Returns the extracted cpu/mem columns rather than the full
 * snapshot JSON. `?limit=` (default 240, max 1000) and `?since=<epoch ms>`.
 */
export async function probeHistory(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const db = getDb(ctx.env);

  const host = await db
    .select({ id: probeHosts.id })
    .from(probeHosts)
    .where(and(eq(probeHosts.id, ctx.params.id), eq(probeHosts.userId, user.id)))
    .get();
  if (!host) throw notFound('probe host not found');

  const limit = Math.min(
    Math.max(Number.parseInt(ctx.url.searchParams.get('limit') ?? '240', 10) || 240, 1),
    1000,
  );
  const since = Number.parseInt(ctx.url.searchParams.get('since') ?? '', 10);
  const where = Number.isFinite(since)
    ? and(eq(probeSnapshots.hostId, host.id), gte(probeSnapshots.collectedAt, since))
    : eq(probeSnapshots.hostId, host.id);

  // Take the newest `limit` rows, then return them oldest-first for charting.
  const rows = await db
    .select({
      collectedAt: probeSnapshots.collectedAt,
      cpuUsage: probeSnapshots.cpuUsage,
      memPct: probeSnapshots.memPct,
    })
    .from(probeSnapshots)
    .where(where)
    .orderBy(desc(probeSnapshots.id))
    .limit(limit)
    .all();

  return json({ hostId: host.id, points: rows.reverse() });
}
