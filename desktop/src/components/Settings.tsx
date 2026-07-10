import { useEffect, useRef, useState } from 'react';
import type {
  BitwardenFolder,
  BitwardenStatus,
  BridgeInfo,
  Snippet,
} from '../../electron/shared';
import { useSettings } from '../store/settings';
import { useServers } from '../store/servers';
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
import { CloudProbes } from './CloudProbes';
import { TERMINAL_SCHEMES, TERMINAL_SCHEME_LABELS } from '../lib/terminalTheme';
import type { TerminalColorScheme, TerminalCursorStyle } from '../../electron/shared';

type Section = 'bitwarden' | 'snippets' | 'cloud' | 'terminal' | 'bridge';

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
            <TabsTrigger value="cloud">Cloud</TabsTrigger>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="bridge">AI</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="-mr-2 flex-1 overflow-y-auto pr-2">
          {section === 'bitwarden' && <BitwardenSection />}
          {section === 'snippets' && <SnippetsSection />}
          {section === 'cloud' && <CloudSection />}
          {section === 'terminal' && <TerminalSection />}
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
  const [folders, setFolders] = useState<BitwardenFolder[]>([]);
  const [newFolder, setNewFolder] = useState('');
  const autoUnlockTried = useRef(false);

  const api = window.servercase;

  const loadFolders = async () => {
    if (!api) return;
    try {
      setFolders(await api.bw.listFolders());
    } catch (e) {
      setMsg(`Folder refresh failed: ${(e as Error).message}`);
    }
  };

  const refresh = async () => {
    if (!api) return;
    await api.bw.configure(bw);
    // Try the OS-keychain-stored master password before asking (as on iOS),
    // once per settings visit so a stale password can't spam login attempts.
    let next = await api.bw.status();
    if (next.state === 'locked' && !autoUnlockTried.current) {
      autoUnlockTried.current = true;
      next = await api.bw.unlockStored().catch(() => next);
    }
    setStatus(next);
    if (next.state === 'unlocked') await loadFolders();
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bw.serverUrl,
    bw.email,
    bw.authMode,
    bw.clientId,
    bw.clientSecret,
    bw.itemPrefix,
  ]);

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
        await loadFolders();
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

  const addFolder = async () => {
    if (!api) return;
    const name = newFolder.trim();
    if (!name) return;
    setBusy(true);
    setMsg(null);
    try {
      const folder = await api.bw.createFolder(name);
      setNewFolder('');
      setBitwarden({ itemPrefix: folder.name });
      await loadFolders();
      setMsg('Folder added.');
    } catch (e) {
      setMsg(`Folder add failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const currentFolderId = folders.find(
    (f) => f.name === bw.itemPrefix.trim(),
  )?.id;

  const deleteCurrentFolder = async () => {
    if (!api || !currentFolderId) return;
    if (
      !window.confirm(
        `Delete the Bitwarden folder "${bw.itemPrefix.trim()}"? Items inside it are kept but become unfiled.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.bw.deleteFolder(currentFolderId);
      const remaining = folders.filter((f) => f.id !== currentFolderId);
      setBitwarden({ itemPrefix: remaining[0]?.name ?? 'ServerCase' });
      await loadFolders();
      setMsg('Folder deleted.');
    } catch (e) {
      setMsg(`Folder delete failed: ${(e as Error).message}`);
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
            synced end-to-end. Sign in with your account password, or use a
            personal API key for accounts that require interactive 2FA. The
            master password is never stored.
          </p>
        </div>
        <Switch checked={bw.enabled} onCheckedChange={toggle} />
      </div>

      {bw.enabled && (
        <>
          <Separator />
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label>Sign-in method</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={(bw.authMode ?? 'password') === 'password' ? 'default' : 'outline'}
                  onClick={() => setBitwarden({ authMode: 'password' })}
                >
                  Account password
                </Button>
                <Button
                  type="button"
                  variant={bw.authMode === 'apiKey' ? 'default' : 'outline'}
                  onClick={() => setBitwarden({ authMode: 'apiKey' })}
                >
                  Personal API key
                </Button>
              </div>
            </div>
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
            {(bw.authMode ?? 'password') === 'apiKey' && (
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
                    onChange={(e) =>
                      setBitwarden({ clientSecret: e.target.value })
                    }
                  />
                </div>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="bw-folder">Vault folder</Label>
              {unlocked && folders.length > 0 ? (
                <select
                  id="bw-folder"
                  value={bw.itemPrefix}
                  onChange={(e) => setBitwarden({ itemPrefix: e.target.value })}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {!folders.some((f) => f.name === bw.itemPrefix) && (
                    <option value={bw.itemPrefix}>
                      {bw.itemPrefix.trim() || 'ServerCase'} (will be created)
                    </option>
                  )}
                  {folders.map((f) => (
                    <option key={f.id} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="bw-folder"
                  placeholder="ServerCase"
                  value={bw.itemPrefix}
                  onChange={(e) => setBitwarden({ itemPrefix: e.target.value })}
                />
              )}
              <p className="text-xs text-muted-foreground">
                ServerCase login items live inside this Bitwarden folder.
              </p>
            </div>
            {unlocked && (
              <div className="grid gap-2">
                <div className="flex gap-2">
                  <Input
                    placeholder="New folder name"
                    value={newFolder}
                    onChange={(e) => setNewFolder(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void addFolder()}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void addFolder()}
                    disabled={busy || !newFolder.trim()}
                  >
                    <Plus /> Add
                  </Button>
                  <Button
                    variant="outline"
                    className="text-destructive"
                    onClick={() => void deleteCurrentFolder()}
                    disabled={busy || !currentFolderId}
                    title="Delete the selected folder"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            )}
          </div>

          <Separator />

          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Vault status</span>
              <VaultBadge status={status} />
            </div>

            {status?.available === false && (
              <p className="text-sm text-muted-foreground">
                Enter your account email. If you choose personal API key mode,
                also fill in the key from the Bitwarden web vault.
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

  const authenticate = () =>
    run(async () => {
      const user = await cloudAuth(email.trim(), password);
      setPassword('');
      return `Signed in as ${user.email}.`;
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
                    onKeyDown={(e) => e.key === 'Enter' && void authenticate()}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => void authenticate()}
                  disabled={busy || !cloud.url || !email.trim() || !password}
                >
                  Sign in
                </Button>
              </div>
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

              <Separator />
              <CloudProbes />
            </div>
          )}
        </>
      )}

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

// ── Terminal ────────────────────────────────────────────────────────────────

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-md border p-1">
      {options.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={value === o.value ? 'default' : 'ghost'}
          className="h-7"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function TerminalSection() {
  const term = useSettings((s) => s.settings.terminal);
  const setTerminal = useSettings((s) => s.setTerminal);
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const scheme = TERMINAL_SCHEMES[term.colorScheme];

  return (
    <div className="grid gap-5 py-4">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <Terminal className="size-4" /> Terminal appearance
        </Label>
        <p className="text-sm text-muted-foreground">
          Applies to the SSH terminal on every server, and syncs across your
          devices through Cloud.
        </p>
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="term-font">Font size</Label>
          <Input
            id="term-font"
            inputMode="numeric"
            value={String(term.fontSize)}
            onChange={(e) => setTerminal({ fontSize: clamp(Number(e.target.value) || 13, 8, 32) })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="term-scroll">Scrollback (lines)</Label>
          <Input
            id="term-scroll"
            inputMode="numeric"
            value={String(term.scrollback)}
            onChange={(e) =>
              setTerminal({ scrollback: clamp(Number(e.target.value) || 1000, 100, 100000) })
            }
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label>Cursor style</Label>
        <Segmented<TerminalCursorStyle>
          options={(['block', 'underline', 'bar'] as const).map((s) => ({ value: s, label: cap(s) }))}
          value={term.cursorStyle}
          onChange={(v) => setTerminal({ cursorStyle: v })}
        />
      </div>

      <div className="flex items-center justify-between">
        <Label>Cursor blink</Label>
        <Switch
          checked={term.cursorBlink}
          onCheckedChange={(v) => setTerminal({ cursorBlink: v })}
        />
      </div>

      <div className="grid gap-2">
        <Label>Color scheme</Label>
        <Segmented<TerminalColorScheme>
          options={(Object.keys(TERMINAL_SCHEMES) as TerminalColorScheme[]).map((s) => ({
            value: s,
            label: TERMINAL_SCHEME_LABELS[s],
          }))}
          value={term.colorScheme}
          onChange={(v) => setTerminal({ colorScheme: v })}
        />
        <div
          className="mt-1 rounded-md border p-3 font-mono text-xs"
          style={{ background: scheme.background, color: scheme.foreground }}
        >
          user@host:~$ echo preview
        </div>
      </div>
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
