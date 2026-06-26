import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AutoSyncSettings,
  BitwardenSettings,
  GlobalSettings,
  Snippet,
} from '../../electron/shared';

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const DEFAULTS: GlobalSettings = {
  bitwarden: {
    enabled: false,
    serverUrl: '',
    email: '',
    clientId: '',
    clientSecret: '',
    itemPrefix: 'ServerCase/',
  },
  snippets: [],
  autoSync: {
    enabled: false,
    intervalMinutes: 30,
    filePath: '',
  },
  bridge: {
    enabled: false,
    port: 8765,
  },
};

interface SettingsState {
  settings: GlobalSettings;

  setBitwarden: (patch: Partial<BitwardenSettings>) => void;
  setAutoSync: (patch: Partial<AutoSyncSettings>) => void;
  setBridge: (patch: Partial<GlobalSettings['bridge']>) => void;

  addSnippet: (s: Omit<Snippet, 'id'>) => void;
  updateSnippet: (s: Snippet) => void;
  removeSnippet: (id: string) => void;

  /** Replace the whole settings object (used when importing a sync file). */
  replaceSettings: (s: GlobalSettings) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULTS,

      setBitwarden: (patch) =>
        set((s) => ({
          settings: {
            ...s.settings,
            bitwarden: { ...s.settings.bitwarden, ...patch },
          },
        })),
      setAutoSync: (patch) =>
        set((s) => ({
          settings: {
            ...s.settings,
            autoSync: { ...s.settings.autoSync, ...patch },
          },
        })),
      setBridge: (patch) =>
        set((s) => ({
          settings: {
            ...s.settings,
            bridge: { ...s.settings.bridge, ...patch },
          },
        })),

      addSnippet: (snippet) =>
        set((s) => ({
          settings: {
            ...s.settings,
            snippets: [...s.settings.snippets, { ...snippet, id: uid() }],
          },
        })),
      updateSnippet: (snippet) =>
        set((s) => ({
          settings: {
            ...s.settings,
            snippets: s.settings.snippets.map((x) =>
              x.id === snippet.id ? snippet : x,
            ),
          },
        })),
      removeSnippet: (id) =>
        set((s) => ({
          settings: {
            ...s.settings,
            snippets: s.settings.snippets.filter((x) => x.id !== id),
          },
        })),

      replaceSettings: (next) => set({ settings: next }),
    }),
    {
      name: 'servercase.settings',
      // Merge persisted settings over defaults so new fields get sane values.
      merge: (persisted, current) => {
        const p = persisted as Partial<SettingsState> | undefined;
        return {
          ...current,
          settings: { ...DEFAULTS, ...(p?.settings ?? {}) },
        };
      },
    },
  ),
);
