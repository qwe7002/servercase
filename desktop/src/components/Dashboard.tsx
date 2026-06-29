import { useEffect, useState } from 'react';
import type { ServerConfig } from '../../electron/shared';
import { useServers } from '../store/servers';
import { useProbes } from '../store/probes';
import { useSettings } from '../store/settings';
import { useCloud, hasValidSession } from '../store/cloud';
import { formatKb, formatUptime, percent } from '../format';
import { statusFromProbe } from '../lib/probeStatus';
import { Gauge, UsageBar } from './StatusCard';
import { TerminalTabs } from './TerminalTabs';
import { Sftp } from './Sftp';
import { PortForwards } from './PortForwards';
import { connectServer } from '../lib/connect';
import { cloudApi, CloudError } from '../lib/cloud';
import { buildProbeInstallCommand } from '../lib/probeInstall';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, Loader2, RadioTower, ServerIcon, Timer } from 'lucide-react';

interface Props {
  server: ServerConfig;
}

type Tab = 'overview' | 'terminal' | 'files' | 'forwarding';

export function Dashboard({ server }: Props) {
  const connState = useServers((s) => s.connState[server.id]) ?? 'disconnected';
  const sshStatus = useServers((s) => s.status[server.id]);
  const probeHost = useProbes((s) =>
    server.probeHostId ? s.hosts.find((host) => host.id === server.probeHostId) : undefined,
  );
  const setProbeHosts = useProbes((s) => s.setHosts);
  const probeStatus = probeHost?.snapshot
    ? statusFromProbe(probeHost.snapshot)
    : undefined;
  const status = probeStatus ?? sshStatus;
  const lastError = useServers((s) => s.lastError[server.id]);
  const updateServer = useServers((s) => s.updateServer);
  const cloudUrl = useSettings((s) => s.settings.cloud.url);
  const cloudToken = useCloud((s) => s.token);
  const cloudExpiresAt = useCloud((s) => s.expiresAt);
  const [tab, setTab] = useState<Tab>('overview');
  const [installingProbe, setInstallingProbe] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState<{
    name: string;
    token: string;
  } | null>(null);

  useEffect(() => {
    const current = useServers.getState().connState[server.id] ?? 'disconnected';
    if (current === 'disconnected') {
      void connectServer(server).catch(() => undefined);
    }
  }, [server]);

  const connected = connState === 'connected';
  const usesProbe = !!server.probeHostId;
  const probeWaiting = usesProbe && !probeStatus;
  const canInstallProbe =
    !!cloudUrl &&
    hasValidSession({ token: cloudToken, expiresAt: cloudExpiresAt }) &&
    !!cloudToken &&
    !installingProbe;

  const installProbe = async () => {
    const api = window.servercase;
    if (!api || !cloudToken || !cloudUrl) return;
    setInstallingProbe(true);
    setInstallError(null);
    setInstallMessage(null);
    try {
      const probeName = server.host.trim();
      const created = await cloudApi.createProbe(cloudUrl, cloudToken, probeName);
      setManualToken({ name: created.host.name, token: created.token });
      const current = useServers.getState().connState[server.id] ?? 'disconnected';
      if (current !== 'connected') {
        await connectServer(server);
      }
      const result = await api.runCommand(
        server.id,
        buildProbeInstallCommand(cloudUrl, created.token, probeName),
      );
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
      if (result.code && result.code !== 0) {
        throw new Error(output || `Install exited with code ${result.code}`);
      }
      updateServer({ ...server, probeHostId: created.host.id });
      const probes = await cloudApi.listProbes(cloudUrl, cloudToken);
      setProbeHosts(probes.hosts);
      setManualToken(null);
      setInstallMessage(output || 'Probe installed.');
    } catch (e) {
      setInstallError(e instanceof CloudError ? e.message : (e as Error).message);
    } finally {
      setInstallingProbe(false);
    }
  };

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
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="forwarding">Forwarding</TabsTrigger>
          </TabsList>
        </Tabs>
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
          <Placeholder>
            {connState === 'connecting'
              ? 'Establishing SSH connection…'
              : 'SSH connection is offline. Use Reconnect from the server list menu.'}
          </Placeholder>
        )
      ) : tab === 'files' ? (
        connected ? (
          <Sftp serverId={server.id} />
        ) : (
          <Placeholder>
            {connState === 'connecting'
              ? 'Establishing SSH connection…'
              : 'SSH connection is offline. Use Reconnect from the server list menu.'}
          </Placeholder>
        )
      ) : tab === 'forwarding' ? (
        connected ? (
          <PortForwards server={server} />
        ) : (
          <Placeholder>
            {connState === 'connecting'
              ? 'Establishing SSH connection…'
              : 'SSH connection is offline. Use Reconnect from the server list menu.'}
          </Placeholder>
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
            : 'SSH connection is offline. Use Reconnect from the server list menu.'}
        </Placeholder>
      ) : !status ? (
        <Placeholder>Collecting status…</Placeholder>
      ) : (
        <div className="grid flex-1 grid-cols-2 gap-4 overflow-y-auto p-6">
          {!usesProbe && (
            <Alert className="col-span-2">
              <RadioTower />
              <AlertTitle>Probe not installed</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  Install a lightweight probe on this server to keep Overview
                  updated without SSH polling.
                </span>
                <Button
                  variant="outline"
                  onClick={() => void installProbe()}
                  disabled={!canInstallProbe}
                  title={
                    canInstallProbe
                      ? 'Install probe on this server'
                      : 'Sign in to ServerCase Cloud first'
                  }
                >
                  {installingProbe ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RadioTower />
                  )}
                  {installingProbe ? 'Installing…' : 'Install probe'}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {installError && (
            <Alert variant="destructive" className="col-span-2">
              <AlertCircle />
              <AlertTitle>Probe install failed</AlertTitle>
              <AlertDescription className="grid gap-2">
                <span>{installError}</span>
                {manualToken && (
                  <>
                    <span className="text-xs">
                      A probe host was created for {manualToken.name}. Copy this
                      one-time token if you want to deploy it manually.
                    </span>
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        value={manualToken.token}
                        className="font-mono text-xs"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void navigator.clipboard?.writeText(manualToken.token)
                        }
                      >
                        Copy
                      </Button>
                    </div>
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}

          {installMessage && (
            <Alert className="col-span-2">
              <RadioTower />
              <AlertTitle>Probe installed</AlertTitle>
              <AlertDescription>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs">
                  {installMessage}
                </pre>
              </AlertDescription>
            </Alert>
          )}

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
