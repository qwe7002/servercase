/**
 * Thin client for the worker's own API. The panel is served same-origin, so
 * requests are relative and need no CORS; only the session token lives in
 * localStorage.
 */
const TOKEN_KEY = 'sc.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface CloudUser {
  id: string;
  email: string;
}

export interface ProbeSnapshot {
  hostname: string;
  kernel: string;
  uptime_sec: number;
  cpu_usage: number | null;
  memory: { mem_used_kb: number; mem_total_kb: number };
  security_updates?: {
    available: boolean | null;
    count: number | null;
    source: string;
    checked_at_ms: number;
  } | null;
}

export interface ProbeHost {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  latest: ProbeSnapshot | null;
}

export interface Device {
  id: string;
  platform: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface SyncInfo {
  version: number;
  updatedAt: number;
  payload: { servers: unknown[] };
}

// ── Endpoints ───────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    api<{ user: CloudUser; token: string }>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string) =>
    api<{ user: CloudUser; token: string }>('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => api<{ user: CloudUser }>('/v1/auth/me'),
};

export interface HistoryPoint {
  collectedAt: number;
  cpuUsage: number | null;
  memPct: number | null;
}

export const probesApi = {
  list: () => api<{ hosts: ProbeHost[] }>('/v1/probes'),
  create: (name: string) =>
    api<{ host: { id: string; name: string }; token: string }>('/v1/probes', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  remove: (id: string) =>
    api<{ deleted: boolean }>(`/v1/probes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  history: (id: string, sinceMs?: number) =>
    api<{ hostId: string; points: HistoryPoint[] }>(
      `/v1/probes/${encodeURIComponent(id)}/history` + (sinceMs ? `?since=${sinceMs}` : ''),
    ),
};

export interface Thresholds {
  cpu: number;
  mem: number;
  disk: number;
}
export interface ThresholdOverrides {
  cpu: number | null;
  mem: number | null;
  disk: number | null;
}

export const alertsApi = {
  get: () =>
    api<{ defaults: Thresholds; overrides: ThresholdOverrides; effective: Thresholds }>('/v1/alerts'),
  put: (overrides: ThresholdOverrides) =>
    api<{ overrides: ThresholdOverrides; effective: Thresholds }>('/v1/alerts', {
      method: 'PUT',
      body: JSON.stringify(overrides),
    }),
};

export const devicesApi = {
  list: () => api<{ devices: Device[] }>('/v1/devices'),
  remove: (id: string) =>
    api<{ deleted: boolean }>(`/v1/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export const syncApi = {
  get: () => api<SyncInfo>('/v1/sync'),
};

// ── Live stream ─────────────────────────────────────────────────────────────

export type StreamStatus = 'connecting' | 'open' | 'closed';

interface StreamMessage {
  type: 'snapshot' | 'hello';
  hostId?: string;
  at?: number;
  snapshot?: ProbeSnapshot;
}

export function openStream(handlers: {
  onSnapshot: (hostId: string, at: number, snapshot: ProbeSnapshot) => void;
  onStatus: (status: StreamStatus) => void;
}): () => void {
  const token = getToken();
  if (!token) return () => undefined;
  const url =
    location.origin.replace(/^http/, 'ws') + '/v1/stream?token=' + encodeURIComponent(token);

  let closed = false;
  let ws: WebSocket | null = null;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    handlers.onStatus('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      handlers.onStatus('open');
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data)) as StreamMessage;
        if (m.type === 'snapshot' && m.hostId && m.snapshot) {
          handlers.onSnapshot(m.hostId, m.at ?? Date.now(), m.snapshot);
        }
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      handlers.onStatus('closed');
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(connect, Math.min(1000 * 2 ** retry, 30_000));
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return () => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

export const percent = (used: number, total: number) =>
  total > 0 ? Math.round((used / total) * 100) : 0;

export function formatKb(kb: number): string {
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = kb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function relativeTime(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
