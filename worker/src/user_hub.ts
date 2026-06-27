/**
 * UserHub — a Durable Object, one per user, that fans live probe updates out to
 * that user's connected clients. Subscribers connect a WebSocket (routed here
 * from GET /v1/stream after session auth); the ingest paths POST snapshots to
 * the internal /publish endpoint, which broadcasts to every socket.
 *
 * Hibernation keeps idle dashboards free, and pings are auto-answered.
 */
import type { Env } from './env.ts';

export class UserHub implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {
    void _env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Internal: broadcast a message body to all subscribers.
    if (url.pathname === '/publish') {
      const body = await req.text();
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(body);
        } catch {
          // socket is going away; it will be cleaned up on close
        }
      }
      return new Response(null, { status: 204 });
    }

    // Subscriber WebSocket upgrade.
    if ((req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    server.send(JSON.stringify({ type: 'hello', at: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Subscribers are read-only; we ignore anything they send.
  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1006 ? 1000 : code, 'bye');
    } catch {
      // already closed
    }
  }

  async webSocketError(): Promise<void> {}
}
