import http from 'node:http';
import crypto from 'node:crypto';
import type { SshManager } from './ssh/sshManager.js';
import type { BridgeInfo, BridgeServerEntry } from './shared.js';

/**
 * A loopback HTTP control bridge. It lets an external MCP server operate on the
 * SSH connections that ServerCase has already authenticated — running commands,
 * collecting status and browsing files — without ever seeing credentials or the
 * Bitwarden vault. Login stays entirely in ServerCase: the bridge only acts on
 * live connections, and `connect` merely asks the app to establish one.
 *
 * Access is gated by a per-session bearer token and the listener is bound to
 * 127.0.0.1.
 */
export class Bridge {
  private server: http.Server | null = null;
  private port = 8765;
  private readonly token = crypto.randomBytes(24).toString('hex');
  private registry = new Map<string, BridgeServerEntry>();

  constructor(
    private readonly ssh: SshManager,
    private readonly onConnectRequest: (serverId: string) => void,
  ) {}

  info(): BridgeInfo {
    return {
      running: this.server !== null,
      port: this.port,
      token: this.token,
      url: `http://127.0.0.1:${this.port}`,
    };
  }

  setRegistry(entries: BridgeServerEntry[]): void {
    this.registry = new Map(entries.map((e) => [e.id, e]));
  }

  async setEnabled(enabled: boolean, port: number): Promise<BridgeInfo> {
    this.port = port || 8765;
    await this.stop();
    if (enabled) await this.start();
    return this.info();
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  private start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((e) => this.send(res, 500, { error: String(e) }));
      });
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        resolve();
      });
    });
  }

  private stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
  }

  private resolveId(ref: string): string {
    if (this.registry.has(ref) || this.ssh.isConnected(ref)) return ref;
    for (const e of this.registry.values()) if (e.name === ref) return e.id;
    throw new Error(`unknown server: ${ref}`);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${this.token}`) {
      return this.send(res, 401, { error: 'unauthorized' });
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/servers') {
      const servers = [...this.registry.values()].map((e) => ({
        ...e,
        connected: this.ssh.isConnected(e.id),
      }));
      return this.send(res, 200, { servers });
    }

    if (req.method !== 'POST') return this.send(res, 404, { error: 'not found' });

    const body = await readJson(req);
    const ref = typeof body.server === 'string' ? body.server : '';

    try {
      const id = this.resolveId(ref);
      switch (path) {
        case '/connect': {
          this.onConnectRequest(id);
          return this.send(res, 200, { requested: true, connected: this.ssh.isConnected(id) });
        }
        case '/exec': {
          requireConnected(this.ssh, id);
          const r = await this.ssh.execCommand(id, String(body.command ?? ''));
          return this.send(res, 200, r);
        }
        case '/status': {
          requireConnected(this.ssh, id);
          return this.send(res, 200, await this.ssh.fetchStatus(id));
        }
        case '/sftp/list': {
          requireConnected(this.ssh, id);
          return this.send(res, 200, await this.ssh.sftpList(id, String(body.path ?? '.')));
        }
        case '/sftp/read': {
          requireConnected(this.ssh, id);
          const content = await this.ssh.sftpReadText(id, String(body.path));
          return this.send(res, 200, { content });
        }
        case '/sftp/write': {
          requireConnected(this.ssh, id);
          await this.ssh.sftpWriteText(id, String(body.path), String(body.content ?? ''));
          return this.send(res, 200, { ok: true });
        }
        case '/sftp/mkdir': {
          requireConnected(this.ssh, id);
          await this.ssh.sftpMkdir(id, String(body.path));
          return this.send(res, 200, { ok: true });
        }
        case '/sftp/remove': {
          requireConnected(this.ssh, id);
          await this.ssh.sftpRemove(id, String(body.path), Boolean(body.directory));
          return this.send(res, 200, { ok: true });
        }
        default:
          return this.send(res, 404, { error: 'not found' });
      }
    } catch (e) {
      const msg = (e as Error).message;
      const status = msg === 'not connected' ? 409 : 400;
      return this.send(res, status, { error: msg });
    }
  }
}

function requireConnected(ssh: SshManager, id: string): void {
  if (!ssh.isConnected(id)) {
    throw new Error('not connected');
  }
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
