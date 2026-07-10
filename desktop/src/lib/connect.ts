import type { ServerConfig } from '../../electron/shared';
import { mergeSecrets, useServers, vaultItemName } from '../store/servers';
import { useSettings } from '../store/settings';

/**
 * Establishes an SSH connection for a server, resolving its secrets from the
 * Bitwarden vault when the vault owns them. This is the single login path used
 * by both the dashboard and the control bridge — credentials never leave here.
 */
export async function connectServer(server: ServerConfig): Promise<void> {
  const api = window.servercase;
  if (!api) return;
  const setConnState = useServers.getState().setConnState;
  setConnState(server.id, 'connecting');
  try {
    let cfg = server;
    const vaultEnabled = useSettings.getState().settings.bitwarden.enabled;
    if (vaultEnabled && !server.password && !server.privateKey) {
      const secrets = await api.bw.get(vaultItemName(server), [server.id]);
      if (secrets) cfg = mergeSecrets(server, secrets);
    }
    await api.connect(cfg);
  } catch (e) {
    setConnState(server.id, 'error', (e as Error).message);
    throw e;
  }
}
