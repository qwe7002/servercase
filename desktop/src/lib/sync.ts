import type { ServerConfig, SyncPayload } from '../../electron/shared';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';

/** Secrets are never written to the sync file. */
function withoutSecrets(cfg: ServerConfig): ServerConfig {
  return {
    ...cfg,
    password: undefined,
    privateKey: undefined,
    passphrase: undefined,
  };
}

/** Writes the current (secret-free) config to the given sync file. */
export async function runExport(filePath: string): Promise<number> {
  const api = window.servercase;
  if (!api) throw new Error('bridge unavailable');
  const payload: SyncPayload = {
    version: 1,
    exportedAt: Date.now(),
    servers: useServers.getState().servers.map(withoutSecrets),
    settings: useSettings.getState().settings,
  };
  await api.sync.export(filePath, payload);
  useSettings.getState().setAutoSync({ lastSyncedAt: payload.exportedAt });
  return payload.exportedAt;
}

/** Loads a sync file and replaces the local servers + settings with it. */
export async function runImport(filePath: string): Promise<void> {
  const api = window.servercase;
  if (!api) throw new Error('bridge unavailable');
  const payload = await api.sync.import(filePath);
  useServers.getState().replaceServers(payload.servers);
  useSettings.getState().replaceSettings(payload.settings);
}
