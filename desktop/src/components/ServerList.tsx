import type { ServerConfig } from '../../electron/shared';
import { useServers } from '../store/servers';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Pencil, Plus, Server, Settings as SettingsIcon, Trash2 } from 'lucide-react';

interface Props {
  onAdd: () => void;
  onEdit: (cfg: ServerConfig) => void;
  onOpenSettings: () => void;
}

const STATE_LABEL: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  error: 'Error',
  disconnected: 'Offline',
};

export function ServerList({ onAdd, onEdit, onOpenSettings }: Props) {
  const servers = useServers((s) => s.servers);
  const selectedId = useServers((s) => s.selectedId);
  const connState = useServers((s) => s.connState);
  const select = useServers((s) => s.select);
  const removeServer = useServers((s) => s.removeServer);

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
          <Button
            size="icon"
            variant="ghost"
            title="Settings"
            onClick={onOpenSettings}
          >
            <SettingsIcon />
          </Button>
          <Button size="icon" variant="outline" title="Add server" onClick={onAdd}>
            <Plus />
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {servers.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            No servers yet. Add one to get started.
          </p>
        )}
        {servers.map((srv) => {
          const state = connState[srv.id] ?? 'disconnected';
          return (
            <div
              key={srv.id}
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
        })}
      </div>
    </aside>
  );
}
