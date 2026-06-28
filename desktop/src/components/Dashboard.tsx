import { useState } from 'react';
import type { ServerConfig } from '../../electron/shared';
import { useServers } from '../store/servers';
import { useProbes } from '../store/probes';
import { formatKb, formatUptime, percent } from '../format';
import { statusFromProbe } from '../lib/probeStatus';
import { Gauge, UsageBar } from './StatusCard';
import { TerminalTabs } from './TerminalTabs';
import { Sftp } from './Sftp';
import { connectServer } from '../lib/connect';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, ServerIcon, Timer } from 'lucide-react';

interface Props {
  server: ServerConfig;
}

type Tab = 'overview' | 'terminal' | 'files';

export function Dashboard({ server }: Props) {
  const connState = useServers((s) => s.connState[server.id]) ?? 'disconnected';
  const sshStatus = useServers((s) => s.status[server.id]);
  const probeHost = useProbes((s) =>
    server.probeHostId ? s.hosts.find((host) => host.id === server.probeHostId) : undefined,
  );
  const probeStatus = probeHost?.snapshot
    ? statusFromProbe(probeHost.snapshot)
    : undefined;
  const status = probeStatus ?? sshStatus;
  const lastError = useServers((s) => s.lastError[server.id]);
  const setConnState = useServers((s) => s.setConnState);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    try {
      await connectServer(server);
    } catch {
      // Error state is already set by connectServer.
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const api = window.servercase;
    if (!api) return;
    await api.disconnect(server.id);
    setConnState(server.id, 'disconnected');
  };

  const connected = connState === 'connected';
  const usesProbe = !!server.probeHostId;
  const probeWaiting = usesProbe && !probeStatus;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex min-h-16 items-center justify-between gap-6 border-b px-6 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">
            {server.name}
          </h1>
          <p className="truncate text-sm text-muted-foreground">
            {server.username}@{server.host}:{server.port}
            {status?.kernel ? ` · ${status.kernel}` : ''}
            {probeStatus ? ` · probe: ${probeHost?.name ?? 'linked'}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
            </TabsList>
          </Tabs>
          {connected ? (
            <Button variant="outline" onClick={disconnect}>
              Disconnect
            </Button>
          ) : (
            <Button onClick={connect} disabled={busy}>
              {connState === 'connecting' ? 'Connecting…' : 'Connect'}
            </Button>
          )}
        </div>
      </header>

      {connState === 'error' && lastError && (
        <Alert variant="destructive" className="mx-6 mt-4 w-auto">
          <AlertCircle />
          <AlertTitle>Connection failed</AlertTitle>
          <AlertDescription>{lastError}</AlertDescription>
        </Alert>
      )}

      {tab === 'terminal' ? (
        connected ? (
          <TerminalTabs serverId={server.id} />
        ) : (
          <Placeholder>Connect to open a terminal.</Placeholder>
        )
      ) : tab === 'files' ? (
        connected ? (
          <Sftp serverId={server.id} />
        ) : (
          <Placeholder>Connect to browse files over SFTP.</Placeholder>
        )
      ) : probeWaiting ? (
        <Placeholder>
          {probeHost
            ? 'Waiting for the linked probe to report status…'
            : 'Linked probe host was not found. Choose another probe in Edit server.'}
        </Placeholder>
      ) : !connected && !probeStatus ? (
        <Placeholder>
          {connState === 'connecting'
            ? 'Establishing SSH connection…'
            : 'Not connected. Press Connect to view live status.'}
        </Placeholder>
      ) : !status ? (
        <Placeholder>Collecting status…</Placeholder>
      ) : (
        <div className="grid flex-1 grid-cols-2 gap-4 overflow-y-auto p-6">
          <section className="col-span-2 flex flex-wrap gap-4">
            <Gauge
              label="CPU"
              value={status.cpuUsage}
              caption={`load ${status.loadAvg.map((n) => n.toFixed(2)).join(' ')}`}
            />
            <Gauge
              label="Memory"
              value={percent(status.memUsedKb, status.memTotalKb)}
              caption={`${formatKb(status.memUsedKb)} / ${formatKb(status.memTotalKb)}`}
            />
            <Card className="min-w-64 flex-1">
              <CardContent className="grid h-full grid-cols-2 gap-5 p-5">
                <Metric icon={Timer} label="Uptime" value={formatUptime(status.uptimeSec)} />
                <Metric
                  icon={ServerIcon}
                  label="Host"
                  value={status.hostname || '–'}
                />
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Memory</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <UsageBar
                label="RAM"
                used={status.memUsedKb}
                total={status.memTotalKb}
                format={formatKb}
                pct={percent(status.memUsedKb, status.memTotalKb)}
              />
              {status.swapTotalKb > 0 && (
                <UsageBar
                  label="Swap"
                  used={status.swapUsedKb}
                  total={status.swapTotalKb}
                  format={formatKb}
                  pct={percent(status.swapUsedKb, status.swapTotalKb)}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Disks</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {status.disks.length === 0 && (
                <span className="text-sm text-muted-foreground">
                  No mounts reported.
                </span>
              )}
              {status.disks.map((d) => (
                <UsageBar
                  key={d.mount}
                  label={`${d.mount} (${d.fs})`}
                  used={d.usedKb}
                  total={d.totalKb}
                  format={formatKb}
                  pct={percent(d.usedKb, d.totalKb)}
                />
              ))}
            </CardContent>
          </Card>

          <Card className="col-span-2">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Network</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
              <IpBlock label="NIC IPv4" items={status.ipv4} />
              <IpBlock label="NIC IPv6" items={status.ipv6} />
              <IpBlock
                label="External IPv4"
                items={status.publicIpv4 ? [status.publicIpv4] : []}
              />
              <IpBlock
                label="External IPv6"
                items={status.publicIpv6 ? [status.publicIpv6] : []}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}

function IpBlock({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      {items.length === 0 ? (
        <div className="text-muted-foreground">–</div>
      ) : (
        items.map((value) => (
          <div key={value} className="truncate font-mono text-xs" title={value}>
            {value}
          </div>
        ))
      )}
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-10 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Timer;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate font-medium">{value}</div>
      </div>
    </div>
  );
}
