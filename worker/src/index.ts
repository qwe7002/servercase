/**
 * ServerCase Worker — the thin cloud side of ServerCase.
 *
 *   • Account login (email + password) so a user owns their data.
 *   • Config sync: pull/push the secret-free SyncPayload across devices.
 *   • Probe ingest: receive servercase.probe.v1 snapshots over per-host tokens.
 *   • Live stream: push those snapshots to a user's clients over a WebSocket.
 *   • Push: threshold alerts delivered to a user's devices over FCM.
 *
 * SSH credentials and the Bitwarden vault never reach here — secrets stay in
 * the ServerCase app (see the project README).
 */
import type { Env } from './env.ts';
import { json } from './http.ts';
import { preflight, withCors } from './cors.ts';
import { Router } from './router.ts';
import panelHtml from './panel.html';
import { login, me, register } from './routes/auth.ts';
import { getSync, putSync } from './routes/sync.ts';
import { createProbe, deleteProbe, listProbes, probeHistory } from './routes/probes.ts';
import { ingest, openProbeSocket } from './routes/ingest.ts';
import { openUserStream } from './routes/stream.ts';
import { deleteDevice, listDevices, registerDevice } from './routes/devices.ts';

export { ProbeSocket } from './probe_socket.ts';
export { UserHub } from './user_hub.ts';

const router = new Router();

// Management panel (a self-contained SPA served at the root) + health check.
router.get('/', () =>
  new Response(panelHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
);
router.get('/v1/health', () => json({ ok: true, now: Date.now() }));

// Accounts.
router.post('/v1/auth/register', register);
router.post('/v1/auth/login', login);
router.get('/v1/auth/me', me);

// Config sync.
router.get('/v1/sync', getSync);
router.put('/v1/sync', putSync);

// Live status stream (session-authenticated WebSocket).
router.get('/v1/stream', openUserStream);

// Probe hosts (user-authenticated management) + ingest (probe-token auth).
router.get('/v1/probes', listProbes);
router.post('/v1/probes', createProbe);
router.delete('/v1/probes/:id', deleteProbe);
router.get('/v1/probes/:id/history', probeHistory);
router.post('/v1/ingest', ingest);
router.get('/v1/ingest/ws', openProbeSocket);

// Push devices (future-prep).
router.get('/v1/devices', listDevices);
router.post('/v1/devices', registerDevice);
router.delete('/v1/devices/:id', deleteDevice);

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') return preflight();
    if (!env.SESSION_SECRET) {
      // Fail loud rather than signing sessions with an empty secret.
      return withCors(json({ error: 'worker misconfigured: SESSION_SECRET is not set' }, 500));
    }
    return withCors(await router.handle(req, env, exec));
  },
} satisfies ExportedHandler<Env>;
