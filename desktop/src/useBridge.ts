import { useEffect } from 'react';
import { useServers } from './store/servers';
import { useSettings } from './store/settings';
import { connectServer } from './lib/connect';

/**
 * Wires the local control bridge: keeps it enabled per settings, registers the
 * (secret-free) server list with it, and fulfils connect requests from the MCP
 * server using ServerCase's own login path.
 */
export function useBridge(): void {
  const bridge = useSettings((s) => s.settings.bridge);
  const servers = useServers((s) => s.servers);

  useEffect(() => {
    void window.servercase?.bridge.setEnabled(bridge.enabled, bridge.port);
  }, [bridge.enabled, bridge.port]);

  useEffect(() => {
    void window.servercase?.bridge.register(
      servers.map((s) => ({ id: s.id, name: s.name, host: s.host })),
    );
  }, [servers]);

  useEffect(() => {
    const api = window.servercase;
    if (!api) return;
    return api.bridge.onConnectRequest((serverId) => {
      const server = useServers.getState().servers.find((s) => s.id === serverId);
      if (server) void connectServer(server).catch(() => undefined);
    });
  }, []);
}
