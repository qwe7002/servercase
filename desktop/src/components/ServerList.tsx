import { useState } from 'react';
import type { ServerConfig } from '../../electron/shared';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  ChevronDown,
  ChevronRight,
  Folders,
  Pencil,
  Plus,
  Search,
  Server,
  Settings as SettingsIcon,
  Trash2,
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
  const viewMode = useServers((s) => s.viewMode);
  const setViewMode = useServers((s) => s.setViewMode);
  const collapsedGroups = useServers((s) => s.collapsedGroups);
  const toggleGroup = useServers((s) => s.toggleGroup);

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (s: ServerConfig) =>
    !q ||
    s.name.toLowerCase().includes(q) ||
    s.host.toLowerCase().includes(q) ||
    s.username.toLowerCase().includes(q);

  // Group sections (only when not searching and in "groups" mode).
  const sections = [
    ...groups.map((g) => ({
      id: g.id,
      name: g.name,
      items: servers.filter((s) => s.groupId === g.id),
    })),
    {
      id: UNGROUPED,
      name: 'Ungrouped',
      items: servers.filter(
        (s) => !s.groupId || !groups.some((g) => g.id === s.groupId),
      ),
    },
  ].filter((sec) => sec.items.length > 0);

  const grouped = viewMode === 'groups' && !q;
  const filtered = servers.filter(matches);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-card/60">
      <div className="flex h-16 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Server className="size-4" />
          </span>
          ServerCase
        </div>
        <div className="flex items-center gap-2">
          <Button size="icon" variant="ghost" title="Settings" onClick={onOpenSettings}>
            <SettingsIcon />
          </Button>
          <Button size="icon" variant="outline" title="Add server" onClick={onAdd}>
            <Plus />
          </Button>
        </div>
      </div>

      <div className="space-y-2 border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            placeholder="Search servers…"
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          <Tabs
            value={viewMode}
            onValueChange={(v) => setViewMode(v as 'all' | 'groups')}
            className="flex-1"
          >
            <TabsList className="grid h-8 w-full grid-cols-2">
              <TabsTrigger value="all" className="text-xs">
                All
              </TabsTrigger>
              <TabsTrigger value="groups" className="text-xs">
                Groups
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            title="Manage groups"
            onClick={onManageGroups}
          >
            <Folders className="size-4" />
          </Button>
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

  return (
    <div
      className={cn(
        'group flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:bg-accent/70',
        selectedId === srv.id && 'border-border bg-accent',
      )}
      onClick={() => select(srv.id)}
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
      <Button
        size="icon"
        variant="ghost"
        className="size-7 opacity-0 group-hover:opacity-100"
        title="Edit"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(srv);
        }}
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Delete "${srv.name}"?`)) removeServer(srv.id);
        }}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
