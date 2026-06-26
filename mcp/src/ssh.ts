import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, type SFTPWrapper } from 'ssh2';

export interface ServerEntry {
  /** Stable id used to reference the server from tools. Defaults to `name`. */
  id?: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  /** PEM private key text. */
  privateKey?: string;
  /** Path to a private key file (read at connect time). */
  privateKeyPath?: string;
  passphrase?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface SftpItem {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  sizeBytes: number;
  modifiedAt: number;
  mode: string;
}

/** The portable status command shared with the ServerCase clients. */
export const STATUS_COMMAND = [
  'echo "===stat==="; cat /proc/stat | grep "^cpu "',
  'echo "===mem==="; cat /proc/meminfo',
  'echo "===net==="; cat /proc/net/dev',
  'echo "===uptime==="; cat /proc/uptime',
  'echo "===load==="; cat /proc/loadavg',
  'echo "===disk==="; df -k -P 2>/dev/null',
  'echo "===host==="; uname -r; hostname',
].join('; ');

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

/** Owns one ssh2 connection per configured server, opened lazily. */
export class SshPool {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly conns = new Map<string, Client>();

  constructor(entries: ServerEntry[]) {
    for (const e of entries) this.servers.set(e.id ?? e.name, e);
  }

  list(): ServerEntry[] {
    return [...this.servers.values()];
  }

  private resolve(ref: string): ServerEntry {
    const byId = this.servers.get(ref);
    if (byId) return byId;
    const byName = [...this.servers.values()].find((s) => s.name === ref);
    if (!byName) throw new Error(`unknown server: ${ref}`);
    return byName;
  }

  private key(entry: ServerEntry): string {
    return entry.id ?? entry.name;
  }

  private connect(ref: string): Promise<Client> {
    const entry = this.resolve(ref);
    const key = this.key(entry);
    const existing = this.conns.get(key);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const client = new Client();
      const privateKey = entry.privateKeyPath
        ? readFileSync(path.resolve(entry.privateKeyPath), 'utf8')
        : entry.privateKey;
      client
        .on('ready', () => {
          this.conns.set(key, client);
          resolve(client);
        })
        .on('error', (err) => {
          this.conns.delete(key);
          reject(err);
        })
        .on('close', () => this.conns.delete(key))
        .connect({
          host: entry.host,
          port: entry.port ?? 22,
          username: entry.username,
          password: entry.password,
          privateKey,
          passphrase: entry.passphrase,
          readyTimeout: 15000,
          keepaliveInterval: 15000,
        });
    });
  }

  async exec(ref: string, command: string): Promise<ExecResult> {
    const client = await this.connect(ref);
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let code: number | null = null;
        stream
          .on('data', (d: Buffer) => (stdout += d.toString('utf8')))
          .on('close', () => resolve({ stdout, stderr, code }))
          .on('exit', (c: number) => (code = c));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      });
    });
  }

  private sftp(ref: string): Promise<SFTPWrapper> {
    return this.connect(ref).then(
      (client) =>
        new Promise((resolve, reject) =>
          client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))),
        ),
    );
  }

  async sftpList(ref: string, dir: string): Promise<{ path: string; items: SftpItem[] }> {
    const sftp = await this.sftp(ref);
    const abs = await new Promise<string>((resolve, reject) =>
      sftp.realpath(dir || '.', (err, p) => (err ? reject(err) : resolve(p))),
    );
    const items = await new Promise<SftpItem[]>((resolve, reject) =>
      sftp.readdir(abs, (err, list) =>
        err
          ? reject(err)
          : resolve(
              list.map((it) => {
                const fmt = it.attrs.mode & S_IFMT;
                return {
                  name: it.filename,
                  type:
                    fmt === S_IFDIR
                      ? 'directory'
                      : fmt === S_IFLNK
                        ? 'symlink'
                        : fmt === S_IFREG
                          ? 'file'
                          : 'other',
                  sizeBytes: it.attrs.size ?? 0,
                  modifiedAt: (it.attrs.mtime ?? 0) * 1000,
                  mode: (it.attrs.mode & 0o777).toString(8).padStart(4, '0'),
                };
              }),
            ),
      ),
    );
    return { path: abs, items };
  }

  async sftpRead(ref: string, file: string): Promise<string> {
    const sftp = await this.sftp(ref);
    return new Promise((resolve, reject) =>
      sftp.readFile(file, (err, buf) =>
        err ? reject(err) : resolve(buf.toString('utf8')),
      ),
    );
  }

  async sftpWrite(ref: string, file: string, content: string): Promise<void> {
    const sftp = await this.sftp(ref);
    return new Promise((resolve, reject) =>
      sftp.writeFile(file, content, (err) => (err ? reject(err) : resolve())),
    );
  }

  async sftpMkdir(ref: string, dir: string): Promise<void> {
    const sftp = await this.sftp(ref);
    return new Promise((resolve, reject) =>
      sftp.mkdir(dir, (err) => (err ? reject(err) : resolve())),
    );
  }

  async sftpRemove(ref: string, target: string, isDir: boolean): Promise<void> {
    const sftp = await this.sftp(ref);
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null | undefined) => (err ? reject(err) : resolve());
      if (isDir) sftp.rmdir(target, cb);
      else sftp.unlink(target, cb);
    });
  }

  disconnect(ref: string): void {
    const entry = this.resolve(ref);
    const key = this.key(entry);
    this.conns.get(key)?.end();
    this.conns.delete(key);
  }

  disposeAll(): void {
    for (const c of this.conns.values()) c.end();
    this.conns.clear();
  }
}
