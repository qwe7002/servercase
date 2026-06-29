/**
 * Live probe-status stream from the worker's /v1/stream WebSocket. Browsers
 * can't set headers on a WebSocket, so the session token is passed as a query
 * param (the worker accepts it there). Reconnects with exponential backoff.
 */

/** A servercase.probe.v1 snapshot, as pushed by the worker. */
export interface ProbeSnapshotV1 {
  schema: string;
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
  disks: { mount: string; fs: string; used_kb: number; total_kb: number }[];
  network: {
    rx_bytes_per_sec: number | null;
    tx_bytes_per_sec: number | null;
    interfaces?: { name: string; ipv4: string[]; ipv6: string[] }[];
    public_ipv4: string | null;
    public_ipv6?: string | null;
  };
  security_updates?: {
    available: boolean | null;
    count: number | null;
    source: string;
    checked_at_ms: number;
  } | null;
}

type StreamEvent =
  | { type: 'hello'; at: number }
  | { type: 'snapshot'; hostId: string; at: number; snapshot: ProbeSnapshotV1 };

export type StreamStatus = 'connecting' | 'open' | 'closed';

export interface StreamHandlers {
  onSnapshot: (hostId: string, snapshot: ProbeSnapshotV1) => void;
  onStatus?: (status: StreamStatus) => void;
}

export interface StreamController {
  close: () => void;
}

export function openProbeStream(
  baseUrl: string,
  token: string,
  handlers: StreamHandlers,
): StreamController {
  const wsUrl =
    baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') +
    '/v1/stream?token=' +
    encodeURIComponent(token);

  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    handlers.onStatus?.('connecting');
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      retry = 0;
      handlers.onStatus?.('open');
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as StreamEvent;
        if (msg.type === 'snapshot') handlers.onSnapshot(msg.hostId, msg.snapshot);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      handlers.onStatus?.('closed');
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(connect, Math.min(1000 * 2 ** retry, 30_000));
    };
    ws.onerror = () => ws?.close();
  };

  connect();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
