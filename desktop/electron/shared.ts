// Types shared between the Electron main process and the React renderer.
// This file contains no runtime Node/Electron imports so it can be referenced
// from the renderer with `import type`.

export type AuthType = 'password' | 'key';

export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  /** Present when authType === 'password'. */
  password?: string;
  /** PEM private key text, present when authType === 'key'. */
  privateKey?: string;
  /** Optional passphrase protecting the private key. */
  passphrase?: string;
}

export interface DiskUsage {
  mount: string;
  fs: string;
  usedKb: number;
  totalKb: number;
}

export interface ServerStatus {
  /** Aggregate CPU usage percentage 0..100, or null until a second sample. */
  cpuUsage: number | null;
  memUsedKb: number;
  memTotalKb: number;
  swapUsedKb: number;
  swapTotalKb: number;
  disks: DiskUsage[];
  /** Bytes/sec since previous sample, or null until a second sample. */
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
  uptimeSec: number;
  loadAvg: [number, number, number];
  hostname: string;
  kernel: string;
  /** Epoch ms when this status was collected. */
  collectedAt: number;
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface ConnectionEvent {
  serverId: string;
  state: ConnectionState;
  error?: string;
}

// ── Global settings ─────────────────────────────────────────────────────────

/** A reusable shell command, runnable in any server's terminal. */
export interface Snippet {
  id: string;
  name: string;
  command: string;
}

/** Periodic export/import of the configuration to a JSON file on disk. */
export interface AutoSyncSettings {
  enabled: boolean;
  /** Interval between automatic syncs, in minutes. */
  intervalMinutes: number;
  /** Absolute path of the sync file. Empty until the user picks one. */
  filePath: string;
  /** Epoch ms of the last successful sync, if any. */
  lastSyncedAt?: number;
}

export interface BitwardenSettings {
  /**
   * When enabled, server login credentials (username, password, private key,
   * passphrase) are stored in the user's Bitwarden vault — reached directly
   * over the Bitwarden REST API with a clean-room crypto implementation (no
   * `bw` CLI). Bitwarden then becomes the authoritative, end-to-end-encrypted
   * store that syncs secrets across devices. When disabled, secrets live only
   * on this device and are never written to the sync file.
   */
  enabled: boolean;
  /**
   * Base URL of the Bitwarden server. Empty means the official cloud
   * (identity.bitwarden.com / api.bitwarden.com). For self-hosted/Vaultwarden
   * set the base URL; `/identity` and `/api` are appended.
   */
  serverUrl: string;
  /** Account email — used as the KDF salt and for prelogin. */
  email: string;
  /** Personal API key client_id ("user.<guid>"), from the Bitwarden web vault. */
  clientId: string;
  /** Personal API key client_secret. Sensitive; redacted from the sync file. */
  clientSecret: string;
  /** Name prefix for vault items owned by ServerCase. */
  itemPrefix: string;
}

/**
 * Local control bridge: a loopback HTTP endpoint that lets an external MCP
 * server drive the SSH connections ServerCase has already authenticated. The
 * bridge never exposes credentials or the Bitwarden vault — login stays in
 * ServerCase.
 */
export interface BridgeSettings {
  enabled: boolean;
  /** Loopback port to listen on. */
  port: number;
}

export interface GlobalSettings {
  bitwarden: BitwardenSettings;
  snippets: Snippet[];
  autoSync: AutoSyncSettings;
  bridge: BridgeSettings;
}

/** Runtime status of the control bridge, surfaced to the Settings UI. */
export interface BridgeInfo {
  running: boolean;
  port: number;
  /** Bearer token the MCP server must present. Regenerated per session. */
  token: string;
  /** Convenience base URL, e.g. http://127.0.0.1:8765 */
  url: string;
  error?: string;
}

/** A server entry the renderer registers with the bridge (no secrets). */
export interface BridgeServerEntry {
  id: string;
  name: string;
  host: string;
}

/**
 * The login credentials for a server. Stored in Bitwarden when the Bitwarden
 * vault is enabled, otherwise persisted locally with the server definition.
 */
export interface ServerSecrets {
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export type BitwardenLockState = 'unauthenticated' | 'locked' | 'unlocked';

/** Runtime status of the Bitwarden CLI integration. */
export interface BitwardenStatus {
  /** Whether the `bw` CLI was found and is runnable. */
  available: boolean;
  state: BitwardenLockState;
  serverUrl?: string;
  userEmail?: string;
  /** Populated when a command failed (e.g. CLI missing). */
  error?: string;
}

/**
 * Snapshot exchanged with the sync file. Secrets are deliberately excluded:
 * with Bitwarden they sync through the vault, and without Bitwarden they are
 * intentionally not portable.
 */
export interface SyncPayload {
  version: 1;
  exportedAt: number;
  /** Server definitions with all secret fields stripped. */
  servers: ServerConfig[];
  settings: GlobalSettings;
}

// ── SFTP ────────────────────────────────────────────────────────────────────

export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface SftpEntry {
  name: string;
  /** Full POSIX path of the entry. */
  path: string;
  type: SftpEntryType;
  sizeBytes: number;
  /** Modification time, epoch ms. */
  modifiedAt: number;
  /** POSIX permission bits as an octal string, e.g. "0644". */
  mode: string;
}

export interface SftpList {
  path: string;
  entries: SftpEntry[];
}

/** Channel names used across the IPC bridge. */
export const IpcChannels = {
  connect: 'sc:connect',
  disconnect: 'sc:disconnect',
  fetchStatus: 'sc:fetchStatus',
  shellOpen: 'sc:shell:open',
  shellData: 'sc:shell:data',
  shellResize: 'sc:shell:resize',
  shellClose: 'sc:shell:close',
  // bitwarden secret vault (via `bw` CLI)
  bwStatus: 'sc:bw:status',
  bwConfigure: 'sc:bw:configure',
  bwUnlock: 'sc:bw:unlock',
  bwLock: 'sc:bw:lock',
  bwSync: 'sc:bw:sync',
  bwTest: 'sc:bw:test',
  bwSet: 'sc:bw:set',
  bwGet: 'sc:bw:get',
  bwList: 'sc:bw:list',
  bwDelete: 'sc:bw:delete',
  // sync
  syncExport: 'sc:sync:export',
  syncImport: 'sc:sync:import',
  syncPickFile: 'sc:sync:pickFile',
  // control bridge (for the MCP server)
  bridgeInfo: 'sc:bridge:info',
  bridgeSetEnabled: 'sc:bridge:setEnabled',
  bridgeRegister: 'sc:bridge:register',
  bridgeConnectRequest: 'sc:bridge:connectRequest',
  // sftp
  sftpList: 'sc:sftp:list',
  sftpReadText: 'sc:sftp:readText',
  sftpWriteText: 'sc:sftp:writeText',
  sftpMkdir: 'sc:sftp:mkdir',
  sftpRename: 'sc:sftp:rename',
  sftpRemove: 'sc:sftp:remove',
  sftpDownload: 'sc:sftp:download',
  sftpUpload: 'sc:sftp:upload',
  // main -> renderer push channels
  connectionEvent: 'sc:connectionEvent',
  shellOutput: 'sc:shell:output',
  shellClosed: 'sc:shell:closed',
} as const;
