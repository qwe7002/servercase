import { useEffect, useRef, useState } from 'react';
import {
  alertsApi,
  ApiError,
  authApi,
  clearToken,
  devicesApi,
  formatKb,
  getToken,
  openStream,
  percent,
  probesApi,
  relativeTime,
  setToken,
  syncApi,
  type CloudUser,
  type Device,
  type HistoryPoint,
  type ProbeHost,
  type ProbeSnapshot,
  type StreamStatus,
  type SyncInfo,
  type ThresholdOverrides,
} from './lib/api';
import { LineChart } from './components/LineChart';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Activity,
  ArrowLeft,
  BellRing,
  Cloud,
  Copy,
  LogOut,
  Plus,
  RadioTower,
  Server,
  Trash2,
} from 'lucide-react';

export function App() {
  const [user, setUser] = useState<CloudUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    authApi
      .me()
      .then((r) => setUser(r.user))
      .catch(() => clearToken())
      .finally(() => setReady(true));
  }, []);

  if (!ready) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16 pt-6">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-semibold">
          <Cloud className="size-5 text-primary" /> ServerCase Cloud
        </div>
        {user && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{user.email}</Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                clearToken();
                setUser(null);
              }}
            >
              <LogOut /> Sign out
            </Button>
          </div>
        )}
      </header>

      {user ? <Dashboard /> : <LoginCard onSignedIn={setUser} />}
    </div>
  );
}

function LoginCard({ onSignedIn }: { onSignedIn: (u: CloudUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const auth = (mode: 'login' | 'register') => async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await (mode === 'register'
        ? authApi.register(email.trim(), password)
        : authApi.login(email.trim(), password));
      setToken(res.token);
      onSignedIn(res.user);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mx-auto mt-[8vh] max-w-md">
      <CardContent className="grid gap-4 pt-6">
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void auth('login')()}
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void auth('login')()} disabled={busy || !email || !password}>
            Sign in
          </Button>
          <Button
            variant="outline"
            onClick={() => void auth('register')()}
            disabled={busy || !email || password.length < 8}
          >
            Create account
          </Button>
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

type Tab = 'probes' | 'devices' | 'alerts' | 'config';

function Dashboard() {
  const [tab, setTab] = useState<Tab>('probes');
  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="grid w-full max-w-lg grid-cols-4">
          <TabsTrigger value="probes">Probes</TabsTrigger>
          <TabsTrigger value="devices">Devices</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="mt-4">
        {tab === 'probes' && <ProbesTab />}
        {tab === 'devices' && <DevicesTab />}
        {tab === 'alerts' && <AlertsTab />}
        {tab === 'config' && <ConfigTab />}
      </div>
    </>
  );
}

interface HostView {
  id: string;
  name: string;
  lastSeenAt: number | null;
  snapshot: ProbeSnapshot | null;
}

