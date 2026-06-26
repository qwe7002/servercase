import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannels,
  type BitwardenSettings,
  type BitwardenStatus,
  type ConnectionEvent,
  type ServerConfig,
  type ServerSecrets,
  type ServerStatus,
  type SftpList,
  type SyncPayload,
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

  // Bitwarden secret vault
  bw: {
    configure: (settings: BitwardenSettings): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.bwConfigure, settings),
    status: (): Promise<BitwardenStatus> =>
      ipcRenderer.invoke(IpcChannels.bwStatus),
    unlock: (masterPassword: string): Promise<BitwardenStatus> =>
      ipcRenderer.invoke(IpcChannels.bwUnlock, masterPassword),
    lock: (): Promise<void> => ipcRenderer.invoke(IpcChannels.bwLock),
    sync: (): Promise<void> => ipcRenderer.invoke(IpcChannels.bwSync),
    test: (): Promise<string> => ipcRenderer.invoke(IpcChannels.bwTest),
    set: (serverId: string, secrets: ServerSecrets): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.bwSet, serverId, secrets),
    get: (serverId: string): Promise<ServerSecrets | null> =>
      ipcRenderer.invoke(IpcChannels.bwGet, serverId),
    list: (): Promise<Record<string, ServerSecrets>> =>
      ipcRenderer.invoke(IpcChannels.bwList),
    delete: (serverId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.bwDelete, serverId),
  },

  // Config sync (JSON file)
  sync: {
    pickFile: (mode: 'open' | 'save'): Promise<string | null> =>
      ipcRenderer.invoke(IpcChannels.syncPickFile, mode),
    export: (filePath: string, payload: SyncPayload): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.syncExport, filePath, payload),
    import: (filePath: string): Promise<SyncPayload> =>
      ipcRenderer.invoke(IpcChannels.syncImport, filePath),
  },

  // SFTP file management
  sftp: {
    list: (serverId: string, dir: string): Promise<SftpList> =>
      ipcRenderer.invoke(IpcChannels.sftpList, serverId, dir),
    readText: (serverId: string, file: string): Promise<string> =>
      ipcRenderer.invoke(IpcChannels.sftpReadText, serverId, file),
    writeText: (serverId: string, file: string, content: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.sftpWriteText, serverId, file, content),
    mkdir: (serverId: string, dir: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.sftpMkdir, serverId, dir),
    rename: (serverId: string, from: string, to: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.sftpRename, serverId, from, to),
    remove: (serverId: string, target: string, isDir: boolean): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.sftpRemove, serverId, target, isDir),
    download: (
      serverId: string,
      remote: string,
      suggestedName: string,
    ): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.sftpDownload, serverId, remote, suggestedName),
    upload: (serverId: string, remoteDir: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.sftpUpload, serverId, remoteDir),
  },

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
