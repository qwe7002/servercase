import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Activity, Copy, Plus, RadioTower, Server, Trash2 } from 'lucide-react';
import { useSettings } from '../store/settings';
import { useCloud } from '../store/cloud';
import { useProbes, type ProbeHostView } from '../store/probes';
import { useServers } from '../store/servers';
import { cloudApi, CloudError } from '../lib/cloud';
import { connectServer } from '../lib/connect';
import { buildProbeInstallCommand } from '../lib/probeInstall';
import type { StreamStatus } from '../lib/cloudStream';
import { formatKb, formatUptime, percent } from '../format';

function relativeTime(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Live probe-host list: REST for the roster, WebSocket for live updates. */
export function CloudProbes() {
  const url = useSettings((s) => s.settings.cloud.url);
  const token = useCloud((s) => s.token);
  const hosts = useProbes((s) => s.hosts);
  const status = useProbes((s) => s.streamStatus);
  const setHosts = useProbes((s) => s.setHosts);
  const removeProbeHost = useProbes((s) => s.removeHost);
  const servers = useServers((s) => s.servers);
  const selectedId = useServers((s) => s.selectedId);
  const connState = useServers((s) => s.connState);
  const updateServer = useServers((s) => s.updateServer);

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{
    id: string;
    name: string;
    token: string;
  } | null>(null);
  // Re-render once a second so "last seen" stays fresh.
  const [, force] = useState(0);
  const tickRef = useRef(0);

  const refresh = async () => {
    if (!token) return;
    try {
      const res = await cloudApi.listProbes(url, token);
      setHosts(res.hosts);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // Re-render once a second so relative timestamps stay fresh.
  useEffect(() => {
    const ticker = setInterval(() => force((tickRef.current += 1)), 1000);
    return () => {
      clearInterval(ticker);
    };
  }, []);

  const addHost = async () => {
    if (!token || !name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await cloudApi.createProbe(url, token, name.trim());
      setNewToken({ id: res.host.id, name: res.host.name, token: res.token });
      setName('');
      await refresh();
    } catch (e) {
      setErr(e instanceof CloudError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selectedServer = servers.find((server) => server.id === selectedId);

  const installOnSelected = async () => {
    const api = window.servercase;
    if (!api || !newToken || !selectedServer || !url) return;
    setInstalling(true);
    setErr(null);
    setInstallLog(null);
    try {
      if (connState[selectedServer.id] !== 'connected') {
        await connectServer(selectedServer);
      }
      const command = buildProbeInstallCommand(url, newToken.token);
      const result = await api.runCommand(selectedServer.id, command);
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
      setInstallLog(output || 'Install command completed.');
      if (result.code && result.code !== 0) {
        throw new Error(`Install exited with code ${result.code}`);
      }
      updateServer({ ...selectedServer, probeHostId: newToken.id });
      setNewToken(null);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  const removeHost = async (id: string) => {
    if (!token) return;
    setBusy(true);
    try {
      await cloudApi.deleteProbe(url, token, id);
      removeProbeHost(id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Probe hosts</span>
        <StreamBadge status={status} />
      </div>

      <div className="flex gap-2">
        <Input
          placeholder="New host name, e.g. web-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addHost()}
        />
        <Button onClick={() => void addHost()} disabled={busy || !name.trim()}>
          <Plus /> Add host
        </Button>
      </div>

      {newToken && (
        <Alert>
          <RadioTower className="size-4" />
          <AlertTitle>Probe token for “{newToken.name}”</AlertTitle>
          <AlertDescription className="grid gap-2">
            <p className="text-xs text-muted-foreground">
              Copy it now — it is shown only once. Deploy with it using{' '}
              <code>probe/deploy/install.sh --token …</code>.
            </p>
            <div className="flex gap-2">
              <Input readOnly value={newToken.token} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                onClick={() => void navigator.clipboard?.writeText(newToken.token)}
              >
                <Copy />
              </Button>
            </div>
            <div>
              <Button
                size="sm"
                onClick={() => void installOnSelected()}
                disabled={installing || !selectedServer}
              >
                {installing
                  ? 'Installing…'
                  : selectedServer
                    ? `Install on ${selectedServer.name}`
                    : 'Select a server first'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setNewToken(null)}>
                Done
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {installLog && (
        <pre className="max-h-36 overflow-auto rounded border bg-muted/30 p-2 text-xs">
          {installLog}
        </pre>
      )}

      {hosts.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">
          No probe hosts yet. Add one, then deploy the agent with its token.
        </p>
      ) : (
        <div className="grid gap-2">
          {hosts.map((h) => (
            <HostCard key={h.id} host={h} onRemove={() => void removeHost(h.id)} />
          ))}
        </div>
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

function StreamBadge({ status }: { status: StreamStatus }) {
  if (status === 'open')
    return (
      <Badge className="gap-1">
        <Activity className="size-3" /> live
      </Badge>
    );
  return (
    <Badge variant="secondary">
      {status === 'connecting' ? 'connecting…' : 'offline'}
    </Badge>
  );
}

function HostCard({ host, onRemove }: { host: ProbeHostView; onRemove: () => void }) {
  const snap = host.snapshot;
  // Online if a snapshot arrived within ~3 intervals.
  const online = !!host.lastSeenAt && Date.now() - host.lastSeenAt < 30_000;

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Server className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{host.name}</span>
            <span
              className={`size-2 shrink-0 rounded-full ${
                online ? 'bg-emerald-500' : 'bg-muted-foreground/40'
              }`}
              title={online ? 'online' : 'offline'}
            />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {snap
              ? `${snap.hostname || '—'} · ${snap.kernel || '—'} · up ${formatUptime(snap.uptime_sec)}`
              : 'waiting for first snapshot…'}
          </p>
        </div>

        <div className="flex items-center gap-4">
          {snap && (
            <div className="hidden gap-4 text-right text-xs sm:flex">
              <Metric
                label="CPU"
                value={snap.cpu_usage == null ? '–' : `${Math.round(snap.cpu_usage)}%`}
              />
              <Metric
                label="MEM"
                value={`${Math.round(
                  percent(snap.memory.mem_used_kb, snap.memory.mem_total_kb),
                )}%`}
                sub={`${formatKb(snap.memory.mem_used_kb)} / ${formatKb(snap.memory.mem_total_kb)}`}
              />
              <Metric label="Seen" value={relativeTime(host.lastSeenAt)} />
            </div>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            title="Remove host"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-medium tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
