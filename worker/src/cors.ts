/**
 * CORS for the API. The worker is a public, token-authenticated API (bearer
 * tokens in the Authorization header, never cookies), so a wildcard origin is
 * safe — there is no ambient credential a malicious page could ride on.
 *
 * This lets the Electron renderer and a future browser panel call the API
 * directly. WebSocket upgrades are not subject to CORS, so they are unaffected.
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-max-age': '86400',
};

/** Preflight response for OPTIONS requests. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Returns a copy of `res` with CORS headers attached. */
export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  // A 101 Switching Protocols response (WebSocket) must be returned as-is.
  if (res.status === 101) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
