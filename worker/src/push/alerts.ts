/**
 * Threshold alert rules. On each snapshot we compute the set of currently
 * breaching metrics (CPU, memory, and per-mount disk over their thresholds).
 * The caller compares this set with the previously-stored one and notifies only
 * on transitions, so a sustained breach produces one alert, not one per sample.
 */
import type { Env } from '../env.ts';
import type { ProbeSnapshot } from '../shared.ts';
import type { PushMessage } from './index.ts';

export interface Thresholds {
  cpu: number;
  mem: number;
  disk: number;
}

export function thresholdsFromEnv(env: Env): Thresholds {
  return {
    cpu: pct(env.ALERT_CPU_PCT, 90),
    mem: pct(env.ALERT_MEM_PCT, 90),
    disk: pct(env.ALERT_DISK_PCT, 90),
  };
}

interface DiskUsage {
  mount: string;
  used_kb: number;
  total_kb: number;
}

/** The breach keys for a snapshot, e.g. ["cpu", "disk:/data"]. */
export function currentBreaches(snapshot: ProbeSnapshot, t: Thresholds): string[] {
  const breaches: string[] = [];
  if (snapshot.cpu_usage != null && snapshot.cpu_usage >= t.cpu) breaches.push('cpu');
  if (percent(snapshot.memory.mem_used_kb, snapshot.memory.mem_total_kb) >= t.mem) {
    breaches.push('mem');
  }
  for (const disk of snapshot.disks as DiskUsage[]) {
    if (disk && typeof disk.total_kb === 'number' && percent(disk.used_kb, disk.total_kb) >= t.disk) {
      breaches.push(`disk:${disk.mount}`);
    }
  }
  return breaches;
}

/** Builds push messages for breaches that just started or just cleared. */
export function buildMessages(
  hostName: string,
  hostId: string,
  snapshot: ProbeSnapshot,
  previous: string[],
  current: string[],
): PushMessage[] {
  const prev = new Set(previous);
  const cur = new Set(current);
  const messages: PushMessage[] = [];

  for (const key of current) {
    if (!prev.has(key)) {
      messages.push({
        title: `⚠️ ${hostName}`,
        body: describe(key, snapshot),
        data: { hostId, type: 'alert', metric: key },
      });
    }
  }
  for (const key of previous) {
    if (!cur.has(key)) {
      messages.push({
        title: `✅ ${hostName}`,
        body: `${label(key)} back to normal`,
        data: { hostId, type: 'recovery', metric: key },
      });
    }
  }
  return messages;
}

export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function describe(key: string, s: ProbeSnapshot): string {
  if (key === 'cpu') return `CPU at ${Math.round(s.cpu_usage ?? 0)}%`;
  if (key === 'mem') {
    return `Memory at ${Math.round(percent(s.memory.mem_used_kb, s.memory.mem_total_kb))}%`;
  }
  if (key.startsWith('disk:')) {
    const mount = key.slice(5);
    const disk = (s.disks as DiskUsage[]).find((d) => d.mount === mount);
    const value = disk ? Math.round(percent(disk.used_kb, disk.total_kb)) : 0;
    return `Disk ${mount} at ${value}%`;
  }
  return 'Threshold exceeded';
}

function label(key: string): string {
  if (key === 'cpu') return 'CPU';
  if (key === 'mem') return 'Memory';
  if (key.startsWith('disk:')) return `Disk ${key.slice(5)}`;
  return key;
}

function percent(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}

function pct(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) ? n : fallback;
}
