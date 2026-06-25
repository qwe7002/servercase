import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  ConnectionState,
  ServerConfig,
  ServerStatus,
} from '../../electron/shared';

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

interface ServersState {
  servers: ServerConfig[];
  selectedId: string | null;
  // Live, non-persisted runtime maps keyed by server id.
  connState: Record<string, ConnectionState>;
  status: Record<string, ServerStatus>;
  lastError: Record<string, string | undefined>;

  addServer: (cfg: Omit<ServerConfig, 'id'>) => string;
  updateServer: (cfg: ServerConfig) => void;
  removeServer: (id: string) => void;
  select: (id: string | null) => void;

  setConnState: (id: string, state: ConnectionState, error?: string) => void;
  setStatus: (id: string, status: ServerStatus) => void;
}

export const useServers = create<ServersState>()(
  persist(
    (set) => ({
      servers: [],
      selectedId: null,
      connState: {},
      status: {},
      lastError: {},

      addServer: (cfg) => {
        const id = uid();
        set((s) => ({ servers: [...s.servers, { ...cfg, id }] }));
        return id;
      },
      updateServer: (cfg) =>
        set((s) => ({
          servers: s.servers.map((x) => (x.id === cfg.id ? cfg : x)),
        })),
      removeServer: (id) =>
        set((s) => ({
          servers: s.servers.filter((x) => x.id !== id),
          selectedId: s.selectedId === id ? null : s.selectedId,
        })),
      select: (id) => set({ selectedId: id }),

      setConnState: (id, state, error) =>
        set((s) => ({
          connState: { ...s.connState, [id]: state },
          lastError: { ...s.lastError, [id]: error },
        })),
      setStatus: (id, status) =>
        set((s) => ({ status: { ...s.status, [id]: status } })),
    }),
    {
      name: 'servercase.servers',
      // Only persist the user's server definitions; runtime state is volatile.
      partialize: (s) => ({ servers: s.servers }),
    },
  ),
);
