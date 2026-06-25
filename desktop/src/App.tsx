import { useState } from 'react';
import type { ServerConfig } from '../electron/shared';
import { useServers } from './store/servers';
import { useConnections } from './useConnections';
import { ServerList } from './components/ServerList';
import { ServerForm } from './components/ServerForm';
import { Dashboard } from './components/Dashboard';

export function App() {
  useConnections();
  const servers = useServers((s) => s.servers);
  const selectedId = useServers((s) => s.selectedId);
  const selected = servers.find((s) => s.id === selectedId);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServerConfig | undefined>();

  const openAdd = () => {
    setEditing(undefined);
    setFormOpen(true);
  };
  const openEdit = (cfg: ServerConfig) => {
    setEditing(cfg);
    setFormOpen(true);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <ServerList onAdd={openAdd} onEdit={openEdit} />
      {selected ? (
        <Dashboard key={selected.id} server={selected} />
      ) : (
        <main className="flex flex-1 items-center justify-center">
          <div className="max-w-sm text-center text-sm text-muted-foreground">
            Select a server, or add one to get started.
          </div>
        </main>
      )}
      {formOpen && (
        <ServerForm existing={editing} onDone={() => setFormOpen(false)} />
      )}
    </div>
  );
}
