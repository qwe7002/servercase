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
  /** Id of the {@link Group} this server belongs to, if any. */
  groupId?: string;
  /** Cloud probe host id to use for overview status instead of SSH polling. */
  probeHostId?: string;
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
  /** Local NIC addresses as "iface address" (scope-global only). */
  ipv4: string[];
  ipv6: string[];
  /** Public addresses as seen from the internet, or null if unavailable. */
  publicIpv4: string | null;
  publicIpv6: string | null;
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

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface PortForwardRequest {
  serverId: string;
  /** Local interface to bind. Defaults to 127.0.0.1. */
  localHost?: string;
  /** Local TCP port. Use 0 to let the OS choose a free port. */
  localPort: number;
  /** Host reached from the remote SSH server. Defaults to 127.0.0.1. */
  remoteHost?: string;
  remotePort: number;
  /** Optional caller-owned label for UI/debug output. */
  label?: string;
}

export interface PortForwardInfo {
  id: string;
  serverId: string;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  label?: string;
  openedAt: number;
}

// ── Local serial console ────────────────────────────────────────────────────

export type SerialTransport = 'wired' | 'ble';

export interface WiredSerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
}

export interface BleSerialDeviceInfo {
  id: string;
  name: string;
  address?: string;
  rssi: number;
  serviceUuids: string[];
}

export interface WiredSerialOpenOptions {
  transport: 'wired';
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'mark' | 'odd' | 'space';
}

export interface BleSerialOpenOptions {
  transport: 'ble';
  peripheralId: string;
  /** UART-like GATT service. Defaults to Nordic UART Service. */
  serviceUuid?: string;
  /** Characteristic the desktop writes to. Defaults to Nordic UART RX. */
  writeCharacteristicUuid?: string;
  /** Characteristic the desktop subscribes to. Defaults to Nordic UART TX. */
  notifyCharacteristicUuid?: string;
}

export type SerialOpenOptions = WiredSerialOpenOptions | BleSerialOpenOptions;

export type SerialConnectionState =
  | 'opening'
  | 'open'
  | 'closed'
  | 'error';

export interface SerialConnectionEvent {
  sessionId: string;
  transport: SerialTransport;
  state: SerialConnectionState;
  error?: string;
}

// ── Global settings ─────────────────────────────────────────────────────────

/** A reusable shell command, runnable in any server's terminal. */
export interface Snippet {
  id: string;
  name: string;
  command: string;
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

/**
 * Optional connection to a ServerCase Worker for cloud config sync and live
 * probe status. The session token is intentionally NOT stored here — it lives
 * in a local-only store and is never written to the sync file. Only the
 * non-secret URL/email/preferences live in settings, so they sync across
 * devices.
 */
export interface CloudSettings {
  enabled: boolean;
  /** Base URL of the worker, e.g. https://worker.example.com */
  url: string;
  /** Account email — display and login convenience (not a secret). */
  email: string;
  /** Push the config to the cloud automatically after local changes. */
  autoPush: boolean;
}

export type TerminalCursorStyle = 'block' | 'underline' | 'bar';
export type TerminalColorScheme = 'charcoal' | 'black' | 'light' | 'solarized';

/** Appearance/behaviour of the SSH terminal, shared across servers and synced. */
export interface TerminalSettings {
  fontSize: number;
  cursorBlink: boolean;
  cursorStyle: TerminalCursorStyle;
  /** Lines of scrollback to keep. */
  scrollback: number;
  colorScheme: TerminalColorScheme;
}

/** A named group/folder used to organize the server list. */
export interface Group {
  id: string;
  name: string;
}

export interface GlobalSettings {
  bitwarden: BitwardenSettings;
  snippets: Snippet[];
  bridge: BridgeSettings;
  cloud: CloudSettings;
  terminal: TerminalSettings;
  groups: Group[];
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
 * Secret-free configuration snapshot synced to the cloud (ServerCase Worker).
 * Secrets are deliberately excluded: with Bitwarden they sync through the
 * vault, and without Bitwarden they are intentionally not portable.
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
  runCommand: 'sc:runCommand',
  shellOpen: 'sc:shell:open',
  shellData: 'sc:shell:data',
  shellResize: 'sc:shell:resize',
  shellClose: 'sc:shell:close',
  portForwardOpen: 'sc:portForward:open',
  portForwardClose: 'sc:portForward:close',
  portForwardList: 'sc:portForward:list',
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
  // local serial console
  serialListPorts: 'sc:serial:listPorts',
  serialScanBle: 'sc:serial:scanBle',
  serialOpen: 'sc:serial:open',
  serialWrite: 'sc:serial:write',
  serialClose: 'sc:serial:close',
  // main -> renderer push channels
  connectionEvent: 'sc:connectionEvent',
  shellOutput: 'sc:shell:output',
  shellClosed: 'sc:shell:closed',
  serialData: 'sc:serial:data',
  serialEvent: 'sc:serial:event',
} as const;
