import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannels,
  type BitwardenFolder,
  type BitwardenSettings,
  type BitwardenStatus,
  type BridgeInfo,
  type BridgeServerEntry,
  type CommandResult,
  type ConnectionEvent,
  type BleSerialDeviceInfo,
  type PortForwardInfo,
  type PortForwardRequest,
  type SerialConnectionEvent,
  type SerialOpenOptions,
  type ServerConfig,
  type ServerSecrets,
  type ServerStatus,
  type SftpList,
  type WiredSerialPortInfo,
} from './shared.js';

/** The typed API surface exposed to the renderer as `window.servercase`. */
const api = {
  connect: (cfg: ServerConfig): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.connect, cfg),
  disconnect: (serverId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.disconnect, serverId),
  fetchStatus: (serverId: string): Promise<ServerStatus> =>
    ipcRenderer.invoke(IpcChannels.fetchStatus, serverId),
  runCommand: (serverId: string, command: string): Promise<CommandResult> =>
    ipcRenderer.invoke(IpcChannels.runCommand, serverId, command),

  ports: {
    open: (request: PortForwardRequest): Promise<PortForwardInfo> =>
      ipcRenderer.invoke(IpcChannels.portForwardOpen, request),
    close: (forwardId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.portForwardClose, forwardId),
    list: (serverId?: string): Promise<PortForwardInfo[]> =>
      ipcRenderer.invoke(IpcChannels.portForwardList, serverId),
  },

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

  serial: {
    listPorts: (): Promise<WiredSerialPortInfo[]> =>
      ipcRenderer.invoke(IpcChannels.serialListPorts),
    scanBle: (timeoutMs?: number): Promise<BleSerialDeviceInfo[]> =>
      ipcRenderer.invoke(IpcChannels.serialScanBle, timeoutMs),
    open: (sessionId: string, options: SerialOpenOptions): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.serialOpen, sessionId, options),
    write: (sessionId: string, data: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.serialWrite, sessionId, data),
    close: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.serialClose, sessionId),
    onData: (cb: (sessionId: string, data: string) => void): (() => void) => {
      const handler = (_e: unknown, sessionId: string, data: string) =>
        cb(sessionId, data);
      ipcRenderer.on(IpcChannels.serialData, handler);
      return () => ipcRenderer.off(IpcChannels.serialData, handler);
    },
    onEvent: (cb: (event: SerialConnectionEvent) => void): (() => void) => {
      const handler = (_e: unknown, payload: SerialConnectionEvent) => cb(payload);
      ipcRenderer.on(IpcChannels.serialEvent, handler);
      return () => ipcRenderer.off(IpcChannels.serialEvent, handler);
    },
  },

  // Bitwarden secret vault
  bw: {
    configure: (settings: BitwardenSettings): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.bwConfigure, settings),
    status: (): Promise<BitwardenStatus> =>
      ipcRenderer.invoke(IpcChannels.bwStatus),
    unlock: (masterPassword: string): Promise<BitwardenStatus> =>
      ipcRenderer.invoke(IpcChannels.bwUnlock, masterPassword),
    /** Attempts an auto-unlock with the OS-keychain-stored master password. */
    unlockStored: (): Promise<BitwardenStatus> =>
      ipcRenderer.invoke(IpcChannels.bwUnlockStored),
    lock: (): Promise<void> => ipcRenderer.invoke(IpcChannels.bwLock),
    sync: (): Promise<void> => ipcRenderer.invoke(IpcChannels.bwSync),
    test: (): Promise<string> => ipcRenderer.invoke(IpcChannels.bwTest),
    set: (
      itemName: string,
      secrets: ServerSecrets,
      aliases?: string[],
    ): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.bwSet, itemName, secrets, aliases),
    get: (itemName: string, aliases?: string[]): Promise<ServerSecrets | null> =>
      ipcRenderer.invoke(IpcChannels.bwGet, itemName, aliases),
    list: (): Promise<Record<string, ServerSecrets>> =>
      ipcRenderer.invoke(IpcChannels.bwList),
    delete: (itemName: string, aliases?: string[]): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.bwDelete, itemName, aliases),
    listFolders: (): Promise<BitwardenFolder[]> =>
      ipcRenderer.invoke(IpcChannels.bwListFolders),
    createFolder: (name: string): Promise<BitwardenFolder> =>
      ipcRenderer.invoke(IpcChannels.bwCreateFolder, name),
    deleteFolder: (folderId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.bwDeleteFolder, folderId),
  },

  // Control bridge (MCP)
  bridge: {
    info: (): Promise<BridgeInfo> => ipcRenderer.invoke(IpcChannels.bridgeInfo),
    setEnabled: (enabled: boolean, port: number): Promise<BridgeInfo> =>
      ipcRenderer.invoke(IpcChannels.bridgeSetEnabled, enabled, port),
    register: (entries: BridgeServerEntry[]): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.bridgeRegister, entries),
    onConnectRequest: (cb: (serverId: string) => void): (() => void) => {
      const handler = (_e: unknown, serverId: string) => cb(serverId);
      ipcRenderer.on(IpcChannels.bridgeConnectRequest, handler);
      return () => ipcRenderer.off(IpcChannels.bridgeConnectRequest, handler);
    },
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
