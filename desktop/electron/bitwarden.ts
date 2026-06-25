import { execFile } from 'node:child_process';
import type {
  BitwardenSettings,
  BitwardenStatus,
  ServerSecrets,
} from './shared.js';

/** Shape of a Bitwarden CLI item we care about. */
interface BwItem {
  id: string;
  name: string;
  notes?: string | null;
  login?: {
    username?: string | null;
    password?: string | null;
  } | null;
}

interface BwStatusJson {
  serverUrl?: string | null;
  userEmail?: string | null;
  status: 'unauthenticated' | 'locked' | 'unlocked';
}

/**
 * Stores server credentials in the user's Bitwarden vault through the `bw`
 * command-line client.
 *
 * Design notes:
 * - The master password never leaves the main process: `unlock` exchanges it
 *   for a session token held only in memory here.
 * - Each server maps to one vault item named `${itemPrefix}${serverId}`. The
 *   full {@link ServerSecrets} bundle is stored as JSON in the item's `notes`,
 *   and username/password are mirrored into the item's login fields so the
 *   entry is also usable from the regular Bitwarden apps.
 * - We assume the user has already run `bw login` (Bitwarden's login flow is
 *   interactive and may require 2FA); ServerCase only configures the server,
 *   unlocks, and reads/writes items.
 */
export class BitwardenVault {
  private settings: BitwardenSettings = {
    enabled: false,
    cliPath: '',
    serverUrl: '',
    itemPrefix: 'ServerCase/',
  };
  /** In-memory session token from `bw unlock --raw`. Null when locked. */
  private session: string | null = null;

  configure(settings: BitwardenSettings): void {
    this.settings = settings;
  }

  private get bin(): string {
    return this.settings.cliPath.trim() || 'bw';
  }

  private itemName(serverId: string): string {
    return `${this.settings.itemPrefix}${serverId}`;
  }

  /** Runs the CLI, returning stdout. `input` is fed on stdin when provided. */
  private run(args: string[], input?: string): Promise<string> {
    const env = { ...process.env };
    if (this.session) env.BW_SESSION = this.session;
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.bin,
        args,
        { env, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || err.message || '').trim();
            reject(new Error(msg || `bw ${args[0]} failed`));
            return;
          }
          resolve(stdout.toString());
        },
      );
      if (input !== undefined) {
        child.stdin?.end(input);
      }
    });
  }

  async status(): Promise<BitwardenStatus> {
    try {
      const out = await this.run(['status']);
      const parsed = JSON.parse(out) as BwStatusJson;
      // `bw status` reports "locked" even when we hold a live session token,
      // so trust our own session state for the unlocked case.
      const state =
        this.session && parsed.status !== 'unauthenticated'
          ? 'unlocked'
          : parsed.status;
      return {
        available: true,
        state,
        serverUrl: parsed.serverUrl ?? undefined,
        userEmail: parsed.userEmail ?? undefined,
      };
    } catch (e) {
      return {
        available: false,
        state: 'unauthenticated',
        error: (e as Error).message,
      };
    }
  }

  /** Points the CLI at a self-hosted server. Only valid while logged out. */
  async applyServerConfig(): Promise<void> {
    const url = this.settings.serverUrl.trim();
    await this.run(['config', 'server', url || 'https://bitwarden.com']);
  }

  /** Exchanges the master password for a session token. */
  async unlock(masterPassword: string): Promise<BitwardenStatus> {
    const env = { ...process.env, SC_BW_PW: masterPassword };
    const token = await new Promise<string>((resolve, reject) => {
      execFile(
        this.bin,
        ['unlock', '--raw', '--passwordenv', 'SC_BW_PW'],
        { env, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error((stderr || err.message).trim()));
            return;
          }
          resolve(stdout.toString().trim());
        },
      );
    });
    this.session = token;
    await this.run(['sync']).catch(() => undefined);
    return this.status();
  }

  lock(): void {
    this.session = null;
  }

  /** Pulls the latest vault state from the server. */
  async sync(): Promise<void> {
    this.assertUnlocked();
    await this.run(['sync']);
  }

  private assertUnlocked(): void {
    if (!this.session) throw new Error('Bitwarden vault is locked');
  }

  private async findItem(serverId: string): Promise<BwItem | null> {
    const name = this.itemName(serverId);
    const out = await this.run(['list', 'items', '--search', name]);
    const items = JSON.parse(out) as BwItem[];
    return items.find((i) => i.name === name) ?? null;
  }

  async getSecrets(serverId: string): Promise<ServerSecrets | null> {
    this.assertUnlocked();
    const item = await this.findItem(serverId);
    if (!item) return null;
    if (item.notes) {
      try {
        return JSON.parse(item.notes) as ServerSecrets;
      } catch {
        /* fall through to login fields */
      }
    }
    return {
      username: item.login?.username ?? undefined,
      password: item.login?.password ?? undefined,
    };
  }

  /** Returns secrets for every ServerCase-owned item, keyed by server id. */
  async listSecrets(): Promise<Record<string, ServerSecrets>> {
    this.assertUnlocked();
    const out = await this.run([
      'list',
      'items',
      '--search',
      this.settings.itemPrefix,
    ]);
    const items = JSON.parse(out) as BwItem[];
    const result: Record<string, ServerSecrets> = {};
    for (const item of items) {
      if (!item.name.startsWith(this.settings.itemPrefix)) continue;
      const serverId = item.name.slice(this.settings.itemPrefix.length);
      if (item.notes) {
        try {
          result[serverId] = JSON.parse(item.notes) as ServerSecrets;
          continue;
        } catch {
          /* ignore malformed */
        }
      }
      result[serverId] = {
        username: item.login?.username ?? undefined,
        password: item.login?.password ?? undefined,
      };
    }
    return result;
  }

  async setSecrets(serverId: string, secrets: ServerSecrets): Promise<void> {
    this.assertUnlocked();
    const notes = JSON.stringify(secrets);
    const existing = await this.findItem(serverId);
    const body = {
      type: 1, // login
      name: this.itemName(serverId),
      notes,
      login: {
        username: secrets.username ?? null,
        password: secrets.password ?? null,
      },
    };
    const encoded = await this.run(['encode'], JSON.stringify(body));
    if (existing) {
      await this.run(['edit', 'item', existing.id], encoded.trim());
    } else {
      await this.run(['create', 'item'], encoded.trim());
    }
  }

  async deleteSecrets(serverId: string): Promise<void> {
    this.assertUnlocked();
    const item = await this.findItem(serverId);
    if (item) await this.run(['delete', 'item', item.id]);
  }
}
