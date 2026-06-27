/**
 * Push-notification scaffolding (future-prep).
 *
 * The worker does not deliver notifications yet. This module defines the seam
 * where delivery will plug in, so the rest of the codebase can already call
 * `dispatchAlerts(...)` without caring how — or whether — anything is sent.
 *
 * What is already in place:
 *   - Clients register/unregister push tokens via /v1/devices (see routes).
 *   - On every probe ingest, `dispatchAlerts` is invoked with the snapshot.
 *
 * What is intentionally left for later:
 *   - APNs / FCM / Web Push transports (a {@link Notifier} implementation).
 *   - User-defined alert rules (thresholds, offline detection) persisted in D1.
 *   - Delivery receipts and token pruning on 410/Gone.
 */
import type { Env } from '../env.ts';
import type { ProbeSnapshot } from '../shared.ts';

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

/** The default transport: accepts and drops everything. Replace per platform. */
export class NoopNotifier implements Notifier {
  async send(): Promise<void> {
    // Delivery not implemented yet — see the module docstring.
  }
}

/** Resolves the notifier to use. Today always the no-op. */
export function notifierFor(_env: Env): Notifier {
  return new NoopNotifier();
}

/**
 * Evaluate a freshly ingested snapshot and deliver any resulting alerts.
 *
 * Placeholder: alert rules are not implemented, so this returns immediately.
 * The signature is the stable contract the ingest path already depends on, so
 * adding rules later is a change confined to this module.
 */
export async function dispatchAlerts(
  _env: Env,
  _userId: string,
  _hostId: string,
  _snapshot: ProbeSnapshot,
): Promise<void> {
  // no-op until alert rules + a real Notifier land.
}
