/**
 * Push notifications over Firebase Cloud Messaging.
 *
 * On every probe ingest, `dispatchAlerts` evaluates threshold rules
 * (see ./alerts.ts), and on a transition (a metric crossing its threshold, or
 * recovering) sends a push to the owning user's registered FCM devices
 * (see ./fcm.ts). Tokens FCM rejects as dead are pruned.
 *
 * Push is enabled only when FCM_SERVICE_ACCOUNT is configured; otherwise this
 * is a no-op. Clients register/unregister their tokens via /v1/devices.
 */
import { and, eq } from 'drizzle-orm';
import type { Env } from '../env.ts';
import type { ProbeSnapshot } from '../shared.ts';
import { getDb } from '../db/client.ts';
import { probeHosts, pushDevices } from '../db/schema.ts';
import { buildMessages, currentBreaches, sameSet, thresholdsFromEnv } from './alerts.ts';
import { FcmNotifier, FcmTokenError, fcmConfigFromEnv } from './fcm.ts';

export type PushPlatform = 'apns' | 'fcm' | 'webpush';

export interface PushDevice {
  id: string;
  platform: PushPlatform;
  token: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Opaque routing data delivered to the client (e.g. { hostId }). */
  data?: Record<string, string>;
}

/** A transport that delivers a message to one device. */
export interface Notifier {
  send(device: PushDevice, message: PushMessage): Promise<void>;
}

/** The configured notifier, or null when push delivery is disabled. */
export function notifierFor(env: Env): Notifier | null {
  const fcm = fcmConfigFromEnv(env);
  return fcm ? new FcmNotifier(fcm) : null;
}

/**
 * Evaluate a freshly ingested snapshot and deliver any resulting alerts to the
 * user's FCM devices. No-ops when push is not configured.
 */
export async function dispatchAlerts(
  env: Env,
  userId: string,
  hostId: string,
  snapshot: ProbeSnapshot,
): Promise<void> {
  const notifier = notifierFor(env);
  if (!notifier) return; // push not configured

  const db = getDb(env);
  const host = await db
    .select({ name: probeHosts.name, alertState: probeHosts.alertState })
    .from(probeHosts)
    .where(eq(probeHosts.id, hostId))
    .get();
  if (!host) return;

  const thresholds = thresholdsFromEnv(env);
  const previous = parseBreaches(host.alertState);
  const current = currentBreaches(snapshot, thresholds);

  // Persist the new breach set only when it changes.
  if (!sameSet(previous, current)) {
    await db
      .update(probeHosts)
      .set({ alertState: JSON.stringify(current) })
      .where(eq(probeHosts.id, hostId));
  }

  const messages = buildMessages(host.name, hostId, snapshot, previous, current);
  if (messages.length === 0) return;

  const devices = await db
    .select({ id: pushDevices.id, token: pushDevices.token })
    .from(pushDevices)
    .where(and(eq(pushDevices.userId, userId), eq(pushDevices.platform, 'fcm')))
    .all();

  for (const device of devices) {
    for (const message of messages) {
      try {
        await notifier.send({ id: device.id, platform: 'fcm', token: device.token }, message);
      } catch (err) {
        if (err instanceof FcmTokenError) {
          await db.delete(pushDevices).where(eq(pushDevices.id, device.id));
          break; // token is dead; skip its remaining messages
        }
        console.error('push send failed', err);
      }
    }
  }
}

function parseBreaches(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as string[]) : [];
  } catch {
    return [];
  }
}
