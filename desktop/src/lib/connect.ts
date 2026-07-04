import type { ServerConfig } from '../../electron/shared';
import { useServers } from '../store/servers';
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
      // Prefer a hand-picked vault item; fall back to ServerCase's own item
      // keyed by server id.
      const secrets = server.bitwardenItemId
        ? await api.bw.getById(server.bitwardenItemId)
        : await api.bw.get(server.id);
      if (secrets) cfg = { ...server, ...secrets };
    }
    await api.connect(cfg);
  } catch (e) {
    setConnState(server.id, 'error', (e as Error).message);
    throw e;
  }
}
