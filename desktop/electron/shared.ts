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

/** Channel names used across the IPC bridge. */
export const IpcChannels = {
  connect: 'sc:connect',
  disconnect: 'sc:disconnect',
  fetchStatus: 'sc:fetchStatus',
  shellOpen: 'sc:shell:open',
  shellData: 'sc:shell:data',
  shellResize: 'sc:shell:resize',
  shellClose: 'sc:shell:close',
  // main -> renderer push channels
  connectionEvent: 'sc:connectionEvent',
  shellOutput: 'sc:shell:output',
  shellClosed: 'sc:shell:closed',
} as const;
