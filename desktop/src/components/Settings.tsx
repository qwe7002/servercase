import { useEffect, useState } from 'react';
import type { BitwardenStatus, BridgeInfo, Snippet } from '../../electron/shared';
import { useSettings } from '../store/settings';
import { useServers } from '../store/servers';
import { runExport, runImport } from '../lib/sync';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Bot,
  Cloud,
  CloudDownload,
  CloudUpload,
  Copy,
  KeyRound,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  Unlock,
} from 'lucide-react';
import { useCloud, hasValidSession } from '../store/cloud';
import { cloudAuth, cloudPull, cloudPush, CloudError } from '../lib/cloud';

type Section = 'bitwarden' | 'snippets' | 'sync' | 'cloud' | 'bridge';

interface Props {
  onDone: () => void;
}

export function Settings({ onDone }: Props) {
  const [section, setSection] = useState<Section>('bitwarden');
  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Global configuration shared across all servers.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={section} onValueChange={(v) => setSection(v as Section)}>
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="bitwarden">Keychain</TabsTrigger>
            <TabsTrigger value="snippets">Snippets</TabsTrigger>
            <TabsTrigger value="sync">Auto-sync</TabsTrigger>
            <TabsTrigger value="cloud">Cloud</TabsTrigger>
            <TabsTrigger value="bridge">AI</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="-mr-2 flex-1 overflow-y-auto pr-2">
          {section === 'bitwarden' && <BitwardenSection />}
          {section === 'snippets' && <SnippetsSection />}
          {section === 'sync' && <SyncSection />}
          {section === 'cloud' && <CloudSection />}
          {section === 'bridge' && <BridgeSection />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Keychain (Bitwarden) ──────────────────────────────────────────────────

function BitwardenSection() {
  const bw = useSettings((s) => s.settings.bitwarden);
  const setBitwarden = useSettings((s) => s.setBitwarden);
  const repersist = useServers((s) => s.repersist);
  const loadSecretsFromVault = useServers((s) => s.loadSecretsFromVault);
  const pushAllSecretsToVault = useServers((s) => s.pushAllSecretsToVault);

  const [status, setStatus] = useState<BitwardenStatus | null>(null);
  const [master, setMaster] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const api = window.servercase;

  const refresh = async () => {
    if (!api) return;
    await api.bw.configure(bw);
    setStatus(await api.bw.status());
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bw.serverUrl, bw.email, bw.clientId, bw.clientSecret, bw.itemPrefix]);

  const toggle = async (next: boolean) => {
    setMsg(null);
    if (!next) {
      // Pull any vault secrets back into memory before turning off, then
      // persist them locally again.
      try {
        await loadSecretsFromVault();
      } catch {
        /* vault may be locked; nothing to pull */
      }
      setBitwarden({ enabled: false });
      repersist();
      return;
    }
    setBitwarden({ enabled: true });
    await api?.bw.configure({ ...bw, enabled: true });
    await refresh();
  };

  const unlock = async () => {
    if (!api) return;
    setBusy(true);
    setMsg(null);
    try {
      const next = await api.bw.unlock(master);
      setStatus(next);
      setMaster('');
      if (next.state === 'unlocked') {
        await loadSecretsFromVault();
        setMsg('Vault unlocked and secrets loaded.');
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    await api?.bw.lock();
    await refresh();
  };

  const pushAll = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await pushAllSecretsToVault();
      await api?.bw.sync();
      repersist();
      setMsg('All server secrets pushed to the vault.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (!api) return;
    setBusy(true);
    setMsg('Testing vault…');
    try {
      setMsg(await api.bw.test());
    } catch (e) {
      setMsg(`Vault test failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const unlocked = status?.state === 'unlocked';

  return (
    <div className="grid gap-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <ShieldCheck className="size-4" /> Store credentials in Bitwarden
          </Label>
          <p className="text-sm text-muted-foreground">
            Usernames, passwords and SSH keys are kept in your Bitwarden vault,
            reached directly over the Bitwarden API (no <code>bw</code> CLI) and
            synced end-to-end. Authenticate with a personal API key; the master
            password unlocks the vault locally and is never stored. When off,
            secrets stay on this device only and are never written to the sync
            file.
          </p>
        </div>
        <Switch checked={bw.enabled} onCheckedChange={toggle} />
      </div>

      {bw.enabled && (
        <>
          <Separator />
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="bw-server">Server URL (self-hosted)</Label>
                <Input
                  id="bw-server"
                  placeholder="https://bitwarden.com"
                  value={bw.serverUrl}
                  onChange={(e) => setBitwarden({ serverUrl: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bw-email">Account email</Label>
                <Input
                  id="bw-email"
                  type="email"
                  placeholder="you@example.com"
                  value={bw.email}
                  onChange={(e) => setBitwarden({ email: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="bw-client-id">API key client_id</Label>
                <Input
                  id="bw-client-id"
                  placeholder="user.xxxxxxxx-…"
                  value={bw.clientId}
                  onChange={(e) => setBitwarden({ clientId: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bw-client-secret">API key client_secret</Label>
                <Input
                  id="bw-client-secret"
                  type="password"
                  value={bw.clientSecret}
                  onChange={(e) => setBitwarden({ clientSecret: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bw-prefix">Item name prefix</Label>
              <Input
                id="bw-prefix"
                value={bw.itemPrefix}
                onChange={(e) => setBitwarden({ itemPrefix: e.target.value })}
              />
            </div>
          </div>

          <Separator />

          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Vault status</span>
              <VaultBadge status={status} />
            </div>

            {status?.available === false && (
              <p className="text-sm text-muted-foreground">
                Enter your account email and a personal API key (Bitwarden web
                vault → Account Settings → Security → Keys → View API Key).
              </p>
            )}
            {status?.available && status.state === 'locked' && (
              <div className="flex items-end gap-2">
                <div className="grid flex-1 gap-2">
                  <Label htmlFor="bw-master">Master password</Label>
                  <Input
                    id="bw-master"
                    type="password"
                    value={master}
                    onChange={(e) => setMaster(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void unlock()}
                  />
                </div>
                <Button onClick={unlock} disabled={busy || !master}>
                  <Unlock /> Unlock
                </Button>
              </div>
            )}
            {unlocked && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={runTest} disabled={busy}>
                  <ShieldCheck /> Test vault
                </Button>
                <Button variant="outline" onClick={pushAll} disabled={busy}>
                  <KeyRound /> Push all secrets
                </Button>
                <Button variant="outline" onClick={() => void refresh()}>
                  <RefreshCw /> Refresh
                </Button>
                <Button variant="outline" onClick={lock}>
                  <Lock /> Lock
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}

function VaultBadge({ status }: { status: BitwardenStatus | null }) {
  if (!status) return <Badge variant="secondary">checking…</Badge>;
  if (!status.available) return <Badge variant="outline">not configured</Badge>;
  if (status.state === 'unlocked')
    return (
      <Badge>
        unlocked{status.userEmail ? ` · ${status.userEmail}` : ''}
      </Badge>
    );
  return <Badge variant="secondary">locked</Badge>;
}

// ── Snippets ──────────────────────────────────────────────────────────────

function SnippetsSection() {
  const snippets = useSettings((s) => s.settings.snippets);
  const addSnippet = useSettings((s) => s.addSnippet);
  const updateSnippet = useSettings((s) => s.updateSnippet);
  const removeSnippet = useSettings((s) => s.removeSnippet);

  const [name, setName] = useState('');
  const [command, setCommand] = useState('');

  const add = () => {
    if (!name.trim() || !command.trim()) return;
    addSnippet({ name: name.trim(), command: command.trim() });
    setName('');
    setCommand('');
  };

  return (
    <div className="grid gap-4 py-4">
      <p className="text-sm text-muted-foreground">
        Reusable commands you can drop into any server's terminal from the
        snippet menu.
      </p>

      <div className="grid gap-2 rounded-lg border p-3">
        <div className="grid gap-2">
          <Label htmlFor="snip-name">Name</Label>
          <Input
            id="snip-name"
            placeholder="Tail nginx log"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="snip-cmd">Command</Label>
          <Textarea
            id="snip-cmd"
            rows={2}
            className="font-mono text-xs"
            placeholder="tail -f /var/log/nginx/access.log"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </div>
        <div>
          <Button onClick={add} disabled={!name.trim() || !command.trim()}>
            <Plus /> Add snippet
          </Button>
        </div>
      </div>

      <div className="grid gap-2">
        {snippets.length === 0 && (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            No snippets yet.
          </p>
        )}
        {snippets.map((s) => (
          <SnippetRow
            key={s.id}
            snippet={s}
            onSave={updateSnippet}
            onRemove={() => removeSnippet(s.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SnippetRow({
  snippet,
  onSave,
  onRemove,
}: {
  snippet: Snippet;
  onSave: (s: Snippet) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(snippet.name);
  const [command, setCommand] = useState(snippet.command);
  const dirty = name !== snippet.name || command !== snippet.command;

  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Terminal className="size-4 shrink-0 text-muted-foreground" />
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <Button
          size="icon"
          variant="ghost"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          title="Delete"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Textarea
        rows={2}
        className="font-mono text-xs"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
      />
      {dirty && (
        <div>
          <Button
            size="sm"
            onClick={() => onSave({ ...snippet, name, command })}
          >
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Auto-sync ─────────────────────────────────────────────────────────────

function SyncSection() {
  const autoSync = useSettings((s) => s.settings.autoSync);
  const setAutoSync = useSettings((s) => s.setAutoSync);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const api = window.servercase;

  const pick = async () => {
    const file = await api?.sync.pickFile('save');
    if (file) setAutoSync({ filePath: file });
  };

  const syncNow = async () => {
    if (!autoSync.filePath) {
      setMsg('Choose a sync file first.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await runExport(autoSync.filePath);
      setMsg('Synced.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const file = await api?.sync.pickFile('open');
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      await runImport(file);
      setMsg('Configuration restored from file.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <RefreshCw className="size-4" /> Automatic config sync
          </Label>
          <p className="text-sm text-muted-foreground">
            Periodically writes your server list and settings to a JSON file.
            Secrets are never included — they sync through Bitwarden when
            enabled.
          </p>
        </div>
        <Switch
          checked={autoSync.enabled}
          onCheckedChange={(v) => setAutoSync({ enabled: v })}
        />
      </div>

      <Separator />

      <div className="grid gap-3">
        <div className="grid gap-2">
          <Label>Sync file</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              placeholder="No file chosen"
              value={autoSync.filePath}
              className="font-mono text-xs"
            />
            <Button variant="outline" onClick={pick}>
              Choose…
            </Button>
          </div>
        </div>

        <div className="grid w-40 gap-2">
          <Label htmlFor="sync-interval">Interval (minutes)</Label>
          <Input
            id="sync-interval"
            inputMode="numeric"
            value={String(autoSync.intervalMinutes)}
            onChange={(e) =>
              setAutoSync({
                intervalMinutes: Math.max(1, Number(e.target.value) || 1),
              })
            }
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={syncNow} disabled={busy}>
            <RefreshCw /> Sync now
          </Button>
          <Button variant="outline" onClick={restore} disabled={busy}>
            Restore from file…
          </Button>
        </div>

        {autoSync.lastSyncedAt && (
          <p className="text-xs text-muted-foreground">
            Last synced {new Date(autoSync.lastSyncedAt).toLocaleString()}
          </p>
        )}
      </div>

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}

// ── Cloud (worker sync) ─────────────────────────────────────────────────────

function CloudSection() {
  const cloud = useSettings((s) => s.settings.cloud);
  const setCloud = useSettings((s) => s.setCloud);
  const sessionState = useCloud();
  const signedIn = hasValidSession(sessionState);

  const [email, setEmail] = useState(cloud.email);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      setMsg(await fn());
    } catch (e) {
      const ce = e as CloudError;
      // A stale-base push is the one conflict worth a tailored hint.
      setErr(
        ce.status === 409
          ? 'The cloud copy changed since your last sync. Pull first, then push.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const authenticate = (mode: 'login' | 'register') =>
    run(async () => {
      const user = await cloudAuth(mode, email.trim(), password);
      setPassword('');
      return mode === 'register'
        ? `Account created — signed in as ${user.email}.`
        : `Signed in as ${user.email}.`;
    });

  const push = () =>
    run(async () => `Pushed config to the cloud (revision ${await cloudPush()}).`);
  const pull = () =>
    run(async () => {
      await cloudPull();
      return 'Config restored from the cloud.';
    });

  const signOut = () => {
    sessionState.clear();
    setMsg(null);
    setErr(null);
  };

  return (
    <div className="grid gap-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <Cloud className="size-4" /> ServerCase Cloud
          </Label>
          <p className="text-sm text-muted-foreground">
            Sync your server list and settings to a ServerCase Worker and read
            live probe status across devices. Secrets are never uploaded — they
            sync through Bitwarden — and your session token stays on this device.
          </p>
        </div>
        <Switch
          checked={cloud.enabled}
          onCheckedChange={(v) => setCloud({ enabled: v })}
        />
      </div>

      {cloud.enabled && (
        <>
          <Separator />

          <div className="grid gap-2">
            <Label htmlFor="cloud-url">Worker URL</Label>
            <Input
              id="cloud-url"
              placeholder="https://worker.example.com"
              value={cloud.url}
              onChange={(e) => setCloud({ url: e.target.value })}
              className="font-mono text-xs"
            />
          </div>

          <Separator />

          {!signedIn ? (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="cloud-email">Email</Label>
                  <Input
                    id="cloud-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="cloud-password">Password</Label>
                  <Input
                    id="cloud-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void authenticate('login')}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => void authenticate('login')}
                  disabled={busy || !cloud.url || !email.trim() || !password}
                >
                  Sign in
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void authenticate('register')}
                  disabled={busy || !cloud.url || !email.trim() || password.length < 8}
                >
                  Create account
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                New accounts need a password of at least 8 characters.
              </p>
            </div>
          ) : (
            <div className="grid gap-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Account</span>
                <Badge>{sessionState.user?.email}</Badge>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={push} disabled={busy}>
                  <CloudUpload /> Push to cloud
                </Button>
                <Button variant="outline" onClick={pull} disabled={busy}>
                  <CloudDownload /> Pull from cloud
                </Button>
                <Button variant="outline" onClick={signOut} disabled={busy}>
                  <LogOut /> Sign out
                </Button>
              </div>

              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label className="flex items-center gap-2">
                    <RefreshCw className="size-4" /> Auto-push on changes
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Push the config to the cloud automatically a few seconds
                    after you change a server or setting.
                  </p>
                </div>
                <Switch
                  checked={cloud.autoPush}
                  onCheckedChange={(v) => setCloud({ autoPush: v })}
                />
              </div>

              {sessionState.syncedAt && (
                <p className="text-xs text-muted-foreground">
                  Last synced {new Date(sessionState.syncedAt).toLocaleString()} ·
                  revision {sessionState.syncVersion}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

// ── AI control bridge (MCP) ────────────────────────────────────────────────

function BridgeSection() {
  const bridge = useSettings((s) => s.settings.bridge);
  const setBridge = useSettings((s) => s.setBridge);
  const [info, setInfo] = useState<BridgeInfo | null>(null);

  const api = window.servercase;

  useEffect(() => {
    void (async () => {
      if (api) setInfo(await api.bridge.info());
    })();
  }, [api, bridge.enabled, bridge.port]);

  const copy = (value: string) => void navigator.clipboard?.writeText(value);

  return (
    <div className="grid gap-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <Bot className="size-4" /> Let an AI control SSH (MCP bridge)
          </Label>
          <p className="text-sm text-muted-foreground">
            Exposes a local, token-protected endpoint so the ServerCase MCP
            server can run commands, read status and browse files on connections
            you have authenticated here. The bridge never sees your passwords,
            keys or Bitwarden — login stays in ServerCase.
          </p>
        </div>
        <Switch
          checked={bridge.enabled}
          onCheckedChange={(v) => setBridge({ enabled: v })}
        />
      </div>

      {bridge.enabled && (
        <>
          <Separator />
          <div className="grid w-40 gap-2">
            <Label htmlFor="bridge-port">Port</Label>
            <Input
              id="bridge-port"
              inputMode="numeric"
              value={String(bridge.port)}
              onChange={(e) =>
                setBridge({ port: Number(e.target.value) || 8765 })
              }
            />
          </div>

          <div className="grid gap-2">
            <Label>Bridge URL</Label>
            <div className="flex gap-2">
              <Input readOnly value={info?.url ?? ''} className="font-mono text-xs" />
              <Button variant="outline" onClick={() => copy(info?.url ?? '')}>
                <Copy />
              </Button>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Token</Label>
            <div className="flex gap-2">
              <Input
                readOnly
                type="password"
                value={info?.token ?? ''}
                className="font-mono text-xs"
              />
              <Button variant="outline" onClick={() => copy(info?.token ?? '')}>
                <Copy />
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Status: {info?.running ? 'listening' : 'stopped'}. Point the MCP
            server at this URL and token (<code>SERVERCASE_MCP_URL</code> /{' '}
            <code>SERVERCASE_MCP_TOKEN</code>). The token is regenerated each
            time the app restarts.
          </p>
        </>
      )}
    </div>
  );
}
