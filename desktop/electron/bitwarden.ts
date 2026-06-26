import crypto from 'node:crypto';
import type {
  BitwardenSettings,
  BitwardenStatus,
  ServerSecrets,
} from './shared.js';

/**
 * A clean-room Bitwarden client: it speaks the Bitwarden REST API directly and
 * reimplements the account crypto, so it needs neither the `bw` CLI nor the
 * official SDK.
 *
 * Auth uses a personal API key (OAuth `client_credentials`), which avoids the
 * interactive 2FA flow; the master password is still required to derive the
 * vault key locally and is never sent to the server or persisted.
 *
 * Crypto (matching the Bitwarden spec):
 *  - master key   = PBKDF2-SHA256(masterPassword, email, iterations, 32 bytes)
 *  - stretch      = HKDF-Expand(masterKey, "enc"|"mac") → encKey/macKey
 *  - user key     = decrypt(protectedKey) → 64 bytes (encKey64 ‖ macKey64)
 *  - EncString    = "2.<iv>|<ct>|<mac>" = AES-256-CBC + HMAC-SHA256, base64
 *
 * Note: only the PBKDF2 KDF is supported. Argon2id accounts must switch their
 * account KDF to PBKDF2 (Bitwarden web vault → Security → Keys).
 */
export class BitwardenVault {
  private settings: BitwardenSettings = {
    enabled: false,
    serverUrl: '',
    email: '',
    clientId: '',
    clientSecret: '',
    itemPrefix: 'ServerCase/',
  };

  // In-memory session, populated by unlock(); never persisted.
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private userEncKey: Buffer | null = null;
  private userMacKey: Buffer | null = null;
  private readonly deviceId = crypto.randomUUID();

  configure(settings: BitwardenSettings): void {
    // Re-configuring with different credentials invalidates the session.
    if (
      settings.serverUrl !== this.settings.serverUrl ||
      settings.email !== this.settings.email ||
      settings.clientId !== this.settings.clientId
    ) {
      this.lock();
    }
    this.settings = settings;
  }

  private get identityUrl(): string {
    const base = this.settings.serverUrl.trim().replace(/\/+$/, '');
    return base ? `${base}/identity` : 'https://identity.bitwarden.com';
  }

  private get apiUrl(): string {
    const base = this.settings.serverUrl.trim().replace(/\/+$/, '');
    return base ? `${base}/api` : 'https://api.bitwarden.com';
  }

  private get configured(): boolean {
    return Boolean(
      this.settings.email &&
        this.settings.clientId &&
        this.settings.clientSecret,
    );
  }

  private get unlocked(): boolean {
    return Boolean(
      this.userEncKey && this.accessToken && Date.now() < this.tokenExpiresAt,
    );
  }

  status(): Promise<BitwardenStatus> {
    const state = !this.configured
      ? 'unauthenticated'
      : this.unlocked
        ? 'unlocked'
        : 'locked';
    return Promise.resolve({
      available: this.configured,
      state,
      serverUrl: this.settings.serverUrl || 'https://bitwarden.com',
      userEmail: this.settings.email || undefined,
    });
  }

  async unlock(masterPassword: string): Promise<BitwardenStatus> {
    if (!this.configured) throw new Error('Bitwarden API key not configured');

    const kdf = await this.prelogin();
    const token = await this.requestToken();

    const masterKey = this.deriveMasterKey(masterPassword, kdf);
    const stretchedEnc = hkdfExpand(masterKey, 'enc', 32);
    const stretchedMac = hkdfExpand(masterKey, 'mac', 32);

    const userKey = decryptEncString(token.key, stretchedEnc, stretchedMac);
    if (userKey.length < 64) throw new Error('unexpected vault key length');

    this.userEncKey = userKey.subarray(0, 32);
    this.userMacKey = userKey.subarray(32, 64);
    this.accessToken = token.accessToken;
    this.tokenExpiresAt = Date.now() + token.expiresInSec * 1000 - 30_000;
    return this.status();
  }

  lock(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.userEncKey = null;
    this.userMacKey = null;
  }

  /** No-op kept for API parity with the previous CLI-backed vault. */
  async sync(): Promise<void> {
    this.assertUnlocked();
  }

