/**
 * Probe host management (user-authenticated). A user creates a named host,
 * which mints a per-host bearer token the probe agent uses to upload snapshots.
 * The raw token is returned exactly once at creation.
 */
import type { Ctx } from '../router.ts';
import { json, notFound, readJson, requireString } from '../http.ts';
import { newId, newProbeToken, sha256Hex } from '../ids.ts';
import { requireUser } from '../auth/session.ts';

interface HostRow {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  latest_snapshot: string | null;
}

function presentHost(row: HostRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    latest: row.latest_snapshot ? JSON.parse(row.latest_snapshot) : null,
  };
}

/** GET /v1/probes — list the user's hosts with their latest snapshot. */
export async function listProbes(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, name, created_at, last_seen_at, latest_snapshot
     FROM probe_hosts WHERE user_id = ? ORDER BY created_at`,
  )
    .bind(user.id)
    .all<HostRow>();
  return json({ hosts: (results ?? []).map(presentHost) });
}

/** POST /v1/probes — create a host and return its one-time probe token. */
export async function createProbe(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const name = requireString(body, 'name');

  const id = newId();
  const token = newProbeToken();
  await ctx.env.DB.prepare(
    `INSERT INTO probe_hosts (id, user_id, name, token_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, name, await sha256Hex(token), Date.now())
    .run();

  // `token` is shown once here and never again — only its hash is stored.
  return json({ host: { id, name }, token }, 201);
}

/** DELETE /v1/probes/:id — revoke a host and drop its history. */
export async function deleteProbe(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const result = await ctx.env.DB.prepare(
    'DELETE FROM probe_hosts WHERE id = ? AND user_id = ?',
  )
    .bind(ctx.params.id, user.id)
    .run();
  if (!result.meta.changes) throw notFound('probe host not found');
  return json({ deleted: true });
}

/** GET /v1/probes/:id/history — recent snapshots for one host, newest first. */
export async function probeHistory(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);

  const host = await ctx.env.DB.prepare(
    'SELECT id FROM probe_hosts WHERE id = ? AND user_id = ?',
  )
    .bind(ctx.params.id, user.id)
    .first<{ id: string }>();
  if (!host) throw notFound('probe host not found');

  const limit = Math.min(Math.max(Number.parseInt(ctx.url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
  const { results } = await ctx.env.DB.prepare(
    `SELECT collected_at, received_at, snapshot
     FROM probe_snapshots WHERE host_id = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(host.id, limit)
    .all<{ collected_at: number; received_at: number; snapshot: string }>();

  return json({
    hostId: host.id,
    snapshots: (results ?? []).map((r) => ({
      collectedAt: r.collected_at,
      receivedAt: r.received_at,
      snapshot: JSON.parse(r.snapshot),
    })),
  });
}
