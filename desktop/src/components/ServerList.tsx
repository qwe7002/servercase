import { useState } from 'react';
import type { ServerConfig } from '../../electron/shared';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { connectServer } from '../lib/connect';
import {
  ChevronDown,
  ChevronRight,
  Folders,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings as SettingsIcon,
  Trash2,
  Unplug,
} from 'lucide-react';

interface Props {
  onAdd: () => void;
  onEdit: (cfg: ServerConfig) => void;
  onOpenSettings: () => void;
  onManageGroups: () => void;
}

const STATE_LABEL: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  error: 'Error',
  disconnected: 'Offline',
};

const UNGROUPED = '__ungrouped__';

export function ServerList({ onAdd, onEdit, onOpenSettings, onManageGroups }: Props) {
  const servers = useServers((s) => s.servers);
  const groups = useSettings((s) => s.settings.groups);
  const collapsedGroups = useServers((s) => s.collapsedGroups);
  const toggleGroup = useServers((s) => s.toggleGroup);

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (s: ServerConfig) =>
    !q ||
    s.name.toLowerCase().includes(q) ||
    s.host.toLowerCase().includes(q) ||
    s.username.toLowerCase().includes(q);
  const filtered = servers.filter(matches);

  // Always group; fall back to a flat list only when no groups are defined.
  const grouped = groups.length > 0;
  const sections = [
    ...groups.map((g) => ({
      id: g.id,
      name: g.name,
      items: filtered.filter((s) => s.groupId === g.id),
    })),
    {
      id: UNGROUPED,
      name: 'Ungrouped',
      items: filtered.filter(
        (s) => !s.groupId || !groups.some((g) => g.id === s.groupId),
      ),
    },
  ].filter((sec) => sec.items.length > 0);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-card/60">
      <div className="flex h-16 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Server className="size-4" />
          </span>
          ServerCase
        </div>
        <div className="flex items-center">
          <Button size="icon" variant="outline" title="Add server" onClick={onAdd}>
            <Plus />
          </Button>
        </div>
      </div>

      <div className="border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            placeholder="Search servers…"
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {servers.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            No servers yet. Add one to get started.
          </p>
        )}
        {servers.length > 0 && filtered.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            No servers match “{query}”.
          </p>
        )}

        {grouped
          ? sections.map((sec) => {
              const collapsed = collapsedGroups.includes(sec.id);
              return (
                <div key={sec.id}>
                  <button
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/60"
                    onClick={() => toggleGroup(sec.id)}
                  >
                    {collapsed ? (
                      <ChevronRight className="size-3.5" />
                    ) : (
                      <ChevronDown className="size-3.5" />
                    )}
                    <span className="truncate uppercase tracking-wide">{sec.name}</span>
                    <span className="ml-auto tabular-nums opacity-60">
                      {sec.items.length}
                    </span>
                  </button>
                  {!collapsed &&
                    sec.items.map((srv) => (
                      <ServerRow key={srv.id} srv={srv} onEdit={onEdit} />
                    ))}
                </div>
              );
            })
          : filtered.map((srv) => (
              <ServerRow key={srv.id} srv={srv} onEdit={onEdit} />
            ))}
      </div>

      <div className="space-y-1 border-t p-2">
        <Button
          className="w-full justify-start"
          variant="ghost"
          title="Manage groups"
          onClick={onManageGroups}
        >
          <Folders className="size-4" />
          Folders
        </Button>
        <Button
          className="w-full justify-start"
          variant="ghost"
          title="Settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon className="size-4" />
          Settings
        </Button>
      </div>
    </aside>
  );
}

function ServerRow({
  srv,
  onEdit,
}: {
  srv: ServerConfig;
  onEdit: (cfg: ServerConfig) => void;
}) {
  const selectedId = useServers((s) => s.selectedId);
  const state = useServers((s) => s.connState[srv.id]) ?? 'disconnected';
  const select = useServers((s) => s.select);
  const removeServer = useServers((s) => s.removeServer);
  const setConnState = useServers((s) => s.setConnState);

  const disconnect = async () => {
    await window.servercase?.disconnect(srv.id);
    setConnState(srv.id, 'disconnected');
  };

  const reconnect = async () => {
    await disconnect();
    await connectServer(srv).catch(() => undefined);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:bg-accent/70',
            selectedId === srv.id && 'border-border bg-accent',
          )}
          onClick={() => select(srv.id)}
          onDoubleClick={() => {
            if (state !== 'connecting') void reconnect();
          }}
        >
          <span
            className={cn(
              'size-2 shrink-0 rounded-full bg-muted-foreground',
              state === 'connected' && 'bg-emerald-500',
              state === 'connecting' && 'animate-pulse bg-amber-500',
              state === 'error' && 'bg-destructive',
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{srv.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {srv.username}@{srv.host} · {STATE_LABEL[state]}
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => void reconnect()}
          disabled={state === 'connecting'}
        >
          <RefreshCw /> Reconnect
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void disconnect()}
          disabled={state === 'disconnected'}
        >
          <Unplug /> Disconnect
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onEdit(srv)}>
          <Pencil /> Edit
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => {
            if (confirm(`Delete "${srv.name}"?`)) removeServer(srv.id);
          }}
        >
          <Trash2 /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
