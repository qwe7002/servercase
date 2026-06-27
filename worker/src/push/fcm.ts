/**
 * Firebase Cloud Messaging transport (HTTP v1 API).
 *
 * Auth uses the Firebase service account: we sign a short-lived RS256 JWT with
 * the account's private key (Web Crypto — no deps), exchange it for an OAuth2
 * access token (cached per isolate), and POST to the v1 `messages:send`
 * endpoint. A rejected token (UNREGISTERED) raises {@link FcmTokenError} so the
 * caller can prune it.
 */
import { base64UrlEncode } from '../ids.ts';
import type { Env } from '../env.ts';
import type { Notifier, PushDevice, PushMessage } from './index.ts';

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
}

/** Parses the FCM_SERVICE_ACCOUNT secret, or null when push is not configured. */
export function fcmConfigFromEnv(env: Env): FcmConfig | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as Record<string, string>;
    if (sa.project_id && sa.client_email && sa.private_key) {
      return {
        projectId: sa.project_id,
        clientEmail: sa.client_email,
        privateKeyPem: sa.private_key,
      };
    }
  } catch {
    // fall through
  }
  console.error('FCM_SERVICE_ACCOUNT is set but not valid service-account JSON');
  return null;
}

/** Raised when FCM reports a token is no longer deliverable, so it can be pruned. */
export class FcmTokenError extends Error {}

export class FcmNotifier implements Notifier {
  constructor(private readonly config: FcmConfig) {}

  async send(device: PushDevice, message: PushMessage): Promise<void> {
    const accessToken = await accessTokenFor(this.config);
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: device.token,
            notification: { title: message.title, body: message.body },
            ...(message.data ? { data: message.data } : {}),
          },
        }),
      },
    );
    if (res.ok) return;

    const text = await res.text();
    // A 404 or an UNREGISTERED/INVALID_ARGUMENT error means the token is dead.
    if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text)) {
      throw new FcmTokenError(`FCM rejected token: ${text}`);
    }
    throw new Error(`FCM send failed (${res.status}): ${text}`);
  }
}

// ── OAuth2 access token (service-account JWT), cached per isolate ────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessTokenFor(config: FcmConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.token;

  const header = base64UrlEncode(utf8('{"alg":"RS256","typ":"JWT"}'));
  const claims = base64UrlEncode(
    utf8(
      JSON.stringify({
        iss: config.clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const key = await importPkcs8(config.privateKeyPem);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(signingInput));
  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`FCM token exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: now + json.expires_in };
  return json.access_token;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const der = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(der), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    bytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}
