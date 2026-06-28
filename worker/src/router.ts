/**
 * A tiny method + path router with `:param` segments. Routes throw
 * {@link HttpError} for failures; the dispatcher turns those (and unexpected
 * errors) into JSON responses.
 */
import type { Env } from './env.ts';
import { HttpError, json, notFound } from './http.ts';

export interface Ctx {
  req: Request;
  env: Env;
  /** Worker execution context (for ctx.waitUntil on background work). */
  exec: ExecutionContext;
  /** Matched path parameters. */
  params: Record<string, string>;
  /** Parsed URL of the request. */
  url: URL;
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get = (p: string, h: Handler) => this.add('GET', p, h);
  post = (p: string, h: Handler) => this.add('POST', p, h);
  put = (p: string, h: Handler) => this.add('PUT', p, h);
  delete = (p: string, h: Handler) => this.add('DELETE', p, h);

  async handle(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.split('/').filter(Boolean);

    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, path);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      try {
        return await route.handler({ req, env, exec, params, url });
      } catch (err) {
        return errorResponse(err);
      }
    }

    // A known path with the wrong method gets 405; otherwise 404.
    if (pathMatched) return json({ error: 'method not allowed' }, 405);
    return errorResponse(notFound());
  }
}

function matchSegments(pattern: string[], path: string[]): Record<string, string> | null {
  if (pattern.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(path[i]);
    } else if (seg !== path[i]) {
      return null;
    }
  }
  return params;
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  console.error('unhandled error', err);
  return json({ error: 'internal error' }, 500);
}
