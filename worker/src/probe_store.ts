/**
 * Persistence for probe snapshots, shared by the HTTP (`POST /v1/ingest`) and
 * WebSocket (`ProbeSocket` Durable Object) ingest paths so both store identically.
 */
import type { Env } from './env.ts';
import { probeHistoryLimit } from './env.ts';
import type { ProbeSnapshot } from './shared.ts';

/**
 * Store one snapshot as the host's latest and append it to bounded history.
 * Returns the receive timestamp (epoch ms).
 */
export async function storeSnapshot(
  env: Env,
  hostId: string,
  snapshot: ProbeSnapshot,
): Promise<number> {
  const now = Date.now();
  const raw = JSON.stringify(snapshot);
  const limit = probeHistoryLimit(env);

  const statements = [
    env.DB.prepare(
      'UPDATE probe_hosts SET latest_snapshot = ?, last_seen_at = ? WHERE id = ?',
    ).bind(raw, now, hostId),
  ];
  if (limit > 0) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO probe_snapshots (host_id, collected_at, received_at, snapshot) VALUES (?, ?, ?, ?)',
      ).bind(hostId, snapshot.collected_at_ms, now, raw),
      // Trim to the newest `limit` rows for this host.
      env.DB.prepare(
        `DELETE FROM probe_snapshots
         WHERE host_id = ?1
           AND id NOT IN (
             SELECT id FROM probe_snapshots WHERE host_id = ?1 ORDER BY id DESC LIMIT ?2
           )`,
      ).bind(hostId, limit),
    );
  }
  await env.DB.batch(statements);
  return now;
}
