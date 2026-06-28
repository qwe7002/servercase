import type {
  PortForwardInfo,
  PortForwardRequest,
  ServerConfig,
} from '../../electron/shared';
import { useServers } from '../store/servers';
import { connectServer } from './connect';

export type PortForwardOptions = Omit<PortForwardRequest, 'serverId'>;

/** Opens an SSH local port forward, connecting the server first if needed. */
export async function openSshPortForward(
  server: ServerConfig,
  options: PortForwardOptions,
): Promise<PortForwardInfo> {
  const api = window.servercase;
  if (!api) throw new Error('desktop bridge is unavailable');

  const state = useServers.getState().connState[server.id] ?? 'disconnected';
  if (state !== 'connected') await connectServer(server);

  return api.ports.open({
    ...options,
    serverId: server.id,
  });
}

export async function closeSshPortForward(forwardId: string): Promise<void> {
  const api = window.servercase;
  if (!api) throw new Error('desktop bridge is unavailable');
  await api.ports.close(forwardId);
}

export async function listSshPortForwards(
  serverId?: string,
): Promise<PortForwardInfo[]> {
  const api = window.servercase;
  if (!api) throw new Error('desktop bridge is unavailable');
  return api.ports.list(serverId);
}
