import { useState } from 'react';
import type { AuthType, ServerConfig, ServerSecrets } from '../../electron/shared';
import { useServers } from '../store/servers';
import { useProbes } from '../store/probes';
import { useSettings } from '../store/settings';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  /** When editing, the existing server; otherwise undefined for a new one. */
  existing?: ServerConfig;
  onDone: () => void;
}

export function ServerForm({ existing, onDone }: Props) {
  const addServer = useServers((s) => s.addServer);
  const updateServer = useServers((s) => s.updateServer);
  const groups = useSettings((s) => s.settings.groups);
  const bwEnabled = useSettings((s) => s.settings.bitwarden.enabled);
  const probeHosts = useProbes((s) => s.hosts);

  const [name, setName] = useState(existing?.name ?? '');
  const [groupId, setGroupId] = useState(existing?.groupId ?? '');
  const [probeHostId, setProbeHostId] = useState(existing?.probeHostId ?? '');
  const [host, setHost] = useState(existing?.host ?? '');
  const [port, setPort] = useState(String(existing?.port ?? 22));
  const [username, setUsername] = useState(existing?.username ?? 'root');
  const [itemName, setItemName] = useState(
    existing?.bitwardenItemName ?? existing?.name ?? '',
  );
  const [authType, setAuthType] = useState<AuthType>(
    existing?.authType ?? 'password',
  );
  const [password, setPassword] = useState(existing?.password ?? '');
  const [privateKey, setPrivateKey] = useState(existing?.privateKey ?? '');
  const [passphrase, setPassphrase] = useState(existing?.passphrase ?? '');

  const canSave = name.trim() && host.trim() && username.trim();

  /** Fills the credential fields from a vault item chosen in the browser. */
  const applyVaultItem = (
    chosenName: string,
    secrets: ServerSecrets,
    mode: AuthType,
  ) => {
    setItemName(chosenName);
    if (secrets.username) setUsername(secrets.username);
    setAuthType(mode);
    if (mode === 'password') {
      setPassword(secrets.password ?? '');
      setPrivateKey('');
      setPassphrase('');
    } else {
      setPrivateKey(secrets.privateKey ?? '');
      setPassphrase(secrets.passphrase ?? '');
      setPassword('');
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    const base = {
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      bitwardenItemName: itemName.trim() || undefined,
      groupId: groupId || undefined,
      probeHostId: probeHostId || undefined,
      authType,
      password: authType === 'password' ? password : undefined,
      privateKey: authType === 'key' ? privateKey : undefined,
      passphrase: authType === 'key' ? passphrase || undefined : undefined,
    };
    if (existing) updateServer({ ...base, id: existing.id });
    else addServer(base);
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <form
        id="server-form"
        onSubmit={submit}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{existing ? 'Edit server' : 'Add server'}</DialogTitle>
            <DialogDescription>
              Configure the SSH connection used to monitor this server.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="server-name">Name</Label>
                <Input
                  id="server-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="server-group">Group</Label>
                <select
                  id="server-group"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">No group</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <div className="grid gap-2">
                <Label htmlFor="server-host">Host</Label>
                <Input
                  id="server-host"
                  value={host}
                  placeholder="example.com or 10.0.0.5"
                  onChange={(e) => setHost(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="server-port">Port</Label>
                <Input
                  id="server-port"
                  value={port}
                  inputMode="numeric"
                  onChange={(e) => setPort(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="server-username">Username</Label>
              <Input
                id="server-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>

            {bwEnabled && (
              <VaultItemPicker
                itemName={itemName}
                fallbackName={name.trim()}
                onItemName={setItemName}
                onApply={applyVaultItem}
              />
            )}

            <div className="grid gap-2">
              <Label htmlFor="server-probe">Probe data</Label>
              <select
                id="server-probe"
                value={probeHostId}
                onChange={(e) => setProbeHostId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Use SSH polling for overview</option>
                {probeHosts.map((probe) => (
                  <option key={probe.id} value={probe.id}>
                    {probe.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label>Authentication</Label>
              <Tabs
                value={authType}
                onValueChange={(value) => setAuthType(value as AuthType)}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="password">Password</TabsTrigger>
                  <TabsTrigger value="key">Private key</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {authType === 'password' ? (
              <div className="grid gap-2">
                <Label htmlFor="server-password">Password</Label>
                <Input
                  id="server-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="server-key">Private key (PEM)</Label>
                  <Textarea
                    id="server-key"
                    rows={6}
                    className="font-mono text-xs"
                    value={privateKey}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    onChange={(e) => setPrivateKey(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="server-passphrase">
                    Passphrase (optional)
                  </Label>
                  <Input
                    id="server-passphrase"
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" form="server-form" disabled={!canSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </form>
    </Dialog>
  );
}

/**
 * Names the Bitwarden login item that holds this server's credentials and,
 * when the vault is unlocked, lets the user pick an existing item to fill the
 * credential fields (mirrors the iOS item picker).
 */
function VaultItemPicker({
  itemName,
  fallbackName,
  onItemName,
  onApply,
}: {
  itemName: string;
  fallbackName: string;
  onItemName: (name: string) => void;
  onApply: (name: string, secrets: ServerSecrets, mode: AuthType) => void;
}) {
  const [items, setItems] = useState<Record<string, ServerSecrets> | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const browse = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      setItems((await window.servercase?.bw.list()) ?? {});
    } catch {
      setItems(null);
      setError('Unlock the Bitwarden vault in Settings first, then retry.');
    } finally {
      setLoading(false);
    }
  };

  const names = Object.keys(items ?? {})
    .filter((n) => n.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <div className="grid gap-2">
        <Label htmlFor="server-vault-item">Bitwarden vault item</Label>
        <div className="flex gap-2">
          <Input
            id="server-vault-item"
            value={itemName}
            placeholder={fallbackName || 'Same as server name'}
            onChange={(e) => onItemName(e.target.value)}
          />
          <Button type="button" variant="outline" onClick={() => void browse()}>
            {open ? 'Hide vault' : 'Browse vault'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Login item inside the configured ServerCase folder that stores this
          server's credentials. Several servers can share one item.
        </p>
      </div>

      {open && (
        <div className="grid gap-2">
          {loading && (
            <p className="text-sm text-muted-foreground">Loading items…</p>
          )}
          {error && <p className="text-sm text-muted-foreground">{error}</p>}
          {items && !loading && (
            <>
              {Object.keys(items).length > 3 && (
                <Input
                  placeholder="Filter items"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
              {names.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No stored items found.
                </p>
              )}
              <div className="max-h-48 overflow-y-auto">
                {names.map((n) => {
                  const secrets = items[n];
                  return (
                    <div
                      key={n}
                      className="flex items-center justify-between gap-2 border-b py-2 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">{n}</p>
                        {secrets.username && (
                          <p className="truncate text-xs text-muted-foreground">
                            {secrets.username}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {secrets.password && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              onApply(n, secrets, 'password');
                              setOpen(false);
                            }}
                          >
                            Use password
                          </Button>
                        )}
                        {secrets.privateKey && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              onApply(n, secrets, 'key');
                              setOpen(false);
                            }}
                          >
                            Use SSH key
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
