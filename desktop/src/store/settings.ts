import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  BitwardenSettings,
  CloudSettings,
  GlobalSettings,
  Snippet,
  TerminalSettings,
} from '../../electron/shared';

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const DEFAULTS: GlobalSettings = {
  bitwarden: {
    enabled: false,
    authMode: 'password',
    serverUrl: '',
    email: '',
    clientId: '',
    clientSecret: '',
    itemPrefix: 'ServerCase/',
  },
  snippets: [],
  bridge: {
    enabled: false,
    port: 8765,
  },
  cloud: {
    enabled: false,
    url: '',
    email: '',
    autoPush: false,
  },
  terminal: {
    fontSize: 13,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 1000,
    colorScheme: 'charcoal',
  },
  groups: [],
};

interface SettingsState {
  settings: GlobalSettings;

  setBitwarden: (patch: Partial<BitwardenSettings>) => void;
  setBridge: (patch: Partial<GlobalSettings['bridge']>) => void;
  setCloud: (patch: Partial<CloudSettings>) => void;
  setTerminal: (patch: Partial<TerminalSettings>) => void;

  addSnippet: (s: Omit<Snippet, 'id'>) => void;
  updateSnippet: (s: Snippet) => void;
  removeSnippet: (id: string) => void;

  addGroup: (name: string) => string;
  renameGroup: (id: string, name: string) => void;
  removeGroup: (id: string) => void;

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
      setBridge: (patch) =>
        set((s) => ({
          settings: {
            ...s.settings,
            bridge: { ...s.settings.bridge, ...patch },
          },
        })),
      setCloud: (patch) =>
        set((s) => ({
          settings: {
            ...s.settings,
            cloud: { ...s.settings.cloud, ...patch },
          },
        })),
      setTerminal: (patch) =>
        set((s) => ({
          settings: {
            ...s.settings,
            terminal: { ...s.settings.terminal, ...patch },
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

      addGroup: (name) => {
        const id = uid();
        set((s) => ({
          settings: { ...s.settings, groups: [...s.settings.groups, { id, name }] },
        }));
        return id;
      },
      renameGroup: (id, name) =>
        set((s) => ({
          settings: {
            ...s.settings,
            groups: s.settings.groups.map((g) => (g.id === id ? { ...g, name } : g)),
          },
        })),
      removeGroup: (id) =>
        set((s) => ({
          settings: {
            ...s.settings,
            groups: s.settings.groups.filter((g) => g.id !== id),
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
