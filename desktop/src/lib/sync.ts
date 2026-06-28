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

/**
 * Builds the current secret-free snapshot of servers + settings. Shared by the
 * file export and the cloud push so both serialize identically. The Bitwarden
 * API key is a secret and is redacted here.
 */
export function buildSyncPayload(): SyncPayload {
  const settings = useSettings.getState().settings;
  return {
    version: 1,
    exportedAt: Date.now(),
    servers: useServers.getState().servers.map(withoutSecrets),
    settings: {
      ...settings,
      bitwarden: { ...settings.bitwarden, clientId: '', clientSecret: '' },
    },
  };
}

/** Replaces local servers + settings with a snapshot (from the cloud). */
export function applySyncPayload(payload: SyncPayload): void {
  useServers.getState().replaceServers(payload.servers);
  useSettings.getState().replaceSettings(payload.settings);
}
