import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannels,
  type ConnectionEvent,
  type ServerConfig,
  type ServerStatus,
} from './shared.js';

/** The typed API surface exposed to the renderer as `window.servercase`. */
const api = {
  connect: (cfg: ServerConfig): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.connect, cfg),
  disconnect: (serverId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.disconnect, serverId),
  fetchStatus: (serverId: string): Promise<ServerStatus> =>
    ipcRenderer.invoke(IpcChannels.fetchStatus, serverId),

  openShell: (
    serverId: string,
    shellId: string,
    cols: number,
    rows: number,
  ): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.shellOpen, serverId, shellId, cols, rows),
  sendShellData: (serverId: string, shellId: string, data: string): void =>
    ipcRenderer.send(IpcChannels.shellData, serverId, shellId, data),
  resizeShell: (
    serverId: string,
    shellId: string,
    cols: number,
    rows: number,
  ): void =>
    ipcRenderer.send(IpcChannels.shellResize, serverId, shellId, cols, rows),
  closeShell: (serverId: string, shellId: string): void =>
    ipcRenderer.send(IpcChannels.shellClose, serverId, shellId),

  onConnectionEvent: (cb: (e: ConnectionEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: ConnectionEvent) => cb(payload);
    ipcRenderer.on(IpcChannels.connectionEvent, handler);
    return () => ipcRenderer.off(IpcChannels.connectionEvent, handler);
  },
  onShellOutput: (
    cb: (serverId: string, shellId: string, data: string) => void,
  ): (() => void) => {
    const handler = (
      _e: unknown,
      serverId: string,
      shellId: string,
      data: string,
    ) => cb(serverId, shellId, data);
    ipcRenderer.on(IpcChannels.shellOutput, handler);
    return () => ipcRenderer.off(IpcChannels.shellOutput, handler);
  },
  onShellClosed: (
    cb: (serverId: string, shellId: string) => void,
  ): (() => void) => {
    const handler = (_e: unknown, serverId: string, shellId: string) =>
      cb(serverId, shellId);
    ipcRenderer.on(IpcChannels.shellClosed, handler);
    return () => ipcRenderer.off(IpcChannels.shellClosed, handler);
  },
};

export type ServerCaseApi = typeof api;

contextBridge.exposeInMainWorld('servercase', api);
