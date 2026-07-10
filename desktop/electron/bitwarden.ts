import crypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2';
import type {
  BitwardenFolder,
  BitwardenSettings,
  BitwardenStatus,
  ServerSecrets,
} from './shared.js';

/**
 * Persists the master password between launches so the vault can auto-unlock,
 * mirroring the iOS Keychain store. The desktop backs this with Electron's
 * `safeStorage` (OS keychain); tests can inject an in-memory fake.
 */
export interface MasterPasswordStore {
  load(account: string): string | null;
  save(account: string, password: string): void;
}

/**
 * A clean-room Bitwarden client: it speaks the Bitwarden REST API directly and
 * reimplements the account crypto, so it needs neither the `bw` CLI nor the
 * official SDK. The protocol is the public, documented Bitwarden security
 * model; none of the official (GPL) client code is used here.
 *
 * Auth uses a personal API key (OAuth `client_credentials`), which avoids the
 * interactive 2FA flow; the master password is still required to derive the
 * vault key locally and is never sent to the server.
 *
 * Vault layout (shared with the iOS/Android clients):
 *  - items are ordinary login ciphers inside the configured ServerCase folder,
 *    named by the user (e.g. the server name) — legacy `<folder>/<name>` items
 *    are still found and migrate into the folder on the next save;
 *  - SSH private keys live in their own SSH-key cipher (type 5), linked from
 *    the login item via a hidden `servercase.sshKeyItemName` custom field.
 *
 * Crypto:
 *  - master key  = PBKDF2-SHA256(password, email, iters)         [Kdf 0]
 *                  or Argon2id(password, SHA256(email), m,t,p)   [Kdf 1]
 *  - stretch     = HKDF-Expand(masterKey, "enc"|"mac") → enc/mac
 *  - user key    = decrypt(protectedKey) → 64 bytes (encKey ‖ macKey)
 *  - cipher key  = decrypt(cipher.key) with the user key, when present
 *  - EncString   = "2.<iv>|<ct>|<mac>" = AES-256-CBC + HMAC-SHA256, base64
 */
export class BitwardenVault {
  private settings: BitwardenSettings = {
    enabled: false,
    authMode: 'password',
    serverUrl: '',
    email: '',
    clientId: '',
    clientSecret: '',
    itemPrefix: 'ServerCase',
  };

  // In-memory session, populated by unlock(); never persisted.
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private userEncKey: Buffer | null = null;
  private userMacKey: Buffer | null = null;
  private readonly deviceId = crypto.randomUUID();

  constructor(private readonly passwordStore?: MasterPasswordStore) {}

  configure(settings: BitwardenSettings): void {
    if (
      settings.serverUrl !== this.settings.serverUrl ||
      settings.email !== this.settings.email ||
      settings.authMode !== this.settings.authMode ||
      settings.clientId !== this.settings.clientId
    ) {
      this.lock();
    }
    this.settings = { ...settings, authMode: settings.authMode ?? 'password' };
  }

