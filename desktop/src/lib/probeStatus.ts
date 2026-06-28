import type { ServerStatus } from '../../electron/shared';
import type { ProbeSnapshotV1 } from './cloudStream';

function interfaceAddresses(
  interfaces: ProbeSnapshotV1['network']['interfaces'],
  family: 'ipv4' | 'ipv6',
): string[] {
  return (interfaces ?? []).flatMap((iface) =>
    iface[family].map((address) => `${iface.name} ${address}`),
  );
}

/** Adapts a servercase.probe.v1 snapshot to the overview's ServerStatus shape. */
export function statusFromProbe(snapshot: ProbeSnapshotV1): ServerStatus {
  return {
    cpuUsage: snapshot.cpu_usage,
    memTotalKb: snapshot.memory.mem_total_kb,
    memUsedKb: snapshot.memory.mem_used_kb,
    swapTotalKb: snapshot.memory.swap_total_kb,
    swapUsedKb: snapshot.memory.swap_used_kb,
    disks: snapshot.disks.map((disk) => ({
      mount: disk.mount,
      fs: disk.fs,
      usedKb: disk.used_kb,
      totalKb: disk.total_kb,
    })),
    netRxBytesPerSec: snapshot.network.rx_bytes_per_sec,
    netTxBytesPerSec: snapshot.network.tx_bytes_per_sec,
    ipv4: interfaceAddresses(snapshot.network.interfaces, 'ipv4'),
    ipv6: interfaceAddresses(snapshot.network.interfaces, 'ipv6'),
    publicIpv4: snapshot.network.public_ipv4,
    publicIpv6: snapshot.network.public_ipv6 ?? null,
    uptimeSec: snapshot.uptime_sec,
    loadAvg: snapshot.load_avg,
    hostname: snapshot.hostname,
    kernel: snapshot.kernel,
    collectedAt: snapshot.collected_at_ms,
  };
}
