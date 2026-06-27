/**
 * Probe ingest (authenticated by a per-host bearer token, not a user session).
 * The probe agent POSTs a servercase.probe.v1 snapshot; we store it as the
 * host's latest, append to bounded history, and hand it to the push layer.
 */
import type { Ctx } from '../router.ts';
import { probeHistoryLimit } from '../env.ts';
import { bearer, json, unauthorized } from '../http.ts';
import { sha256Hex } from '../ids.ts';
import { looksLikeProbeSnapshot } from '../shared.ts';
import { dispatchAlerts } from '../push/index.ts';

interface AuthedHost {
  id: string;
  user_id: string;
}

/** POST /v1/ingest — upload one probe snapshot. */
export async function ingest(ctx: Ctx): Promise<Response> {
  const token = bearer(ctx.req);
  if (!token) throw unauthorized('missing probe token');

  const host = await ctx.env.DB.prepare(
    'SELECT id, user_id FROM probe_hosts WHERE token_hash = ?',
  )
    .bind(await sha256Hex(token))
    .first<AuthedHost>();
  if (!host) throw unauthorized('invalid probe token');

  // The probe emits compact JSON to stdout; accept it as the raw request body.
  let snapshot: unknown;
  try {
    snapshot = await ctx.req.json();
  } catch {
    throw unauthorized('body must be valid probe JSON');
  }
  if (!looksLikeProbeSnapshot(snapshot)) {
    return json({ error: 'expected a servercase.probe.v1 snapshot' }, 400);
  }

  const now = Date.now();
  const raw = JSON.stringify(snapshot);
  const limit = probeHistoryLimit(ctx.env);

  const statements = [
    ctx.env.DB.prepare(
      'UPDATE probe_hosts SET latest_snapshot = ?, last_seen_at = ? WHERE id = ?',
    ).bind(raw, now, host.id),
  ];
  if (limit > 0) {
    statements.push(
      ctx.env.DB.prepare(
        'INSERT INTO probe_snapshots (host_id, collected_at, received_at, snapshot) VALUES (?, ?, ?, ?)',
      ).bind(host.id, snapshot.collected_at_ms, now, raw),
      // Trim to the newest `limit` rows for this host.
      ctx.env.DB.prepare(
        `DELETE FROM probe_snapshots
         WHERE host_id = ?1
           AND id NOT IN (
             SELECT id FROM probe_snapshots WHERE host_id = ?1 ORDER BY id DESC LIMIT ?2
           )`,
      ).bind(host.id, limit),
    );
  }
  await ctx.env.DB.batch(statements);

  // Future push delivery runs out of band so ingest stays fast.
  ctx.exec.waitUntil(dispatchAlerts(ctx.env, host.user_id, host.id, snapshot));

  return json({ received: true, collectedAt: snapshot.collected_at_ms });
}
