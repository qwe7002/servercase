import { useEffect } from 'react';
import { useServers } from './store/servers';

/**
 * Wires global connection events from the main process into the store, and
 * polls status for the currently selected, connected server.
 */
export function useConnections(): void {
  const selectedId = useServers((s) => s.selectedId);
  const connState = useServers((s) => s.connState);
  const setConnState = useServers((s) => s.setConnState);
  const setStatus = useServers((s) => s.setStatus);

  // Subscribe once to connection-state pushes.
  useEffect(() => {
    if (!window.servercase) return;
    return window.servercase.onConnectionEvent((e) => {
      setConnState(e.serverId, e.state, e.error);
    });
  }, [setConnState]);

  // Poll status for the selected, connected server.
  useEffect(() => {
    const api = window.servercase;
    if (
      !api ||
      !selectedId ||
      connState[selectedId] !== 'connected'
    ) {
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await api.fetchStatus(selectedId);
        if (!cancelled) setStatus(selectedId, status);
      } catch {
        // Transient errors are surfaced via connection events; ignore here.
      }
    };

    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedId, connState, setStatus]);
}
