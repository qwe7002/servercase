/** Identifier and token generation, plus the hashing used to store tokens. */

/** A URL-safe, collision-resistant id (used for users, hosts, devices). */
export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Base64url of random bytes, no padding. */
function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

/**
 * A probe bearer token, shown to the user once. Prefixed so it is recognisable
 * in logs/config; the secret part is 32 random bytes.
 */
export function newProbeToken(): string {
  return `scp_${randomBase64Url(24)}`;
}

/** SHA-256 of a token, hex-encoded — what we actually persist. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Constant-time string comparison for secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
