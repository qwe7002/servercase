import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Activity, Copy, Plus, RadioTower, Server, Trash2 } from 'lucide-react';
import { useSettings } from '../store/settings';
import { useCloud } from '../store/cloud';
import { cloudApi, CloudError, type ProbeHost } from '../lib/cloud';
import {
  openProbeStream,
  type ProbeSnapshotV1,
  type StreamStatus,
} from '../lib/cloudStream';
import { formatKb, formatUptime, percent } from '../format';

interface HostView {
  id: string;
  name: string;
  lastSeenAt: number | null;
  snapshot: ProbeSnapshotV1 | null;
}

function toView(h: ProbeHost): HostView {
  return {
    id: h.id,
    name: h.name,
    lastSeenAt: h.lastSeenAt,
    snapshot: (h.latest as ProbeSnapshotV1 | null) ?? null,
  };
}

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

  const [hosts, setHosts] = useState<HostView[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  // Re-render once a second so "last seen" stays fresh.
  const [, force] = useState(0);
  const tickRef = useRef(0);

  const refresh = async () => {
    if (!token) return;
    try {
      const res = await cloudApi.listProbes(url, token);
      setHosts(res.hosts.map(toView));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // Initial roster + live stream.
  useEffect(() => {
    if (!token || !url) return;
    void refresh();
    const stream = openProbeStream(url, token, {
      onStatus: setStatus,
      onSnapshot: (hostId, snapshot) =>
        setHosts((prev) =>
          prev.map((h) =>
            h.id === hostId ? { ...h, snapshot, lastSeenAt: Date.now() } : h,
          ),
        ),
    });
    const ticker = setInterval(() => force((tickRef.current += 1)), 1000);
    return () => {
      stream.close();
      clearInterval(ticker);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token]);

  const addHost = async () => {
    if (!token || !name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await cloudApi.createProbe(url, token, name.trim());
      setNewToken({ name: res.host.name, token: res.token });
      setName('');
      await refresh();
    } catch (e) {
      setErr(e instanceof CloudError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeHost = async (id: string) => {
    if (!token) return;
    setBusy(true);
    try {
      await cloudApi.deleteProbe(url, token, id);
      setHosts((prev) => prev.filter((h) => h.id !== id));
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
              <code>deploy/install.sh --token …</code>.
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
              <Button variant="ghost" size="sm" onClick={() => setNewToken(null)}>
                Done
              </Button>
            </div>
          </AlertDescription>
        </Alert>
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

function HostCard({ host, onRemove }: { host: HostView; onRemove: () => void }) {
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
