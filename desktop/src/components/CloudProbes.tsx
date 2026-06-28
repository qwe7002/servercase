import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Activity, Server, Trash2 } from 'lucide-react';
import { useSettings } from '../store/settings';
import { useCloud } from '../store/cloud';
import { useProbes, type ProbeHostView } from '../store/probes';
import { cloudApi } from '../lib/cloud';
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

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Re-render once a second so "last seen" stays fresh.
  const [, force] = useState(0);
  const tickRef = useRef(0);

  // Re-render once a second so relative timestamps stay fresh.
  useEffect(() => {
    const ticker = setInterval(() => force((tickRef.current += 1)), 1000);
    return () => {
      clearInterval(ticker);
    };
  }, []);

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

      <p className="px-1 text-xs text-muted-foreground">
        Probes are installed automatically over SSH — open a server Overview and
        use Install probe. There is no manual token registration.
      </p>

      {hosts.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">
          No probe hosts yet. Install one from a server Overview.
        </p>
      ) : (
        <div className="grid gap-2">
          {hosts.map((h) => (
            <HostCard
              key={h.id}
              host={h}
              busy={busy}
              onRemove={() => void removeHost(h.id)}
            />
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

function HostCard({
  host,
  busy,
  onRemove,
}: {
  host: ProbeHostView;
  busy: boolean;
  onRemove: () => void;
}) {
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
            disabled={busy}
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
