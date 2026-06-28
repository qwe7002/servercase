import { create } from 'zustand';
import type { ProbeHost } from '../lib/cloud';
import type { ProbeSnapshotV1, StreamStatus } from '../lib/cloudStream';

export interface ProbeHostView {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  snapshot: ProbeSnapshotV1 | null;
}

function toView(host: ProbeHost): ProbeHostView {
  return {
    id: host.id,
    name: host.name,
    createdAt: host.createdAt,
    lastSeenAt: host.lastSeenAt,
    snapshot: (host.latest as ProbeSnapshotV1 | null) ?? null,
  };
}

interface ProbesState {
  hosts: ProbeHostView[];
  streamStatus: StreamStatus;
  error: string | null;

  setHosts: (hosts: ProbeHost[]) => void;
  setStreamStatus: (status: StreamStatus) => void;
  setError: (error: string | null) => void;
  removeHost: (id: string) => void;
  upsertSnapshot: (hostId: string, snapshot: ProbeSnapshotV1, lastSeenAt?: number) => void;
  clear: () => void;
}

export const useProbes = create<ProbesState>()((set) => ({
  hosts: [],
  streamStatus: 'closed',
  error: null,

  setHosts: (hosts) => set({ hosts: hosts.map(toView), error: null }),
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  setError: (error) => set({ error }),
  removeHost: (id) =>
    set((s) => ({ hosts: s.hosts.filter((host) => host.id !== id) })),
  upsertSnapshot: (hostId, snapshot, lastSeenAt = Date.now()) =>
    set((s) => ({
      hosts: s.hosts.map((host) =>
        host.id === hostId ? { ...host, snapshot, lastSeenAt } : host,
      ),
    })),
  clear: () => set({ hosts: [], streamStatus: 'closed', error: null }),
}));
