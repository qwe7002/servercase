/**
 * ProbeSocket — a Durable Object that owns the streaming WebSocket for one
 * probe host. It uses the WebSocket Hibernation API so idle connections cost
 * nothing: the runtime answers pings for us and only wakes the object when a
 * snapshot frame actually arrives.
 *
 * Auth happens before we get here (see routes/ingest.ts#openProbeSocket); this
 * object trusts the X-Sc-Host-Id / X-Sc-User-Id headers on the forwarded
 * upgrade and stores them on the socket as a serialized attachment so they
 * survive hibernation.
 */
import type { Env } from './env.ts';
import { looksLikeProbeSnapshot } from './shared.ts';
import { storeSnapshot } from './probe_store.ts';
import { dispatchAlerts } from './push/index.ts';
import { publishSnapshot } from './publish.ts';

interface SocketAttachment {
  hostId: string;
  userId: string;
}

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

    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernatable accept: handlers below fire even after the object sleeps.
    this.state.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    // Answer client pings without waking the object.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );

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

    await storeSnapshot(this.env, hostId, body);
    await Promise.all([
      publishSnapshot(this.env, userId, hostId, body),
      dispatchAlerts(this.env, userId, hostId, body),
    ]);
    ws.send(JSON.stringify({ received: true, collectedAt: body.collected_at_ms }));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // 1006 is reserved and cannot be sent back; fall back to a normal close.
    try {
      ws.close(code === 1006 ? 1000 : code, 'bye');
    } catch {
      // already closed
    }
  }

  async webSocketError(): Promise<void> {
    // Nothing to clean up — D1 holds all state; the client will reconnect.
  }
}
