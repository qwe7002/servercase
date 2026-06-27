/**
 * Minimal signed session tokens (compact JWT, HS256) over Web Crypto. We only
 * issue and verify our own tokens, so we keep the surface tiny: a fixed header,
 * an `exp` claim, and constant-time signature comparison.
 */
import { base64UrlDecode, base64UrlEncode, timingSafeEqual } from '../ids.ts';

const HEADER = base64UrlEncode(new TextEncoder().encode('{"alg":"HS256","typ":"JWT"}'));
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface SessionClaims {
  /** User id. */
  sub: string;
  email: string;
  /** Issued-at and expiry, epoch seconds. */
  iat: number;
  exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

export async function issueSession(
  userId: string,
  email: string,
  secret: string,
): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_SECONDS;
  const claims: SessionClaims = { sub: userId, email, iat, exp };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const data = `${HEADER}.${body}`;
  const signature = await sign(data, secret);
  return { token: `${data}.${signature}`, expiresAt: exp * 1000 };
}

/** Returns the claims if the token is well-formed, correctly signed and unexpired. */
export async function verifySession(token: string, secret: string): Promise<SessionClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const [, body, signature] = parts;
  const expected = await sign(`${HEADER}.${body}`, secret);
  if (!timingSafeEqual(signature, expected)) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch {
    return null;
  }
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
  if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
  return claims;
}
