/**
 * ProbeSocket — a Durable Object that owns the streaming WebSocket for one
 * probe host, using the WebSocket Hibernation API.
 *
 * To keep D1 writes low, samples are NOT written on every frame. Each sample is
 * buffered in the object's own storage (which survives hibernation) and an
 * alarm flushes the buffer to D1 once per `PROBE_FLUSH_SECONDS` (default 60) as
 * a single batch: one `latest` update, one multi-row history insert, one trim.
 * Real-time fan-out and alert evaluation still run on every frame (no D1
 * writes), so the live panel and push alerts stay instant.
 *
 * Auth happens before we get here (see routes/ingest.ts#openProbeSocket); this
 * object trusts the X-Sc-Host-Id / X-Sc-User-Id headers on the forwarded
 * upgrade.
 */
import type { Env } from './env.ts';
import { probeFlushSeconds } from './env.ts';
import { looksLikeProbeSnapshot } from './shared.ts';
import { persistBatch, type BufferedSample } from './probe_store.ts';
import { dispatchAlerts } from './push/index.ts';
import { publishSnapshot } from './publish.ts';

interface SocketAttachment {
  hostId: string;
  userId: string;
}

const SAMPLE_PREFIX = 's:';

export class ProbeSocket implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    if ((req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }

    const attachment: SocketAttachment = {
      hostId: req.headers.get('X-Sc-Host-Id') ?? '',
      userId: req.headers.get('X-Sc-User-Id') ?? '',
    };
    // Persist identity so the alarm (which has no socket) can flush.
    await this.state.storage.put('meta', attachment);

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const { hostId, userId } = ws.deserializeAttachment() as SocketAttachment;
    const text = (typeof message === 'string' ? message : new TextDecoder().decode(message)).trim();
    if (!text) return; // keep-alive / blank line

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      ws.send(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    if (!looksLikeProbeSnapshot(body)) {
      ws.send(JSON.stringify({ error: 'expected a servercase.probe.v1 snapshot' }));
      return;
    }

    // Buffer the sample for the next flush (no D1 write here).
    const memTotal = body.memory.mem_total_kb;
    const sample: BufferedSample = {
      collectedAt: body.collected_at_ms,
      cpuUsage: body.cpu_usage,
      memPct: memTotal > 0 ? (body.memory.mem_used_kb / memTotal) * 100 : null,
      raw: JSON.stringify(body),
    };
    await this.state.storage.put(SAMPLE_PREFIX + body.collected_at_ms, sample);

    // Real-time, no D1 writes: live fan-out + alert evaluation.
    await Promise.all([
      publishSnapshot(this.env, userId, hostId, body),
      dispatchAlerts(this.env, userId, hostId, body),
    ]);

    // Arm a flush if one isn't already pending.
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + probeFlushSeconds(this.env) * 1000);
    }

    ws.send(JSON.stringify({ received: true, collectedAt: body.collected_at_ms }));
  }

  /** Flush buffered samples to D1 in one batch. */
  async alarm(): Promise<void> {
    const meta = await this.state.storage.get<SocketAttachment>('meta');
    const entries = await this.state.storage.list<BufferedSample>({ prefix: SAMPLE_PREFIX });
    if (!meta || entries.size === 0) return;

    try {
      await persistBatch(this.env, meta.hostId, [...entries.values()]);
      await this.state.storage.delete([...entries.keys()]);
    } catch (err) {
      // Keep the buffer and retry; don't lose samples on a transient D1 error.
      console.error('probe flush failed; will retry', err);
      await this.state.storage.setAlarm(Date.now() + probeFlushSeconds(this.env) * 1000);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Flush whatever is buffered promptly instead of waiting for the interval.
    await this.state.storage.setAlarm(Date.now());
    try {
      ws.close(code === 1006 ? 1000 : code, 'bye');
    } catch {
      // already closed
    }
  }

  async webSocketError(): Promise<void> {
    // Nothing to clean up — buffered samples flush via the pending alarm.
  }
}
