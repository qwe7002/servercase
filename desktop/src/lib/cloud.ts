import type { SyncPayload } from '../../electron/shared';
import { useSettings } from '../store/settings';
import { useCloud, hasValidSession } from '../store/cloud';
import { buildSyncPayload, applySyncPayload } from './sync';

/** An error from the worker API, carrying the HTTP status for the UI. */
export class CloudError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CloudUser {
  id: string;
  email: string;
}

interface AuthResponse {
  user: CloudUser;
  token: string;
  expiresAt: number;
}

interface SyncResponse {
  version: number;
  updatedAt: number;
  payload: SyncPayload;
}

/** A probe host as returned by the worker, with its latest snapshot. */
export interface ProbeHost {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  latest: unknown | null;
}

interface CallOptions extends RequestInit {
  token?: string;
}

async function call<T>(baseUrl: string, path: string, opts: CallOptions = {}): Promise<T> {
  const url = baseUrl.replace(/\/+$/, '');
  if (!url) throw new CloudError(0, 'No worker URL configured');
  const { token, headers, ...rest } = opts;

  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
  } catch (e) {
    throw new CloudError(0, `Cannot reach ${url}: ${(e as Error).message}`);
  }

  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new CloudError(res.status, (data.error as string) ?? res.statusText);
  }
  return data as T;
}

/** Thin wrappers over the worker REST API. */
export const cloudApi = {
  register: (url: string, email: string, password: string) =>
    call<AuthResponse>(url, '/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  login: (url: string, email: string, password: string) =>
    call<AuthResponse>(url, '/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  getSync: (url: string, token: string) =>
    call<SyncResponse>(url, '/v1/sync', { token }),
  putSync: (url: string, token: string, payload: SyncPayload, baseVersion?: number) =>
    call<{ version: number; updatedAt: number }>(url, '/v1/sync', {
      method: 'PUT',
      token,
      body: JSON.stringify({ payload, baseVersion }),
    }),
  listProbes: (url: string, token: string) =>
    call<{ hosts: ProbeHost[] }>(url, '/v1/probes', { token }),
  createProbe: (url: string, token: string, name: string) =>
    call<{ host: { id: string; name: string }; token: string }>(url, '/v1/probes', {
      method: 'POST',
      token,
      body: JSON.stringify({ name }),
    }),
  deleteProbe: (url: string, token: string, id: string) =>
    call<{ deleted: boolean }>(url, `/v1/probes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      token,
    }),
};

// ── High-level actions bound to the stores ──────────────────────────────────

/** Reads the configured URL and a known-valid token, or throws a clear error. */
function session(): { url: string; token: string } {
  const url = useSettings.getState().settings.cloud.url;
  const state = useCloud.getState();
  if (!url) throw new CloudError(0, 'Set the worker URL first');
  if (!hasValidSession(state) || !state.token) {
    throw new CloudError(401, 'Sign in to ServerCase Cloud first');
  }
  return { url, token: state.token };
}

/** Logs in (or registers) and stores the session locally. */
export async function cloudAuth(
  mode: 'login' | 'register',
  email: string,
  password: string,
): Promise<CloudUser> {
  const url = useSettings.getState().settings.cloud.url;
  const res = await (mode === 'register'
    ? cloudApi.register(url, email, password)
    : cloudApi.login(url, email, password));
  useCloud.getState().setSession(res);
  useSettings.getState().setCloud({ email: res.user.email });
  return res.user;
}

/** Pushes the local config to the cloud. Returns the new revision. */
export async function cloudPush(): Promise<number> {
  const { url, token } = session();
  const baseVersion = useCloud.getState().syncVersion ?? undefined;
  const res = await cloudApi.putSync(url, token, buildSyncPayload(), baseVersion);
  useCloud.getState().setSync({ syncVersion: res.version, syncedAt: res.updatedAt });
  return res.version;
}

/** Pulls the cloud config and replaces local servers + settings. */
export async function cloudPull(): Promise<void> {
  const { url, token } = session();
  const res = await cloudApi.getSync(url, token);
  applySyncPayload(res.payload);
  useCloud.getState().setSync({ syncVersion: res.version, syncedAt: res.updatedAt });
}
