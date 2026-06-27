/**
 * Fan-out of freshly ingested snapshots to a user's live subscribers. The
 * snapshot was stored against a host; we route by the host's owner to that
 * user's {@link UserHub} Durable Object, which broadcasts to every connected
 * client WebSocket (see routes/stream.ts).
 */
import type { Env } from './env.ts';
import type { ProbeSnapshot } from './shared.ts';

/** A message pushed to subscribers over the /v1/stream WebSocket. */
export interface StreamMessage {
  type: 'snapshot';
  hostId: string;
  /** Epoch ms the worker received it. */
  at: number;
  snapshot: ProbeSnapshot;
}

export async function publishSnapshot(
  env: Env,
  userId: string,
  hostId: string,
  snapshot: ProbeSnapshot,
): Promise<void> {
  const message: StreamMessage = { type: 'snapshot', hostId, at: Date.now(), snapshot };
  const stub = env.USER_HUB.get(env.USER_HUB.idFromName(userId));
  // The hub's internal publish endpoint just broadcasts the body verbatim.
  await stub.fetch('https://hub/publish', {
    method: 'POST',
    body: JSON.stringify(message),
  });
}
