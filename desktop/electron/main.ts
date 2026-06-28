import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { SshManager } from './ssh/sshManager.js';
import { BitwardenVault } from './bitwarden.js';
import { Bridge } from './bridge.js';
import {
  IpcChannels,
  type BitwardenSettings,
  type BridgeServerEntry,
  type PortForwardRequest,
  type ServerConfig,
  type ServerSecrets,
} from './shared.js';

let win: BrowserWindow | null = null;

function send(channel: string, ...args: unknown[]): void {
  win?.webContents.send(channel, ...args);
}

const ssh = new SshManager(
  (serverId, state, error) =>
    send(IpcChannels.connectionEvent, { serverId, state, error }),
  (serverId, shellId, data) =>
    send(IpcChannels.shellOutput, serverId, shellId, data),
  (serverId, shellId) => send(IpcChannels.shellClosed, serverId, shellId),
);

const bitwarden = new BitwardenVault();

const bridge = new Bridge(ssh, (serverId) =>
  send(IpcChannels.bridgeConnectRequest, serverId),
);

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ServerCase',
    icon: path.join(app.getAppPath(), 'assets/icon.png'),
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(app.getAppPath(), 'dist/index.html'));
  }

  win.on('closed', () => {
    win = null;
  });
}

function registerIpc(): void {
  ipcMain.handle(IpcChannels.connect, (_e, cfg: ServerConfig) =>
    ssh.connect(cfg),
  );
  ipcMain.handle(IpcChannels.disconnect, (_e, serverId: string) =>
    ssh.disconnect(serverId),
  );
  ipcMain.handle(IpcChannels.fetchStatus, (_e, serverId: string) =>
    ssh.fetchStatus(serverId),
  );
  ipcMain.handle(
    IpcChannels.runCommand,
    (_e, serverId: string, command: string) => ssh.execCommand(serverId, command),
  );
  ipcMain.handle(
    IpcChannels.portForwardOpen,
    (_e, request: PortForwardRequest) => ssh.openPortForward(request),
  );
  ipcMain.handle(IpcChannels.portForwardClose, (_e, forwardId: string) =>
    ssh.closePortForward(forwardId),
  );
  ipcMain.handle(IpcChannels.portForwardList, (_e, serverId?: string) =>
    ssh.listPortForwards(serverId),
  );
  ipcMain.handle(
    IpcChannels.shellOpen,
    (_e, serverId: string, shellId: string, cols: number, rows: number) =>
      ssh.openShell(serverId, shellId, cols, rows),
  );
  ipcMain.on(
    IpcChannels.shellData,
    (_e, serverId: string, shellId: string, data: string) =>
      ssh.writeShell(serverId, shellId, data),
  );
  ipcMain.on(
    IpcChannels.shellResize,
    (_e, serverId: string, shellId: string, cols: number, rows: number) =>
      ssh.resizeShell(serverId, shellId, cols, rows),
  );
  ipcMain.on(IpcChannels.shellClose, (_e, serverId: string, shellId: string) =>
    ssh.closeShell(serverId, shellId),
  );

  // ── Bitwarden secret vault ────────────────────────────────────────────────
  ipcMain.handle(IpcChannels.bwConfigure, (_e, settings: BitwardenSettings) => {
    bitwarden.configure(settings);
  });
  ipcMain.handle(IpcChannels.bwStatus, () => bitwarden.status());
  ipcMain.handle(IpcChannels.bwUnlock, (_e, masterPassword: string) =>
    bitwarden.unlock(masterPassword),
  );
  ipcMain.handle(IpcChannels.bwLock, () => bitwarden.lock());
  ipcMain.handle(IpcChannels.bwSync, () => bitwarden.sync());
  ipcMain.handle(IpcChannels.bwTest, () => bitwarden.test());

  // ── Control bridge (for the MCP server) ───────────────────────────────────
  ipcMain.handle(IpcChannels.bridgeInfo, () => bridge.info());
  ipcMain.handle(
    IpcChannels.bridgeSetEnabled,
    (_e, enabled: boolean, port: number) => bridge.setEnabled(enabled, port),
  );
  ipcMain.handle(
    IpcChannels.bridgeRegister,
    (_e, entries: BridgeServerEntry[]) => bridge.setRegistry(entries),
  );
  ipcMain.handle(
    IpcChannels.bwSet,
    (_e, serverId: string, secrets: ServerSecrets) =>
      bitwarden.setSecrets(serverId, secrets),
  );
  ipcMain.handle(IpcChannels.bwGet, (_e, serverId: string) =>
    bitwarden.getSecrets(serverId),
  );
  ipcMain.handle(IpcChannels.bwList, () => bitwarden.listSecrets());
  ipcMain.handle(IpcChannels.bwDelete, (_e, serverId: string) =>
    bitwarden.deleteSecrets(serverId),
  );

  // ── SFTP ──────────────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannels.sftpList, (_e, serverId: string, dir: string) =>
    ssh.sftpList(serverId, dir),
  );
  ipcMain.handle(IpcChannels.sftpReadText, (_e, serverId: string, file: string) =>
    ssh.sftpReadText(serverId, file),
  );
  ipcMain.handle(
    IpcChannels.sftpWriteText,
    (_e, serverId: string, file: string, content: string) =>
      ssh.sftpWriteText(serverId, file, content),
  );
  ipcMain.handle(IpcChannels.sftpMkdir, (_e, serverId: string, dir: string) =>
    ssh.sftpMkdir(serverId, dir),
  );
  ipcMain.handle(
    IpcChannels.sftpRename,
    (_e, serverId: string, from: string, to: string) =>
      ssh.sftpRename(serverId, from, to),
  );
  ipcMain.handle(
    IpcChannels.sftpRemove,
    (_e, serverId: string, target: string, isDir: boolean) =>
      ssh.sftpRemove(serverId, target, isDir),
  );
  ipcMain.handle(
    IpcChannels.sftpDownload,
    async (_e, serverId: string, remote: string, suggestedName: string) => {
      if (!win) return false;
      const r = await dialog.showSaveDialog(win, {
        title: 'Download file',
        defaultPath: suggestedName,
      });
      if (r.canceled || !r.filePath) return false;
      await ssh.sftpFastGet(serverId, remote, r.filePath);
      return true;
    },
  );
  ipcMain.handle(
    IpcChannels.sftpUpload,
    async (_e, serverId: string, remoteDir: string) => {
      if (!win) return false;
      const r = await dialog.showOpenDialog(win, {
        title: 'Upload file',
        properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled || r.filePaths.length === 0) return false;
      for (const local of r.filePaths) {
        await ssh.sftpFastPut(serverId, local, remoteDir, path.basename(local));
      }
      return true;
    },
  );
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  ssh.dispose();
  void bridge.dispose();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ssh.dispose();
  void bridge.dispose();
});
