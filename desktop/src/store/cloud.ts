import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Local-only cloud session: the worker session token and the last-synced
 * revision. This is deliberately separate from {@link useSettings} so the token
 * is **never** part of the secret-free SyncPayload — it stays on this device,
 * like an SSH password without Bitwarden.
 */
export interface CloudUser {
  id: string;
  email: string;
}

interface CloudSessionState {
  token: string | null;
  /** Epoch ms when the token expires. */
  expiresAt: number | null;
  user: CloudUser | null;
  /** Last cloud sync revision, for optimistic-locking the next push. */
  syncVersion: number | null;
  /** Epoch ms of the last successful push/pull. */
  syncedAt: number | null;

  setSession: (s: { token: string; expiresAt: number; user: CloudUser }) => void;
  setSync: (v: { syncVersion: number; syncedAt: number }) => void;
  clear: () => void;
}

export const useCloud = create<CloudSessionState>()(
  persist(
    (set) => ({
      token: null,
      expiresAt: null,
      user: null,
      syncVersion: null,
      syncedAt: null,

      setSession: ({ token, expiresAt, user }) => set({ token, expiresAt, user }),
      setSync: ({ syncVersion, syncedAt }) => set({ syncVersion, syncedAt }),
      clear: () =>
        set({
          token: null,
          expiresAt: null,
          user: null,
          syncVersion: null,
          syncedAt: null,
        }),
    }),
    { name: 'servercase.cloud' },
  ),
);

/** True if we hold an unexpired session token. */
export function hasValidSession(s: Pick<CloudSessionState, 'token' | 'expiresAt'>): boolean {
  return !!s.token && (!s.expiresAt || s.expiresAt > Date.now());
}
