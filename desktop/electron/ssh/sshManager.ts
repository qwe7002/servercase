import path from 'node:path';
import net from 'node:net';
import {
  Client,
  type ClientChannel,
  type SFTPWrapper,
  type FileEntry,
} from 'ssh2';
import type {
  ServerConfig,
  ServerStatus,
  PortForwardInfo,
  PortForwardRequest,
  SftpEntry,
  SftpList,
} from '../shared.js';
import {
  STATUS_COMMAND,
  parseStatus,
  type CollectorState,
} from './statusCollector.js';

interface Connection {
  client: Client;
  collector: CollectorState;
  shells: Map<string, ClientChannel>;
  forwards: Map<string, PortForward>;
  sftp?: SFTPWrapper;
  /** Pre-auth SSH banner (e.g. /etc/issue.net), shown when a shell opens. */
  banner?: string;
  /** Login message read from the remote host, shown when a shell opens. */
  motd?: Promise<string>;
  publicIpv4?: string | null;
  publicIpv6?: string | null;
  /** Epoch ms of the last public-IP refresh (throttles the lookup). */
  publicIpAt?: number;
}

interface PortForward extends PortForwardInfo {
  server: net.Server;
  sockets: Set<net.Socket | ClientChannel>;
}

/** Looks up the server's public addresses from the internet. */
const PUBLIC_IP_COMMAND = [
  'echo "===v4==="; curl -4 -fsS --max-time 4 https://api.ipify.org 2>/dev/null',
  'echo "===v6==="; curl -6 -fsS --max-time 4 https://api6.ipify.org 2>/dev/null',
].join('; ');