function ProbesTab() {
  const [hosts, setHosts] = useState<HostView[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [detail, setDetail] = useState<{ id: string; name: string } | null>(null);
  const [, tick] = useState(0);
  const tickRef = useRef(0);

  const load = async () => {
    try {
      const res = await probesApi.list();
      setHosts(
        res.hosts.map((h: ProbeHost) => ({
          id: h.id,
          name: h.name,
          lastSeenAt: h.lastSeenAt,
          snapshot: h.latest,
        })),
      );
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const close = openStream({
      onStatus: setStatus,
      onSnapshot: (hostId, at, snapshot) =>
        setHosts((prev) =>
          prev.map((h) => (h.id === hostId ? { ...h, snapshot, lastSeenAt: at } : h)),
        ),
    });
    const timer = setInterval(() => tick((tickRef.current += 1)), 1000);
    return () => {
      close();
      clearInterval(timer);
    };
  }, []);

  const addHost = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await probesApi.create(name.trim());
      setNewToken({ name: res.host.name, token: res.token });
      setName('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeHost = async (id: string) => {
    try {
      await probesApi.remove(id);
      setHosts((prev) => prev.filter((h) => h.id !== id));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (detail) return <HostDetail host={detail} onBack={() => setDetail(null)} />;

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Probe hosts</span>
        {status === 'open' ? (
          <Badge className="gap-1">
            <Activity className="size-3" /> live
          </Badge>
        ) : (
          <Badge variant="secondary">{status === 'connecting' ? 'connecting…' : 'offline'}</Badge>
        )}
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
              Copy it now — shown once. Deploy with <code>servercase-probe install --token …</code>.
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
              <Button variant="ghost" size="sm" onClick={() => setNewToken(null)}>
                Done
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {hosts.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">
          No hosts yet. Add one, then deploy the agent with its token.
        </p>
      ) : (
        <div className="grid gap-2">
          {hosts.map((h) => (
            <HostCard
              key={h.id}
              host={h}
              onRemove={() => void removeHost(h.id)}
              onOpen={() => setDetail({ id: h.id, name: h.name })}
            />
          ))}
        </div>
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

function HostCard({
  host,
  onRemove,
  onOpen,
}: {
  host: HostView;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const s = host.snapshot;
  const online = !!host.lastSeenAt && Date.now() - host.lastSeenAt < 30_000;

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-3">
        <button
          className="min-w-0 cursor-pointer text-left"
          onClick={onOpen}
          title="View history"
        >
          <div className="flex items-center gap-2">
            <Server className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{host.name}</span>
            <span
              className={`size-2 shrink-0 rounded-full ${online ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
              title={online ? 'online' : 'offline'}
            />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {s ? `${s.hostname || '—'} · ${s.kernel || '—'}` : 'waiting for first snapshot…'}
          </p>
        </button>
        <div className="flex items-center gap-4">
          {s && (
            <div className="hidden gap-4 text-right text-xs sm:flex">
              <Metric label="CPU" value={s.cpu_usage == null ? '–' : `${Math.round(s.cpu_usage)}%`} />
              <Metric
                label="Mem"
                value={`${percent(s.memory.mem_used_kb, s.memory.mem_total_kb)}%`}
                sub={`${formatKb(s.memory.mem_used_kb)} / ${formatKb(s.memory.mem_total_kb)}`}
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
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function HostDetail({ host, onBack }: { host: { id: string; name: string }; onBack: () => void }) {
  const [points, setPoints] = useState<HistoryPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      probesApi
        .history(host.id)
        .then((r) => live && setPoints(r.points))
        .catch((e) => live && setErr((e as Error).message));
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [host.id]);

  const cpu = points?.map((p) => p.cpuUsage) ?? [];
  const mem = points?.map((p) => p.memPct) ?? [];
  const last = (vals: (number | null)[]) => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return Math.round(vals[i] as number);
    return null;
  };

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onBack} title="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <span className="font-medium">{host.name}</span>
        <span className="text-xs text-muted-foreground">· last {points?.length ?? 0} samples</span>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      {points && points.length === 0 && (
        <p className="text-sm text-muted-foreground">No history yet — waiting for snapshots.</p>
      )}

      {points && points.length > 0 && (
        <>
          <ChartCard title="CPU" color="#34d399" value={last(cpu)} values={cpu} />
          <ChartCard title="Memory" color="#60a5fa" value={last(mem)} values={mem} />
        </>
      )}
    </div>
  );
}

function ChartCard({
  title,
  color,
  value,
  values,
}: {
  title: string;
  color: string;
  value: number | null;
  values: (number | null)[];
}) {
  return (
    <Card>
      <CardContent className="grid gap-2 p-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-medium">
            <span className="size-2 rounded-full" style={{ background: color }} /> {title}
          </span>
          <span className="text-sm tabular-nums text-muted-foreground">
            {value == null ? '–' : `${value}%`}
          </span>
        </div>
        <LineChart series={[{ label: title, color, values }]} />
      </CardContent>
    </Card>
  );
}

function AlertsTab() {
  const [draft, setDraft] = useState<{ cpu: string; mem: string; disk: string } | null>(null);
  const [defaults, setDefaults] = useState<{ cpu: number; mem: number; disk: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    alertsApi
      .get()
      .then((d) => {
        setDefaults(d.defaults);
        setDraft({
          cpu: d.overrides.cpu?.toString() ?? '',
          mem: d.overrides.mem?.toString() ?? '',
          disk: d.overrides.disk?.toString() ?? '',
        });
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!draft || !defaults) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const parse = (s: string): number | null => (s.trim() === '' ? null : Number(s));
  const save = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    const overrides: ThresholdOverrides = {
      cpu: parse(draft.cpu),
      mem: parse(draft.mem),
      disk: parse(draft.disk),
    };
    if (Object.values(overrides).some((v) => v != null && (Number.isNaN(v) || v < 0 || v > 100))) {
      setErr('Thresholds must be 0–100 (or blank for the default).');
      setBusy(false);
      return;
    }
    try {
      await alertsApi.put(overrides);
      setMsg('Saved.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (key: 'cpu' | 'mem' | 'disk', label: string) => (
    <div className="grid gap-2">
      <Label htmlFor={key}>{label} (%)</Label>
      <Input
        id={key}
        inputMode="numeric"
        placeholder={`default ${defaults[key]}`}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </div>
  );

  return (
    <Card>
      <CardContent className="grid gap-4 pt-6">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <BellRing className="size-4" /> Push an alert when a metric crosses these thresholds.
          Leave a field blank to use the server default.
        </p>
        <div className="grid grid-cols-3 gap-3">
          {field('cpu', 'CPU')}
          {field('mem', 'Memory')}
          {field('disk', 'Disk')}
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={busy}>
            Save thresholds
          </Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function DevicesTab() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    devicesApi
      .list()
      .then((r) => setDevices(r.devices))
      .catch((e) => setErr((e as Error).message));

  useEffect(() => {
    void load();
  }, []);

  const remove = async (id: string) => {
    try {
      await devicesApi.remove(id);
      setDevices((prev) => (prev ? prev.filter((d) => d.id !== id) : prev));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!devices) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (devices.length === 0)
    return <p className="text-sm text-muted-foreground">No push devices registered.</p>;

  return (
    <div className="grid gap-2">
      {devices.map((d) => (
        <Card key={d.id}>
          <CardContent className="flex items-center justify-between gap-4 p-3">
            <div>
              <div className="font-medium">{d.label || d.platform}</div>
              <div className="text-xs text-muted-foreground">
                {d.platform} · added {relativeTime(d.createdAt)} · seen {relativeTime(d.lastSeenAt)}
              </div>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => void remove(d.id)}
              title="Unregister"
            >
              <Trash2 className="size-4" />
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ConfigTab() {
  const [info, setInfo] = useState<SyncInfo | null>(null);
  const [state, setState] = useState<'loading' | 'empty' | 'error' | 'ok'>('loading');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    syncApi
      .get()
      .then((r) => {
        setInfo(r);
        setState('ok');
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setState('empty');
        else {
          setErr((e as Error).message);
          setState('error');
        }
      });
  }, []);

  if (state === 'loading') return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (state === 'error') return <p className="text-sm text-destructive">{err}</p>;
  if (state === 'empty' || !info)
    return (
      <p className="text-sm text-muted-foreground">
        No config synced yet. Push from a ServerCase client (Settings → Cloud).
      </p>
    );

  const servers = Array.isArray(info.payload.servers) ? info.payload.servers.length : 0;
  return (
    <Card>
      <CardContent className="grid gap-2 pt-6 text-sm">
        <div>
          Revision <span className="font-medium">{info.version}</span>
        </div>
        <div className="text-muted-foreground">
          Updated {new Date(info.updatedAt).toLocaleString()}
        </div>
        <div>
          <span className="font-medium">{servers}</span> server{servers === 1 ? '' : 's'}{' '}
          <span className="text-muted-foreground">(secret-free)</span>
        </div>
      </CardContent>
    </Card>
  );
}
