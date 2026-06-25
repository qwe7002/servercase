import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SshManager } from './ssh/sshManager.js';
import { IpcChannels, type ServerConfig } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ServerCase',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload (package "type":"module") requires the sandbox off; the
      // renderer stays isolated and without direct Node access.
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
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
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => ssh.dispose());
