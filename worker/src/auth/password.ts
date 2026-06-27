/**
 * Password hashing with PBKDF2-SHA256 over the Web Crypto API (available in the
 * Workers runtime — no native or npm crypto needed). Encoded as a single
 * self-describing string so the iteration count can be raised over time:
 *
 *   pbkdf2$<iterations>$<saltBase64Url>$<hashBase64Url>
 */
import { base64UrlDecode, base64UrlEncode, timingSafeEqual } from '../ids.ts';

// Cloudflare Workers' Web Crypto PBKDF2 implementation caps iterations at 100k.
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = base64UrlDecode(parts[2]);
  const expected = parts[3];
  const actual = base64UrlEncode(await derive(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}
