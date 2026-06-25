import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  ConnectionState,
  ServerConfig,
  ServerSecrets,
  ServerStatus,
} from '../../electron/shared';
import { useSettings } from './settings';

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function vaultEnabled(): boolean {
  return useSettings.getState().settings.bitwarden.enabled;
}

function secretsOf(cfg: ServerConfig): ServerSecrets {
  return {
    username: cfg.username,
    password: cfg.password,
    privateKey: cfg.privateKey,
    passphrase: cfg.passphrase,
  };
}

/** Drops sensitive fields so they are never written to local storage. */
function stripSecrets(cfg: ServerConfig): ServerConfig {
  return {
    ...cfg,
    password: undefined,
    privateKey: undefined,
    passphrase: undefined,
  };
}

/** Mirrors a server's secrets into the Bitwarden vault (best effort). */
function pushSecret(cfg: ServerConfig): void {
  void window.servercase?.bw.set(cfg.id, secretsOf(cfg)).catch(() => undefined);
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

  /** Force a re-persist (used after the keychain mode changes). */
  repersist: () => void;
  /** Pull secrets from the unlocked Bitwarden vault into memory. */
  loadSecretsFromVault: () => Promise<void>;
  /** Push every server's secrets into the Bitwarden vault. */
  pushAllSecretsToVault: () => Promise<void>;
  /** Replace the whole server list (used when importing a sync file). */
  replaceServers: (servers: ServerConfig[]) => void;
}

export const useServers = create<ServersState>()(
  persist(
    (set, get) => ({
      servers: [],
      selectedId: null,
      connState: {},
      status: {},
      lastError: {},

      addServer: (cfg) => {
        const id = uid();
        const full = { ...cfg, id };
        set((s) => ({ servers: [...s.servers, full] }));
        if (vaultEnabled()) pushSecret(full);
        return id;
      },
      updateServer: (cfg) => {
        set((s) => ({
          servers: s.servers.map((x) => (x.id === cfg.id ? cfg : x)),
        }));
        if (vaultEnabled()) pushSecret(cfg);
      },
      removeServer: (id) => {
        set((s) => ({
          servers: s.servers.filter((x) => x.id !== id),
          selectedId: s.selectedId === id ? null : s.selectedId,
        }));
        if (vaultEnabled())
          void window.servercase?.bw.delete(id).catch(() => undefined);
      },
      select: (id) => set({ selectedId: id }),

      setConnState: (id, state, error) =>
        set((s) => ({
          connState: { ...s.connState, [id]: state },
          lastError: { ...s.lastError, [id]: error },
        })),
      setStatus: (id, status) =>
        set((s) => ({ status: { ...s.status, [id]: status } })),

      repersist: () => set((s) => ({ servers: [...s.servers] })),
      loadSecretsFromVault: async () => {
        const api = window.servercase;
        if (!api) return;
        const all = await api.bw.list();
        set((s) => ({
          servers: s.servers.map((sv) =>
            all[sv.id] ? { ...sv, ...all[sv.id] } : sv,
          ),
        }));
      },
      pushAllSecretsToVault: async () => {
        const api = window.servercase;
        if (!api) return;
        for (const sv of get().servers) {
          await api.bw.set(sv.id, secretsOf(sv));
        }
      },
      replaceServers: (servers) => set({ servers }),
    }),
    {
      name: 'servercase.servers',
      // Only persist the user's server definitions; runtime state is volatile.
      // When the Bitwarden vault is enabled, secrets live there instead of in
      // local storage, so strip them before persisting.
      partialize: (s) => ({
        servers: vaultEnabled() ? s.servers.map(stripSecrets) : s.servers,
      }),
    },
  ),
);
