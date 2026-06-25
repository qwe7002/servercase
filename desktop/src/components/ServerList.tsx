import type { ServerConfig } from '../../electron/shared';
import { useServers } from '../store/servers';

interface Props {
  onAdd: () => void;
  onEdit: (cfg: ServerConfig) => void;
}

const STATE_LABEL: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  error: 'Error',
  disconnected: 'Offline',
};

export function ServerList({ onAdd, onEdit }: Props) {
  const servers = useServers((s) => s.servers);
  const selectedId = useServers((s) => s.selectedId);
  const connState = useServers((s) => s.connState);
  const select = useServers((s) => s.select);
  const removeServer = useServers((s) => s.removeServer);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">ServerCase</span>
        <button className="icon" title="Add server" onClick={onAdd}>
          +
        </button>
      </div>

      <div className="server-items">
        {servers.length === 0 && (
          <p className="empty">No servers yet. Click + to add one.</p>
        )}
        {servers.map((srv) => {
          const state = connState[srv.id] ?? 'disconnected';
          return (
            <div
              key={srv.id}
              className={`server-item ${selectedId === srv.id ? 'active' : ''}`}
              onClick={() => select(srv.id)}
            >
              <span className={`dot ${state}`} />
              <div className="server-meta">
                <span className="server-name">{srv.name}</span>
                <span className="server-sub">
                  {srv.username}@{srv.host} · {STATE_LABEL[state]}
                </span>
              </div>
              <button
                className="icon ghost"
                title="Edit"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(srv);
                }}
              >
                ✎
              </button>
              <button
                className="icon ghost"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${srv.name}"?`)) removeServer(srv.id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
