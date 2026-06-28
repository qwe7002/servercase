/** Small JSON/HTTP helpers shared by every route. */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** An error that maps to an HTTP status; thrown by routes, caught by the router. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = 'unauthorized') => new HttpError(401, m);
export const forbidden = (m = 'forbidden') => new HttpError(403, m);
export const notFound = (m = 'not found') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

/** Parses a JSON request body, rejecting anything that is not a JSON object. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw badRequest('body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Extracts a bearer token from the Authorization header, if present. */
export function bearer(req: Request): string | undefined {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`"${key}" is required`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`"${key}" must be a string`);
  return value;
}
