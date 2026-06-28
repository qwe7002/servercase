import { useEffect } from 'react';
import { cloudApi } from './lib/cloud';
import { openProbeStream } from './lib/cloudStream';
import { useCloud, hasValidSession } from './store/cloud';
import { useProbes } from './store/probes';
import { useSettings } from './store/settings';

/** Keeps cloud probe roster and live snapshots available app-wide. */
export function useProbeStatus(): void {
  const url = useSettings((s) => s.settings.cloud.url);
  const token = useCloud((s) => s.token);
  const expiresAt = useCloud((s) => s.expiresAt);
  const setHosts = useProbes((s) => s.setHosts);
  const setStreamStatus = useProbes((s) => s.setStreamStatus);
  const setError = useProbes((s) => s.setError);
  const upsertSnapshot = useProbes((s) => s.upsertSnapshot);
  const clear = useProbes((s) => s.clear);

  useEffect(() => {
    if (!url || !hasValidSession({ token, expiresAt }) || !token) {
      clear();
      return;
    }

    let cancelled = false;
    void cloudApi
      .listProbes(url, token)
      .then((res) => {
        if (!cancelled) setHosts(res.hosts);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });

    const stream = openProbeStream(url, token, {
      onStatus: setStreamStatus,
      onSnapshot: (hostId, snapshot) => upsertSnapshot(hostId, snapshot),
    });

    return () => {
      cancelled = true;
      stream.close();
    };
  }, [
    clear,
    expiresAt,
    setError,
    setHosts,
    setStreamStatus,
    token,
    upsertSnapshot,
    url,
  ]);
}
