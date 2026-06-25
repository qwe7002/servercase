import { Client, type ClientChannel } from 'ssh2';
import type { ServerConfig, ServerStatus } from '../shared.js';
import {
  STATUS_COMMAND,
  parseStatus,
  type CollectorState,
} from './statusCollector.js';

interface Connection {
  client: Client;
  collector: CollectorState;
  shells: Map<string, ClientChannel>;
}

export type ConnectionStateListener = (
  serverId: string,
  state: 'connected' | 'disconnected' | 'error',
  error?: string,
) => void;

export type ShellOutputListener = (
  serverId: string,
  shellId: string,
  data: string,
) => void;

export type ShellClosedListener = (serverId: string, shellId: string) => void;

/**
 * Owns all live SSH connections. One physical ssh2 Client per server; the
 * status poller uses `exec`, interactive terminals use `shell` channels.
 */
export class SshManager {
  private readonly conns = new Map<string, Connection>();

  constructor(
    private readonly onState: ConnectionStateListener,
    private readonly onShellOutput: ShellOutputListener,
    private readonly onShellClosed: ShellClosedListener,
  ) {}

  isConnected(serverId: string): boolean {
    return this.conns.has(serverId);
  }

  connect(cfg: ServerConfig): Promise<void> {
    if (this.conns.has(cfg.id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const client = new Client();
      client
        .on('ready', () => {
          this.conns.set(cfg.id, {
            client,
            collector: {},
            shells: new Map(),
          });
          this.onState(cfg.id, 'connected');
          resolve();
        })
        .on('error', (err: Error) => {
          this.conns.delete(cfg.id);
          this.onState(cfg.id, 'error', err.message);
          reject(err);
        })
        .on('close', () => {
          this.conns.delete(cfg.id);
          this.onState(cfg.id, 'disconnected');
        })
        .connect({
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          password: cfg.authType === 'password' ? cfg.password : undefined,
          privateKey: cfg.authType === 'key' ? cfg.privateKey : undefined,
          passphrase: cfg.authType === 'key' ? cfg.passphrase : undefined,
          readyTimeout: 15000,
          keepaliveInterval: 15000,
        });
    });
  }

  disconnect(serverId: string): void {
    const conn = this.conns.get(serverId);
    if (!conn) return;
    for (const shell of conn.shells.values()) shell.close();
    conn.client.end();
    this.conns.delete(serverId);
  }

  fetchStatus(serverId: string): Promise<ServerStatus> {
    const conn = this.conns.get(serverId);
    if (!conn) return Promise.reject(new Error('not connected'));
    return new Promise((resolve, reject) => {
      conn.client.exec(STATUS_COMMAND, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        stream
          .on('data', (d: Buffer) => {
            out += d.toString('utf8');
          })
          .on('close', () => {
            try {
              resolve(parseStatus(out, conn.collector));
            } catch (e) {
              reject(e as Error);
            }
          });
        stream.stderr.resume();
      });
    });
  }

  openShell(serverId: string, shellId: string, cols: number, rows: number): void {
    const conn = this.conns.get(serverId);
    if (!conn) throw new Error('not connected');
    conn.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) {
        this.onShellClosed(serverId, shellId);
        return;
      }
      conn.shells.set(shellId, stream);
      stream
        .on('data', (d: Buffer) =>
          this.onShellOutput(serverId, shellId, d.toString('utf8')),
        )
        .on('close', () => {
          conn.shells.delete(shellId);
          this.onShellClosed(serverId, shellId);
        });
      stream.stderr.on('data', (d: Buffer) =>
        this.onShellOutput(serverId, shellId, d.toString('utf8')),
      );
    });
  }

  writeShell(serverId: string, shellId: string, data: string): void {
    this.conns.get(serverId)?.shells.get(shellId)?.write(data);
  }

  resizeShell(
    serverId: string,
    shellId: string,
    cols: number,
    rows: number,
  ): void {
    this.conns.get(serverId)?.shells.get(shellId)?.setWindow(rows, cols, 0, 0);
  }

  closeShell(serverId: string, shellId: string): void {
    this.conns.get(serverId)?.shells.get(shellId)?.close();
  }

  dispose(): void {
    for (const id of [...this.conns.keys()]) this.disconnect(id);
  }
}
