/**
 * Types exchanged with the ServerCase clients. These mirror the app-side
 * shapes (see desktop/electron/shared.ts and the probe's servercase.probe.v1
 * JSON) so the contract lives in one readable place on the cloud side.
 *
 * The worker treats the config payload and probe snapshot as opaque JSON for
 * storage — it validates shape only enough to be safe, never the full schema —
 * so client-side changes don't require a redeploy.
 */

/** The schema tag emitted by servercase-probe. */
export const PROBE_SCHEMA = 'servercase.probe.v1';

/**
 * Secret-free configuration snapshot uploaded by a logged-in client. This is
 * the same {@link SyncPayload} the desktop app writes to its local sync file:
 * server definitions with all secret fields stripped, plus global settings
 * (with the Bitwarden API key redacted). Secrets sync through Bitwarden, never
 * through here.
 */
export interface SyncPayload {
  version: 1;
  exportedAt: number;
  servers: unknown[];
  settings: Record<string, unknown>;
}

/** A single host snapshot, matching the probe's servercase.probe.v1 output. */
export interface ProbeSnapshot {
  schema: typeof PROBE_SCHEMA;
  collected_at_ms: number;
  hostname: string;
  kernel: string;
  uptime_sec: number;
  load_avg: [number, number, number];
  cpu_usage: number | null;
  memory: {
    mem_total_kb: number;
    mem_used_kb: number;
    swap_total_kb: number;
    swap_used_kb: number;
  };
  disks: unknown[];
  network: Record<string, unknown>;
}

/**
 * Light validation: confirm an uploaded probe body looks like a v1 snapshot
 * before we store it. We intentionally don't deep-validate every field.
 */
export function looksLikeProbeSnapshot(body: unknown): body is ProbeSnapshot {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    b.schema === PROBE_SCHEMA &&
    typeof b.collected_at_ms === 'number' &&
    typeof b.hostname === 'string' &&
    typeof b.memory === 'object' &&
    b.memory !== null
  );
}

/** Light validation for an uploaded config snapshot. */
export function looksLikeSyncPayload(body: unknown): body is SyncPayload {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    b.version === 1 &&
    typeof b.exportedAt === 'number' &&
    Array.isArray(b.servers) &&
    typeof b.settings === 'object' &&
    b.settings !== null
  );
}