const PUBLIC_IP_TTL_MS = 5 * 60_000;

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

  connectedIds(): string[] {
    return [...this.conns.keys()];
  }

  /** Runs a command to completion, returning stdout, stderr and exit code. */
  execCommand(
    serverId: string,
    command: string,
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const conn = this.conns.get(serverId);
    if (!conn) return Promise.reject(new Error('not connected'));
    return new Promise((resolve, reject) => {
      conn.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let code: number | null = null;
        stream
          .on('data', (d: Buffer) => (stdout += d.toString('utf8')))
          .on('exit', (c: number) => (code = c))
          .on('close', () => resolve({ stdout, stderr, code }));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      });
    });
  }

  connect(cfg: ServerConfig): Promise<void> {
    if (this.conns.has(cfg.id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const client = new Client();
      let banner = '';
      client
        .on('banner', (message: string) => {
          banner = message;
        })
        .on('ready', () => {
          this.conns.set(cfg.id, {
            client,
            collector: {},
            shells: new Map(),
            forwards: new Map(),
            banner: banner || undefined,
            motd: this.readMotd(client),
          });
          this.onState(cfg.id, 'connected');
          resolve();
        })
        .on('error', (err: Error) => {
          this.closePortForwardsFor(cfg.id);
          this.conns.delete(cfg.id);
          this.onState(cfg.id, 'error', err.message);
          reject(err);
        })
        .on('close', () => {
          this.closePortForwardsFor(cfg.id);
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
    for (const forward of conn.forwards.values()) closeForward(forward);
    conn.client.end();
    this.conns.delete(serverId);
  }

  async openPortForward(request: PortForwardRequest): Promise<PortForwardInfo> {
    const conn = this.conns.get(request.serverId);
    if (!conn) throw new Error('not connected');

    const localHost = (request.localHost || '127.0.0.1').trim();
    const remoteHost = (request.remoteHost || '127.0.0.1').trim();
    const localPort = validatePort(request.localPort, 'localPort', true);
    const remotePort = validatePort(request.remotePort, 'remotePort', false);
    if (!localHost) throw new Error('localHost is required');
    if (!remoteHost) throw new Error('remoteHost is required');

    const id = `pf_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const sockets = new Set<net.Socket | ClientChannel>();

    const server = net.createServer((localSocket) => {
      sockets.add(localSocket);
      localSocket.on('close', () => sockets.delete(localSocket));
      localSocket.on('error', () => undefined);

      conn.client.forwardOut(
        localSocket.remoteAddress || localHost,
        localSocket.remotePort || 0,
        remoteHost,
        remotePort,
        (err, remoteChannel) => {
          if (err) {
            localSocket.destroy(err);
            return;
          }
          sockets.add(remoteChannel);
          remoteChannel.on('close', () => sockets.delete(remoteChannel));
          remoteChannel.on('error', () => undefined);
          localSocket.pipe(remoteChannel).pipe(localSocket);
          localSocket.on('close', () => remoteChannel.destroy());
          remoteChannel.on('close', () => localSocket.destroy());
        },
      );
    });

    const opened = await listen(server, localHost, localPort);
    const actualPort = opened && typeof opened === 'object' ? opened.port : localPort;
    const info: PortForward = {
      id,
      serverId: request.serverId,
      localHost,
      localPort: actualPort,
      remoteHost,
      remotePort,
      label: request.label?.trim() || undefined,
      openedAt: Date.now(),
      server,
      sockets,
    };
    conn.forwards.set(id, info);
    server.on('close', () => conn.forwards.delete(id));
    return presentForward(info);
  }

  closePortForward(forwardId: string): void {
    for (const conn of this.conns.values()) {
      const forward = conn.forwards.get(forwardId);
      if (!forward) continue;
      closeForward(forward);
      conn.forwards.delete(forwardId);
      return;
    }
  }

  private closePortForwardsFor(serverId: string): void {
    const conn = this.conns.get(serverId);
    if (!conn) return;
    for (const forward of conn.forwards.values()) closeForward(forward);
    conn.forwards.clear();
  }

  listPortForwards(serverId?: string): PortForwardInfo[] {
    const conns = serverId
      ? [...(this.conns.get(serverId)?.forwards.values() ?? [])]
      : [...this.conns.values()].flatMap((conn) => [...conn.forwards.values()]);
    return conns.map(presentForward);
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
              const status = parseStatus(out, conn.collector);
              status.publicIpv4 = conn.publicIpv4 ?? null;
              status.publicIpv6 = conn.publicIpv6 ?? null;
              this.maybeRefreshPublicIp(serverId, conn);
              resolve(status);
            } catch (e) {
              reject(e as Error);
            }
          });
        stream.stderr.resume();
      });
    });
  }

  /** Refreshes the cached public IPs in the background when they go stale. */
  private maybeRefreshPublicIp(serverId: string, conn: Connection): void {
    const now = Date.now();
    if (conn.publicIpAt && now - conn.publicIpAt < PUBLIC_IP_TTL_MS) return;
    conn.publicIpAt = now;
    void this.execCommand(serverId, PUBLIC_IP_COMMAND)
      .then(({ stdout }) => {
        conn.publicIpv4 = pickLine(stdout, 'v4');
        conn.publicIpv6 = pickLine(stdout, 'v6');
      })
      .catch(() => undefined);
  }

  async openShell(
    serverId: string,
    shellId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const conn = this.conns.get(serverId);
    if (!conn) throw new Error('not connected');
    const motd = await conn.motd;
    conn.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) {
        this.onShellClosed(serverId, shellId);
        return;
      }
      conn.shells.set(shellId, stream);
      // Surface the pre-auth SSH banner (delivered during auth, not on the
      // shell stream) so the terminal shows the server's welcome message.
      if (conn.banner) {
        this.onShellOutput(
          serverId,
          shellId,
          conn.banner.replace(/\r?\n/g, '\r\n') + '\r\n',
        );
      }
      if (motd) {
        this.onShellOutput(serverId, shellId, motd.replace(/\r?\n/g, '\r\n'));
      }
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

  private readMotd(client: Client): Promise<string> {
    const command = [
      'for f in /run/motd.dynamic /etc/motd; do',
      '  [ -r "$f" ] && cat "$f";',
      'done',
    ].join(' ');
    return new Promise((resolve) => {
      client.exec(command, (err, stream) => {
        if (err) {
          resolve('');
          return;
        }
        let out = '';
        stream
          .on('data', (d: Buffer) => {
            out += d.toString('utf8');
          })
          .on('close', () => resolve(out.trimEnd() ? `${out.trimEnd()}\n` : ''));
        stream.stderr.resume();
      });
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

  // ── SFTP ──────────────────────────────────────────────────────────────────

  /** Lazily opens (and caches) one SFTP channel per connection. */
  private sftp(serverId: string): Promise<SFTPWrapper> {
    const conn = this.conns.get(serverId);
    if (!conn) return Promise.reject(new Error('not connected'));
    if (conn.sftp) return Promise.resolve(conn.sftp);
    return new Promise((resolve, reject) => {
      conn.client.sftp((err, sftp) => {
        if (err) return reject(err);
        conn.sftp = sftp;
        sftp.on('close', () => {
          if (conn.sftp === sftp) conn.sftp = undefined;
        });
        resolve(sftp);
      });
    });
  }

  async sftpList(serverId: string, dir: string): Promise<SftpList> {
    const sftp = await this.sftp(serverId);
    const target = dir && dir !== '' ? dir : '.';
    const realDir = await new Promise<string>((resolve, reject) => {
      sftp.realpath(target, (err, abs) => (err ? reject(err) : resolve(abs)));
    });
    const list = await new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(realDir, (err, items) =>
        err ? reject(err) : resolve(items),
      );
    });
    const entries: SftpEntry[] = list
      .map((it) => toEntry(realDir, it))
      .sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });
    return { path: realDir, entries };
  }

  async sftpReadText(serverId: string, file: string): Promise<string> {
    const sftp = await this.sftp(serverId);
    return new Promise((resolve, reject) => {
      sftp.readFile(file, (err, buf) =>
        err ? reject(err) : resolve(buf.toString('utf8')),
      );
    });
  }

  async sftpWriteText(
    serverId: string,
    file: string,
    content: string,
  ): Promise<void> {
    const sftp = await this.sftp(serverId);
    return new Promise((resolve, reject) => {
      sftp.writeFile(file, content, (err) => (err ? reject(err) : resolve()));
    });
  }

  async sftpMkdir(serverId: string, dir: string): Promise<void> {
    const sftp = await this.sftp(serverId);
    return new Promise((resolve, reject) => {
      sftp.mkdir(dir, (err) => (err ? reject(err) : resolve()));
    });
  }

  async sftpRename(serverId: string, from: string, to: string): Promise<void> {
    const sftp = await this.sftp(serverId);
    return new Promise((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
    });
  }

  async sftpRemove(
    serverId: string,
    target: string,
    isDir: boolean,
  ): Promise<void> {
    const sftp = await this.sftp(serverId);
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null | undefined) =>
        err ? reject(err) : resolve();
      if (isDir) sftp.rmdir(target, cb);
      else sftp.unlink(target, cb);
    });
  }

  /** Downloads a remote file to a local path. */
  async sftpFastGet(
    serverId: string,
    remote: string,
    local: string,
  ): Promise<void> {
    const sftp = await this.sftp(serverId);
    return new Promise((resolve, reject) => {
      sftp.fastGet(remote, local, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Uploads a local file into a remote directory. */
  async sftpFastPut(
    serverId: string,
    local: string,
    remoteDir: string,
    name: string,
  ): Promise<void> {
    const sftp = await this.sftp(serverId);
    const remote = path.posix.join(remoteDir, name);
    return new Promise((resolve, reject) => {
      sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
    });
  }

  dispose(): void {
    for (const id of [...this.conns.keys()]) this.disconnect(id);
  }
}

// POSIX file-type bits (S_IFMT mask), used to classify SFTP entries from the
// raw mode since readdir's attrs are typed without the Stats helper methods.
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

/** Extracts the value under a `===name===` section, or null if empty/absent. */
function pickLine(out: string, name: string): string | null {
  const start = out.indexOf(`===${name}===`);
  if (start === -1) return null;
  const from = out.indexOf('\n', start) + 1;
  const next = out.indexOf('===', from);
  const value = out.slice(from, next === -1 ? undefined : next).trim();
  return value || null;
}

function toEntry(dir: string, it: FileEntry): SftpEntry {
  const attrs = it.attrs;
  const fmt = attrs.mode & S_IFMT;
  let type: SftpEntry['type'] = 'other';
  if (fmt === S_IFDIR) type = 'directory';
  else if (fmt === S_IFLNK) type = 'symlink';
  else if (fmt === S_IFREG) type = 'file';
  return {
    name: it.filename,
    path: path.posix.join(dir, it.filename),
    type,
    sizeBytes: attrs.size ?? 0,
    modifiedAt: (attrs.mtime ?? 0) * 1000,
    mode: (attrs.mode & 0o777).toString(8).padStart(4, '0'),
  };
}

function validatePort(port: number, name: string, allowZero: boolean): number {
  if (!Number.isInteger(port)) throw new Error(`${name} must be an integer`);
  const min = allowZero ? 0 : 1;
  if (port < min || port > 65535) {
    throw new Error(`${name} must be between ${min} and 65535`);
  }
  return port;
}

function listen(
  server: net.Server,
  host: string,
  port: number,
): Promise<net.AddressInfo | string | null> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeForward(forward: PortForward): void {
  for (const socket of forward.sockets) socket.destroy();
  forward.sockets.clear();
  forward.server.close(() => undefined);
}

function presentForward(forward: PortForward): PortForwardInfo {
  return {
    id: forward.id,
    serverId: forward.serverId,
    localHost: forward.localHost,
    localPort: forward.localPort,
    remoteHost: forward.remoteHost,
    remotePort: forward.remotePort,
    label: forward.label,
    openedAt: forward.openedAt,
  };
}