  async getSecrets(serverId: string): Promise<ServerSecrets | null> {
    const cipher = await this.findCipher(serverId);
    return cipher ? this.decodeSecrets(cipher) : null;
  }

  async listSecrets(): Promise<Record<string, ServerSecrets>> {
    const ciphers = await this.fetchCiphers();
    const out: Record<string, ServerSecrets> = {};
    for (const cipher of ciphers) {
      const name = this.decryptField(cipher.name);
      if (name && name.startsWith(this.settings.itemPrefix)) {
        out[name.slice(this.settings.itemPrefix.length)] =
          this.decodeSecrets(cipher);
      }
    }
    return out;
  }

  async setSecrets(serverId: string, secrets: ServerSecrets): Promise<void> {
    this.assertUnlocked();
    const name = this.encryptField(this.settings.itemPrefix + serverId);
    const notes = this.encryptField(JSON.stringify(secrets));
    const body = {
      type: 1,
      name,
      notes,
      favorite: false,
      folderId: null,
      organizationId: null,
      login: {
        username: secrets.username ? this.encryptField(secrets.username) : null,
        password: secrets.password ? this.encryptField(secrets.password) : null,
        uris: null,
        totp: null,
      },
    };
    const existing = await this.findCipher(serverId);
    if (existing) {
      await this.api('PUT', `/ciphers/${existing.id}`, body);
    } else {
      await this.api('POST', '/ciphers', body);
    }
  }

  async deleteSecrets(serverId: string): Promise<void> {
    const cipher = await this.findCipher(serverId);
    if (cipher) await this.api('DELETE', `/ciphers/${cipher.id}`);
  }

  // ── crypto ────────────────────────────────────────────────────────────────

  private deriveMasterKey(password: string, kdf: KdfInfo): Buffer {
    if (kdf.type !== 0) {
      throw new Error(
        'Only the PBKDF2 KDF is supported; switch your Bitwarden account KDF to PBKDF2.',
      );
    }
    const salt = this.settings.email.trim().toLowerCase();
    return crypto.pbkdf2Sync(
      Buffer.from(password, 'utf8'),
      Buffer.from(salt, 'utf8'),
      kdf.iterations,
      32,
      'sha256',
    );
  }

  private encryptField(plaintext: string): string {
    return encryptEncString(plaintext, this.encKey, this.macKey);
  }

  private decryptField(enc: string | null | undefined): string | null {
    if (!enc) return null;
    try {
      return decryptEncString(enc, this.encKey, this.macKey).toString('utf8');
    } catch {
      return null;
    }
  }

  private decodeSecrets(cipher: Cipher): ServerSecrets {
    const notes = this.decryptField(cipher.notes);
    if (notes) {
      try {
        return JSON.parse(notes) as ServerSecrets;
      } catch {
        /* fall through */
      }
    }
    return {
      username: this.decryptField(cipher.login?.username) ?? undefined,
      password: this.decryptField(cipher.login?.password) ?? undefined,
    };
  }

  private get encKey(): Buffer {
    if (!this.userEncKey) throw new Error('Bitwarden vault is locked');
    return this.userEncKey;
  }

  private get macKey(): Buffer {
    if (!this.userMacKey) throw new Error('Bitwarden vault is locked');
    return this.userMacKey;
  }

  private assertUnlocked(): void {
    if (!this.unlocked) throw new Error('Bitwarden vault is locked');
  }

  // ── REST ────────────────────────────────────────────────────────────────

  private async prelogin(): Promise<KdfInfo> {
    try {
      const res = await fetch(`${this.identityUrl}/accounts/prelogin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.settings.email }),
      });
      if (res.ok) {
        const j = (await res.json()) as Record<string, unknown>;
        return {
          type: Number(pick(j, 'Kdf', 'kdf') ?? 0),
          iterations: Number(pick(j, 'KdfIterations', 'kdfIterations') ?? 600000),
        };
      }
    } catch {
      /* fall back to defaults below */
    }
    return { type: 0, iterations: 600000 };
  }

  private async requestToken(): Promise<TokenResult> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.settings.clientId,
      client_secret: this.settings.clientSecret,
      scope: 'api',
      deviceType: '8', // LinuxDesktop
      deviceIdentifier: this.deviceId,
      deviceName: 'ServerCase',
    });
    const res = await fetch(`${this.identityUrl}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        String(
          json.error_description ||
            (json.ErrorModel as { Message?: string })?.Message ||
            'Bitwarden login failed',
        ),
      );
    }
    const key = pick(json, 'Key', 'key');
    if (typeof key !== 'string') throw new Error('login response missing key');
    return {
      accessToken: String(json.access_token),
      expiresInSec: Number(json.expires_in ?? 3600),
      key,
    };
  }

