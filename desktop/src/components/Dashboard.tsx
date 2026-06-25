import { useState } from 'react';
import type { ServerConfig } from '../../electron/shared';
import { useServers } from '../store/servers';
import {
  formatKb,
  formatRate,
  formatUptime,
  percent,
} from '../format';
import { Gauge, UsageBar } from './StatusCard';
import { Terminal } from './Terminal';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, Network, ServerIcon, Timer } from 'lucide-react';

interface Props {
  server: ServerConfig;
}

type Tab = 'overview' | 'terminal';

export function Dashboard({ server }: Props) {
  const connState = useServers((s) => s.connState[server.id]) ?? 'disconnected';
  const status = useServers((s) => s.status[server.id]);
  const lastError = useServers((s) => s.lastError[server.id]);
  const setConnState = useServers((s) => s.setConnState);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    const api = window.servercase;
    if (!api) return;
    setBusy(true);
    setConnState(server.id, 'connecting');
    try {
      await api.connect(server);
    } catch (e) {
      setConnState(server.id, 'error', (e as Error).message);
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
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
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
          <Terminal serverId={server.id} />
        ) : (
          <Placeholder>Connect to open a terminal.</Placeholder>
        )
      ) : !connected ? (
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
                  icon={Network}
                  label="Net ↓"
                  value={formatRate(status.netRxBytesPerSec)}
                />
                <Metric
                  icon={Network}
                  label="Net ↑"
                  value={formatRate(status.netTxBytesPerSec)}
                />
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
        </div>
      )}
    </main>
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