  private get base(): string {
    const trimmed = this.settings.serverUrl.trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  private get identityUrl(): string {
    return this.base ? `${this.base}/identity` : 'https://identity.bitwarden.com';
  }

  private get apiUrl(): string {
    return this.base ? `${this.base}/api` : 'https://api.bitwarden.com';
  }

  private get configured(): boolean {
    if (this.authMode === 'apiKey') {
      return Boolean(
        this.settings.email &&
          this.settings.clientId &&
          this.settings.clientSecret,
      );
    }
    return Boolean(this.settings.email);
  }

  private get authMode(): BitwardenSettings['authMode'] {
    return this.settings.authMode ?? 'password';
  }

  private get unlocked(): boolean {
    return Boolean(
      this.userEncKey && this.accessToken && Date.now() < this.tokenExpiresAt,
    );
  }

  /** Stable account key for the persisted master password, as on iOS. */
  private get accountKey(): string {
    const server = (this.base || 'https://bitwarden.com').toLowerCase();
    return `${server}|${this.settings.email.trim().toLowerCase()}`;
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
    if (!this.configured) throw new Error('Bitwarden account not configured');

    const token = await this.requestToken(masterPassword);
    // KDF params come with the token; prelogin is only a fallback.
    const kdf = token.kdf ?? (await this.prelogin());

    const masterKey = this.deriveMasterKey(masterPassword, kdf);
    const stretchedEnc = hkdfExpand(masterKey, 'enc', 32);
    const stretchedMac = hkdfExpand(masterKey, 'mac', 32);

    const userKey = decryptEncString(token.key, stretchedEnc, stretchedMac);
    if (userKey.length < 64) throw new Error('unexpected vault key length');

    this.userEncKey = userKey.subarray(0, 32);
    this.userMacKey = userKey.subarray(32, 64);
    this.accessToken = token.accessToken;
    this.tokenExpiresAt = Date.now() + token.expiresInSec * 1000 - 30_000;
    if (this.authMode === 'password') {
      this.passwordStore?.save(this.accountKey, masterPassword);
    }
    return this.status();
  }

  /**
   * Attempts to unlock with the persisted master password (password mode
   * only). Never throws — returns the current status either way.
   */
  async unlockWithStored(): Promise<BitwardenStatus> {
    if (this.unlocked || !this.configured || this.authMode !== 'password') {
      return this.status();
    }
    const stored = this.passwordStore?.load(this.accountKey);
    if (stored) {
      try {
        return await this.unlock(stored);
      } catch {
        /* stale password; stay locked */
      }
    }
    return this.status();
  }

  lock(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.userEncKey = null;
    this.userMacKey = null;
  }

  async sync(): Promise<void> {
    this.assertUnlocked();
  }

  /**
   * Exercises the full vault path end-to-end with a throwaway item: encrypt and
   * upload a probe, fetch and decrypt it back, verify, then delete it.
   */
  async test(): Promise<string> {
    this.assertUnlocked();
    const itemName = '__selftest__';
    const probe: ServerSecrets = {
      username: 'servercase',
      password: `probe-${crypto.randomBytes(8).toString('hex')}`,
    };
    await this.setSecrets(itemName, probe);
    try {
      const read = await this.getSecrets(itemName);
      if (
        !read ||
        read.username !== probe.username ||
        read.password !== probe.password
      ) {
        throw new Error('round-trip mismatch — decrypted value did not match');
      }
      return `Vault OK — wrote, read back and verified "${this.folderName}/${itemName}".`;
    } finally {
      await this.deleteSecrets(itemName).catch(() => undefined);
    }
  }

  async getSecrets(
    itemName: string,
    aliases: string[] = [],
  ): Promise<ServerSecrets | null> {
    const snapshot = await this.fetchSync();
    const cipher = this.findCipherIn(itemName, aliases, snapshot.ciphers);
    return cipher ? this.resolveSecrets(cipher, snapshot.ciphers) : null;
  }

  async listSecrets(): Promise<Record<string, ServerSecrets>> {
    const snapshot = await this.fetchSync();
    const folderId = this.serverCaseFolderId(snapshot.folders);
    const out: Record<string, ServerSecrets> = {};
    for (const cipher of snapshot.ciphers) {
      if (cipher.type !== 1) continue;
      const keys = this.cipherKeys(cipher);
      const name = decryptField(cipher.name, keys.enc, keys.mac);
      if (!name) continue;
      if (folderId && cipher.folderId === folderId) {
        out[name] = this.resolveSecrets(cipher, snapshot.ciphers);
      } else if (name.startsWith(this.legacyItemPrefix)) {
        out[name.slice(this.legacyItemPrefix.length)] = this.resolveSecrets(
          cipher,
          snapshot.ciphers,
        );
      }
    }
    return out;
  }

  async setSecrets(
    itemName: string,
    secrets: ServerSecrets,
    aliases: string[] = [],
  ): Promise<void> {
    this.assertUnlocked();
    const folderId = await this.ensureServerCaseFolderId();

    // A private key gets its own SSH-key item; the login item keeps only the
    // link to it (and the passphrase in the password slot).
    const normalized: ServerSecrets = { ...secrets };
    if (secrets.privateKey) {
      const keyItemName = secrets.sshKeyItemName?.trim()
        ? secrets.sshKeyItemName.trim()
        : `${this.normalizedItemName(itemName)} SSH Key`;
      await this.setSSHKeyItem(keyItemName, secrets.privateKey);
      normalized.sshKeyItemName = keyItemName;
      normalized.password = secrets.passphrase;
      normalized.privateKey = undefined;
      normalized.passphrase = undefined;
    }

    const body = {
      type: 1,
      name: this.encryptField(this.normalizedItemName(itemName)),
      notes: null,
      favorite: false,
      folderId,
      organizationId: null,
      login: {
        username: normalized.username
          ? this.encryptField(normalized.username)
          : null,
        password: normalized.password
          ? this.encryptField(normalized.password)
          : null,
        uris: null,
        totp: null,
      },
      fields: this.encryptedFields(normalized),
    };
    const existing = await this.findCipher(itemName, aliases);
    if (existing) {
      await this.api('PUT', `/ciphers/${existing.id}`, body);
    } else {
      await this.api('POST', '/ciphers', body);
    }
  }

  async deleteSecrets(itemName: string, aliases: string[] = []): Promise<void> {
    const cipher = await this.findCipher(itemName, aliases);
    if (cipher) await this.api('DELETE', `/ciphers/${cipher.id}`);
  }

  // ── folders ───────────────────────────────────────────────────────────────

  async listFolders(): Promise<BitwardenFolder[]> {
    const snapshot = await this.fetchSync();
    const enc = this.encKey;
    const mac = this.macKey;
    return snapshot.folders
      .flatMap((folder) => {
        const name = decryptField(folder.name, enc, mac);
        return name ? [{ id: folder.id, name }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  async createFolder(name: string): Promise<BitwardenFolder> {
    const cleanName = this.normalizedFolderName(name);
    const res = (await this.api('POST', '/folders', {
      name: this.encryptField(cleanName),
    })) as Record<string, unknown> | undefined;
    const id = res ? pick(res, 'Id', 'id') : undefined;
    if (typeof id !== 'string') {
      throw new Error('Bitwarden folder create response missing id');
    }
    return { id, name: cleanName };
  }

  async deleteFolder(id: string): Promise<void> {
    await this.api('DELETE', `/folders/${id}`);
  }

  // ── naming ────────────────────────────────────────────────────────────────

  private get folderName(): string {
    return this.normalizedFolderName(this.settings.itemPrefix);
  }

  private get legacyItemPrefix(): string {
    return `${this.folderName}/`;
  }

  private normalizedFolderName(name: string): string {
    const trimmed = name.trim().replace(/^\/+|\/+$/g, '');
    return trimmed || 'ServerCase';
  }

  private normalizedItemName(itemName: string): string {
    const trimmed = itemName.trim().replace(/^\/+|\/+$/g, '');
    const withoutFolder = trimmed.startsWith(this.legacyItemPrefix)
      ? trimmed.slice(this.legacyItemPrefix.length)
      : trimmed;
    return withoutFolder || 'Server';
  }

  // ── crypto ────────────────────────────────────────────────────────────────

  private deriveMasterKey(password: string, kdf: KdfInfo): Buffer {
    const email = this.settings.email.trim().toLowerCase();
    if (kdf.type === 0) {
      return crypto.pbkdf2Sync(
        Buffer.from(password, 'utf8'),
        Buffer.from(email, 'utf8'),
        kdf.iterations,
        32,
        'sha256',
      );
    }
    if (kdf.type === 1) {
      // Bitwarden Argon2id: salt = SHA-256(email), memory in MiB → KiB.
      const salt = crypto.createHash('sha256').update(email, 'utf8').digest();
      const out = argon2id(Buffer.from(password, 'utf8'), salt, {
        t: kdf.iterations,
        m: kdf.memory * 1024,
        p: kdf.parallelism,
        dkLen: 32,
      });
      return Buffer.from(out);
    }
    throw new Error(`unsupported KDF type ${kdf.type}`);
  }

  private encryptField(plaintext: string): string {
    return encryptEncString(plaintext, this.encKey, this.macKey);
  }

  /** The keys to use for a cipher's fields: its own key, or the user key. */
  private cipherKeys(cipher: Cipher): { enc: Buffer; mac: Buffer } {
    if (cipher.key) {
      const raw = tryDecrypt(cipher.key, this.encKey, this.macKey);
      if (raw && raw.length >= 64) {
        return { enc: raw.subarray(0, 32), mac: raw.subarray(32, 64) };
      }
    }
    return { enc: this.encKey, mac: this.macKey };
  }

  /** Decodes a login cipher and joins in its linked SSH-key item, if any. */
  private resolveSecrets(cipher: Cipher, ciphers: Cipher[]): ServerSecrets {
    const secrets = this.decodeSecrets(cipher);
    if (secrets.sshKeyItemName) {
      const keyCipher = this.findCipherByExactName(
        secrets.sshKeyItemName,
        ciphers,
      );
      const privateKey = keyCipher ? this.decodeSSHPrivateKey(keyCipher) : null;
      if (privateKey) {
        secrets.privateKey = privateKey;
        secrets.passphrase = secrets.password;
        secrets.password = undefined;
      }
    }
    return secrets;
  }

  private decodeSecrets(cipher: Cipher): ServerSecrets {
    const keys = this.cipherKeys(cipher);
    // Legacy items stored the whole secrets object as notes JSON.
    const notes = decryptField(cipher.notes, keys.enc, keys.mac);
    if (notes) {
      try {
        return JSON.parse(notes) as ServerSecrets;
      } catch {
        /* fall through */
      }
    }

    let sshKeyItemName: string | undefined;
    for (const field of cipher.fields) {
      const name = decryptField(field.name, keys.enc, keys.mac);
      if (name === 'servercase.sshKeyItemName') {
        sshKeyItemName =
          decryptField(field.value, keys.enc, keys.mac) ?? undefined;
      }
    }

    return {
      username:
        decryptField(cipher.login?.username, keys.enc, keys.mac) ?? undefined,
      password:
        decryptField(cipher.login?.password, keys.enc, keys.mac) ?? undefined,
      sshKeyItemName,
    };
  }

  private decodeSSHPrivateKey(cipher: Cipher): string | null {
    const keys = this.cipherKeys(cipher);
    return decryptField(cipher.sshPrivateKey, keys.enc, keys.mac);
  }

  private encryptedFields(secrets: ServerSecrets): unknown[] | null {
    if (!secrets.sshKeyItemName) return null;
    return [
      {
        name: this.encryptField('servercase.sshKeyItemName'),
        value: this.encryptField(secrets.sshKeyItemName),
        type: 1, // hidden
        linkedId: null,
      },
    ];
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
      if (res.ok) return parseKdf(await res.json());
    } catch {
      /* fall back to defaults below */
    }
    return { type: 0, iterations: 600000, memory: 64, parallelism: 4 };
  }

  private async requestToken(masterPassword: string): Promise<TokenResult> {
    const body =
      this.authMode === 'apiKey'
        ? new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.settings.clientId,
            client_secret: this.settings.clientSecret,
            scope: 'api',
            deviceType: '8', // LinuxDesktop
            deviceIdentifier: this.deviceId,
            deviceName: 'ServerCase',
          })
        : await this.passwordGrantBody(masterPassword);
    const res = await fetch(`${this.identityUrl}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(loginErrorMessage(json));
    const key = pick(json, 'Key', 'key');
    if (typeof key !== 'string') throw new Error('login response missing key');
    return {
      accessToken: String(json.access_token),
      expiresInSec: Number(json.expires_in ?? 3600),
      key,
      kdf: pick(json, 'Kdf', 'kdf') !== undefined ? parseKdf(json) : null,
    };
  }

  private async passwordGrantBody(masterPassword: string): Promise<URLSearchParams> {
    if (!masterPassword) throw new Error('Master password is required');
    const kdf = await this.prelogin();
    const masterKey = this.deriveMasterKey(masterPassword, kdf);
    return new URLSearchParams({
      grant_type: 'password',
      username: this.settings.email.trim(),
      password: masterPasswordHash(masterPassword, masterKey),
      scope: 'api offline_access',
      client_id: 'web',
      deviceType: '8', // LinuxDesktop
      deviceIdentifier: this.deviceId,
      deviceName: 'ServerCase',
    });
  }

  private async fetchSync(): Promise<SyncSnapshot> {
    this.assertUnlocked();
    const sync = (await this.api('GET', '/sync?excludeDomains=true')) as Record<
      string,
      unknown
    >;
    const rawCiphers =
      (pick(sync, 'Ciphers', 'ciphers') as RawObject[] | undefined) ?? [];
    const rawFolders =
      (pick(sync, 'Folders', 'folders') as RawObject[] | undefined) ?? [];
    return {
      ciphers: rawCiphers.map(normalizeCipher),
      folders: rawFolders.map(normalizeFolder),
    };
  }

  private serverCaseFolderId(folders: Folder[]): string | null {
    if (!this.userEncKey || !this.userMacKey) return null;
    const target = this.folderName;
    for (const folder of folders) {
      if (decryptField(folder.name, this.encKey, this.macKey) === target) {
        return folder.id;
      }
    }
    return null;
  }

  private async ensureServerCaseFolderId(): Promise<string> {
    const snapshot = await this.fetchSync();
    const existing = this.serverCaseFolderId(snapshot.folders);
    if (existing) return existing;
    return (await this.createFolder(this.folderName)).id;
  }

  private async setSSHKeyItem(
    itemName: string,
    privateKey: string,
  ): Promise<void> {
    const folderId = await this.ensureServerCaseFolderId();
    const body = {
      type: 5,
      name: this.encryptField(this.normalizedItemName(itemName)),
      notes: null,
      favorite: false,
      folderId,
      organizationId: null,
      sshKey: {
        privateKey: this.encryptField(privateKey),
        publicKey: null,
        keyFingerprint: null,
      },
    };
    const existing = await this.findCipher(itemName);
    if (existing) {
      await this.api('PUT', `/ciphers/${existing.id}`, body);
    } else {
      await this.api('POST', '/ciphers', body);
    }
  }

  private async findCipher(
    itemName: string,
    aliases: string[] = [],
  ): Promise<Cipher | null> {
    const snapshot = await this.fetchSync();
    return this.findCipherIn(itemName, aliases, snapshot.ciphers);
  }

  private findCipherIn(
    itemName: string,
    aliases: string[],
    ciphers: Cipher[],
  ): Cipher | null {
    const primary = this.normalizedItemName(itemName);
    const normalizedAliases = aliases
      .map((a) => this.normalizedItemName(a))
      .filter((a) => a && a !== primary);
    const exactNames = [primary, ...normalizedAliases];
    const legacyNames = exactNames.map((n) => this.legacyItemPrefix + n);

    for (const expected of [...exactNames, ...legacyNames]) {
      const match = this.findCipherByExactName(expected, ciphers);
      if (match) return match;
    }
    return null;
  }

  private findCipherByExactName(
    itemName: string,
    ciphers: Cipher[],
  ): Cipher | null {
    for (const cipher of ciphers) {
      const keys = this.cipherKeys(cipher);
      if (decryptField(cipher.name, keys.enc, keys.mac) === itemName) {
        return cipher;
      }
    }
    return null;
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
  memory: number;
  parallelism: number;
}

interface TokenResult {
  accessToken: string;
  expiresInSec: number;
  key: string;
  kdf: KdfInfo | null;
}

interface CipherLogin {
  username?: string | null;
  password?: string | null;
}

interface CipherField {
  name: string | null;
  value: string | null;
}

interface Cipher {
  id: string;
  type: number;
  name: string | null;
  folderId: string | null;
  notes: string | null;
  key: string | null;
  login?: CipherLogin | null;
  sshPrivateKey: string | null;
  fields: CipherField[];
}

interface Folder {
  id: string;
  name: string | null;
}

interface SyncSnapshot {
  ciphers: Cipher[];
  folders: Folder[];
}

type RawObject = Record<string, unknown>;

function parseKdf(obj: unknown): KdfInfo {
  const o = obj as Record<string, unknown>;
  return {
    type: Number(pick(o, 'Kdf', 'kdf') ?? 0),
    iterations: Number(pick(o, 'KdfIterations', 'kdfIterations') ?? 600000),
    memory: Number(pick(o, 'KdfMemory', 'kdfMemory') ?? 64),
    parallelism: Number(pick(o, 'KdfParallelism', 'kdfParallelism') ?? 4),
  };
}

function loginErrorMessage(json: Record<string, unknown>): string {
  const errorModel = (pick(json, 'ErrorModel', 'errorModel') ?? {}) as RawObject;
  const candidates = [
    json.error_description,
    pick(errorModel, 'Message', 'message'),
    json.message,
    json.error,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
  }
  return 'Bitwarden login failed';
}

function normalizeFolder(raw: RawObject): Folder {
  return {
    id: String(pick(raw, 'Id', 'id')),
    name: (pick(raw, 'Name', 'name') as string | null) ?? null,
  };
}

function normalizeCipher(raw: RawObject): Cipher {
  const login = (pick(raw, 'Login', 'login') as RawObject | undefined) ?? undefined;
  const sshKey =
    (pick(raw, 'SshKey', 'sshKey', 'SSHKey') as RawObject | undefined) ?? undefined;
  const rawFields =
    (pick(raw, 'Fields', 'fields') as RawObject[] | undefined) ?? [];
  return {
    id: String(pick(raw, 'Id', 'id')),
    type: Number(pick(raw, 'Type', 'type') ?? 0),
    name: (pick(raw, 'Name', 'name') as string | null) ?? null,
    folderId: (pick(raw, 'FolderId', 'folderId') as string | null) ?? null,
    notes: (pick(raw, 'Notes', 'notes') as string | null) ?? null,
    key: (pick(raw, 'Key', 'key') as string | null) ?? null,
    login: login
      ? {
          username: (pick(login, 'Username', 'username') as string | null) ?? null,
          password: (pick(login, 'Password', 'password') as string | null) ?? null,
        }
      : null,
    sshPrivateKey: sshKey
      ? ((pick(sshKey, 'PrivateKey', 'privateKey') as string | null) ?? null)
      : null,
    fields: rawFields.map((f) => ({
      name: (pick(f, 'Name', 'name') as string | null) ?? null,
      value: (pick(f, 'Value', 'value') as string | null) ?? null,
    })),
  };
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function masterPasswordHash(masterPassword: string, masterKey: Buffer): string {
  return crypto
    .pbkdf2Sync(
      masterKey,
      Buffer.from(masterPassword, 'utf8'),
      1,
      32,
      'sha256',
    )
    .toString('base64');
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

function decryptField(
  enc: string | null | undefined,
  encKey: Buffer,
  macKey: Buffer,
): string | null {
  const buf = enc ? tryDecrypt(enc, encKey, macKey) : null;
  return buf ? buf.toString('utf8') : null;
}

function tryDecrypt(enc: string, encKey: Buffer, macKey: Buffer): Buffer | null {
  try {
    return decryptEncString(enc, encKey, macKey);
  } catch {
    return null;
  }
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
