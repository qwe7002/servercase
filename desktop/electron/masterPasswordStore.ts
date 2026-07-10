import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { MasterPasswordStore } from './bitwarden.js';

/**
 * Persists the Bitwarden master password across launches so the vault can
 * auto-unlock, mirroring the iOS Keychain store. Each password is encrypted
 * with Electron's `safeStorage` (OS keychain / DPAPI / libsecret) and kept in
 * a JSON file keyed by `server|email`. When OS-level encryption is
 * unavailable, nothing is ever written.
 */
export class SafeMasterPasswordStore implements MasterPasswordStore {
  private get file(): string {
    return path.join(app.getPath('userData'), 'bitwarden-master.json');
  }

  load(account: string): string | null {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const encrypted = this.read()[account];
    if (!encrypted) return null;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return null;
    }
  }

  save(account: string, password: string): void {
    if (!safeStorage.isEncryptionAvailable()) return;
    const all = this.read();
    try {
      all[account] = safeStorage.encryptString(password).toString('base64');
      fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
    } catch {
      /* best effort — the user just has to unlock manually next launch */
    }
  }

  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<
        string,
        string
      >;
    } catch {
      return {};
    }
  }
}
