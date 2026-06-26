import type { DiskUsage, ServerStatus } from '../shared.js';

/**
 * A single portable shell command that dumps the raw kernel counters we need.
 * We parse everything client-side so the remote host only needs coreutils +
 * a Linux /proc filesystem. Sections are delimited by `===name===` markers.
 */
export const STATUS_COMMAND = [
  'echo "===stat==="; cat /proc/stat | grep "^cpu "',
  'echo "===mem==="; cat /proc/meminfo',
  'echo "===net==="; cat /proc/net/dev',
  'echo "===uptime==="; cat /proc/uptime',
  'echo "===load==="; cat /proc/loadavg',
  'echo "===disk==="; df -k -P 2>/dev/null',
  'echo "===ip==="; ip -o addr show scope global 2>/dev/null',
  'echo "===host==="; uname -r; hostname',
].join('; ');

interface CpuSample {
  total: number;
  idle: number;
}

interface NetSample {
  rx: number;
  tx: number;
  at: number;
}

/** Per-server state needed to compute deltas between polls. */
export interface CollectorState {
  cpu?: CpuSample;
  net?: NetSample;
}

function section(raw: string, name: string): string {
  const start = raw.indexOf(`===${name}===`);
  if (start === -1) return '';
  const from = raw.indexOf('\n', start) + 1;
  const next = raw.indexOf('===', from);
  return raw.slice(from, next === -1 ? undefined : next);
}

function parseCpu(raw: string): CpuSample | undefined {
  // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
  const line = section(raw, 'stat').trim();
  if (!line.startsWith('cpu')) return undefined;
  const nums = line
    .replace(/^cpu\s+/, '')
    .split(/\s+/)
    .map(Number);
  if (nums.length < 4 || nums.some(Number.isNaN)) return undefined;
  const idle = nums[3] + (nums[4] ?? 0); // idle + iowait
  const total = nums.reduce((a, b) => a + b, 0);
  return { total, idle };
}

function parseMem(raw: string): {
  memUsedKb: number;
  memTotalKb: number;
  swapUsedKb: number;
  swapTotalKb: number;
} {
  const map = new Map<string, number>();
  for (const line of section(raw, 'mem').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) map.set(m[1], Number(m[2]));
  }
  const memTotal = map.get('MemTotal') ?? 0;
  const memAvailable =
    map.get('MemAvailable') ??
    (map.get('MemFree') ?? 0) +
      (map.get('Buffers') ?? 0) +
      (map.get('Cached') ?? 0);
  const swapTotal = map.get('SwapTotal') ?? 0;
  const swapFree = map.get('SwapFree') ?? 0;
  return {
    memTotalKb: memTotal,
    memUsedKb: Math.max(0, memTotal - memAvailable),
    swapTotalKb: swapTotal,
    swapUsedKb: Math.max(0, swapTotal - swapFree),
  };
}

function parseNet(raw: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of section(raw, 'net').split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const iface = line.slice(0, idx).trim();
    if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth'))
      continue;
    const cols = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    if (cols.length < 9) continue;
    rx += cols[0]; // received bytes
    tx += cols[8]; // transmitted bytes
  }
  return { rx, tx };
}

function parseUptime(raw: string): number {
  const v = Number(section(raw, 'uptime').trim().split(/\s+/)[0]);
  return Number.isFinite(v) ? v : 0;
}

function parseLoad(raw: string): [number, number, number] {
  const p = section(raw, 'load').trim().split(/\s+/).map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}

function parseDisk(raw: string): DiskUsage[] {
  const out: DiskUsage[] = [];
  const lines = section(raw, 'disk').trim().split('\n');
  for (const line of lines.slice(1)) {
    // Filesystem 1024-blocks Used Available Capacity Mounted-on
    const c = line.trim().split(/\s+/);
    if (c.length < 6) continue;
    const fs = c[0];
    if (
      fs === 'tmpfs' ||
      fs === 'devtmpfs' ||
      fs === 'overlay' ||
      fs.startsWith('/dev/loop')
    )
      continue;
    const totalKb = Number(c[1]);
    const usedKb = Number(c[2]);
    const mount = c[c.length - 1];
    if (!Number.isFinite(totalKb) || totalKb === 0) continue;
    out.push({ fs, mount, usedKb, totalKb });
  }
  return out;
}

function parseIp(raw: string): { ipv4: string[]; ipv6: string[] } {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const line of section(raw, 'ip').split('\n')) {
    // "2: eth0    inet 10.0.0.5/24 brd ... scope global eth0 ..."
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const iface = parts[1];
    if (
      iface === 'lo' ||
      iface.startsWith('docker') ||
      iface.startsWith('veth') ||
      iface.startsWith('br-')
    )
      continue;
    const address = parts[3].split('/')[0];
    if (parts[2] === 'inet') ipv4.push(`${iface} ${address}`);
    else if (parts[2] === 'inet6') ipv6.push(`${iface} ${address}`);
  }
  return { ipv4, ipv6 };
}

function parseHost(raw: string): { kernel: string; hostname: string } {
  const lines = section(raw, 'host').trim().split('\n');
  return { kernel: (lines[0] ?? '').trim(), hostname: (lines[1] ?? '').trim() };
}

/**
 * Parse a raw status dump into a ServerStatus, updating `state` in place so the
 * next call can compute CPU% and network throughput deltas.
 */
export function parseStatus(raw: string, state: CollectorState): ServerStatus {
  const now = Date.now();
  const mem = parseMem(raw);
  const cpuSample = parseCpu(raw);
  const netSample = parseNet(raw);

  let cpuUsage: number | null = null;
  if (cpuSample && state.cpu) {
    const dTotal = cpuSample.total - state.cpu.total;
    const dIdle = cpuSample.idle - state.cpu.idle;
    if (dTotal > 0) {
      cpuUsage = Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100));
    }
  }
  if (cpuSample) state.cpu = cpuSample;

  let netRx: number | null = null;
  let netTx: number | null = null;
  if (state.net) {
    const dt = (now - state.net.at) / 1000;
    if (dt > 0) {
      netRx = Math.max(0, (netSample.rx - state.net.rx) / dt);
      netTx = Math.max(0, (netSample.tx - state.net.tx) / dt);
    }
  }
  state.net = { ...netSample, at: now };

  const host = parseHost(raw);
  const ip = parseIp(raw);
  return {
    cpuUsage,
    ...mem,
    disks: parseDisk(raw),
    netRxBytesPerSec: netRx,
    netTxBytesPerSec: netTx,
    ipv4: ip.ipv4,
    ipv6: ip.ipv6,
    publicIpv4: null,
    publicIpv6: null,
    uptimeSec: parseUptime(raw),
    loadAvg: parseLoad(raw),
    hostname: host.hostname,
    kernel: host.kernel,
    collectedAt: now,
  };
}