  private async fetchCiphers(): Promise<Cipher[]> {
    this.assertUnlocked();
    const sync = (await this.api('GET', '/sync?excludeDomains=true')) as {
      Ciphers?: RawCipher[];
      ciphers?: RawCipher[];
    };
    const raw = sync.Ciphers ?? sync.ciphers ?? [];
    return raw.map(normalizeCipher);
  }

  private async findCipher(serverId: string): Promise<Cipher | null> {
    const target = this.settings.itemPrefix + serverId;
    const ciphers = await this.fetchCiphers();
    return (
      ciphers.find((c) => this.decryptField(c.name) === target) ?? null
    );
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    this.assertUnlocked();
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bitwarden ${method} ${path} failed: ${res.status} ${text}`);
    }
    return res.status === 204 ? undefined : res.json().catch(() => undefined);
  }
}

interface KdfInfo {
  type: number;
  iterations: number;
}

interface TokenResult {
  accessToken: string;
  expiresInSec: number;
  key: string;
}

interface CipherLogin {
  username?: string | null;
  password?: string | null;
}

interface Cipher {
  id: string;
  name: string | null;
  notes: string | null;
  login?: CipherLogin | null;
}

type RawCipher = Record<string, unknown>;

function normalizeCipher(raw: RawCipher): Cipher {
  const login = (pick(raw, 'Login', 'login') as RawCipher | undefined) ?? undefined;
  return {
    id: String(pick(raw, 'Id', 'id')),
    name: (pick(raw, 'Name', 'name') as string | null) ?? null,
    notes: (pick(raw, 'Notes', 'notes') as string | null) ?? null,
    login: login
      ? {
          username: (pick(login, 'Username', 'username') as string | null) ?? null,
          password: (pick(login, 'Password', 'password') as string | null) ?? null,
        }
      : null,
  };
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

/** HKDF-Expand (RFC 5869) with the given PRK; SHA-256, info as UTF-8. */
function hkdfExpand(prk: Buffer, info: string, size: number): Buffer {
  const hashLen = 32;
  const n = Math.ceil(size / hashLen);
  let t = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (let i = 1; i <= n; i++) {
    const h = crypto.createHmac('sha256', prk);
    h.update(Buffer.concat([t, Buffer.from(info, 'utf8'), Buffer.from([i])]));
    t = h.digest();
    chunks.push(t);
  }
  return Buffer.concat(chunks).subarray(0, size);
}

/** Parses and decrypts a type-2 EncString ("2.iv|ct|mac"). */
function decryptEncString(enc: string, encKey: Buffer, macKey: Buffer): Buffer {
  const dot = enc.indexOf('.');
  const type = enc.slice(0, dot);
  if (type !== '2') throw new Error(`unsupported EncString type ${type}`);
  const [ivB64, ctB64, macB64] = enc.slice(dot + 1).split('|');
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const mac = Buffer.from(macB64, 'base64');
  const expected = crypto
    .createHmac('sha256', macKey)
    .update(Buffer.concat([iv, ct]))
    .digest();
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) {
    throw new Error('EncString MAC mismatch');
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Encrypts plaintext into a type-2 EncString. */
function encryptEncString(plaintext: string, encKey: Buffer, macKey: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const mac = crypto
    .createHmac('sha256', macKey)
    .update(Buffer.concat([iv, ct]))
    .digest();
  return `2.${iv.toString('base64')}|${ct.toString('base64')}|${mac.toString('base64')}`;
}

// Exposed for the crypto self-test.
export const _internal = { hkdfExpand, decryptEncString, encryptEncString };
