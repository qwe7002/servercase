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

  // Extracted metrics, stored as columns for cheap history/aggregation queries.
  const cpuUsage = snapshot.cpu_usage;
  const memTotal = snapshot.memory.mem_total_kb;
  const memPct = memTotal > 0 ? (snapshot.memory.mem_used_kb / memTotal) * 100 : null;

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
      cpuUsage,
      memPct,
    }),
    db
      .delete(probeSnapshots)
      .where(and(eq(probeSnapshots.hostId, hostId), notInArray(probeSnapshots.id, keep))),
  ]);
  return now;
}

/** One buffered probe sample held in the Durable Object between flushes. */
export interface BufferedSample {
  collectedAt: number;
  cpuUsage: number | null;
  memPct: number | null;
  /** The raw servercase.probe.v1 JSON. */
  raw: string;
}

/**
 * Persist a batch of buffered samples in a single D1 round-trip: update the
 * host's latest snapshot once, insert all history rows in one multi-row INSERT,
 * and trim once. Called per minute by the ProbeSocket DO instead of writing on
 * every sample.
 */
export async function persistBatch(
  env: Env,
  hostId: string,
  samples: BufferedSample[],
): Promise<void> {
  if (samples.length === 0) return;
  const db = getDb(env);
  const now = Date.now();
  const limit = probeHistoryLimit(env);
  const latest = samples.reduce((a, b) => (b.collectedAt > a.collectedAt ? b : a));

  const updateLatest = db
    .update(probeHosts)
    .set({ latestSnapshot: latest.raw, lastSeenAt: now })
    .where(eq(probeHosts.id, hostId));

  if (limit === 0) {
    await updateLatest;
    return;
  }

  const insert = db.insert(probeSnapshots).values(
    samples.map((s) => ({
      hostId,
      collectedAt: s.collectedAt,
      receivedAt: now,
      snapshot: s.raw,
      cpuUsage: s.cpuUsage,
      memPct: s.memPct,
    })),
  );
  const keep = db
    .select({ id: probeSnapshots.id })
    .from(probeSnapshots)
    .where(eq(probeSnapshots.hostId, hostId))
    .orderBy(desc(probeSnapshots.id))
    .limit(limit);
  const trim = db
    .delete(probeSnapshots)
    .where(and(eq(probeSnapshots.hostId, hostId), notInArray(probeSnapshots.id, keep)));

  await db.batch([updateLatest, insert, trim]);
}
