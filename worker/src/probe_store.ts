/**
 * Persistence for probe snapshots, shared by the HTTP (`POST /v1/ingest`) and
 * WebSocket (`ProbeSocket` Durable Object) ingest paths so both store identically.
 */
import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { Env } from './env.ts';
import { probeHistoryLimit } from './env.ts';
import type { ProbeSnapshot } from './shared.ts';
import { getDb } from './db/client.ts';
import { probeHosts, probeSnapshots } from './db/schema.ts';

/**
 * Store one snapshot as the host's latest and append it to bounded history.
 * Returns the receive timestamp (epoch ms).
 */
export async function storeSnapshot(
  env: Env,
  hostId: string,
  snapshot: ProbeSnapshot,
): Promise<number> {
  const db = getDb(env);
  const now = Date.now();
  const raw = JSON.stringify(snapshot);
  const limit = probeHistoryLimit(env);

  const updateLatest = db
    .update(probeHosts)
    .set({ latestSnapshot: raw, lastSeenAt: now })
    .where(eq(probeHosts.id, hostId));

  if (limit === 0) {
    await updateLatest;
    return now;
  }

  // The newest `limit` ids to keep (evaluated after the insert, inside the
  // batch's transaction) — everything else for this host is trimmed.
  const keep = db
    .select({ id: probeSnapshots.id })
    .from(probeSnapshots)
    .where(eq(probeSnapshots.hostId, hostId))
    .orderBy(desc(probeSnapshots.id))
    .limit(limit);

  await db.batch([
    updateLatest,
    db.insert(probeSnapshots).values({
      hostId,
      collectedAt: snapshot.collected_at_ms,
      receivedAt: now,
      snapshot: raw,
    }),
    db
      .delete(probeSnapshots)
      .where(and(eq(probeSnapshots.hostId, hostId), notInArray(probeSnapshots.id, keep))),
  ]);
  return now;
}
