import { useEffect } from 'react';
import { useSettings } from './store/settings';
import { useServers } from './store/servers';
import { cloudPush } from './lib/cloud';

/**
 * Applies the global settings to the main process: keeps the Bitwarden vault
 * configured, loads vault secrets into memory once the vault is unlocked, and
 * drives the periodic config auto-sync.
 */
export function useGlobalSettings(): void {
  const bitwarden = useSettings((s) => s.settings.bitwarden);
  const cloud = useSettings((s) => s.settings.cloud);
  const loadSecretsFromVault = useServers((s) => s.loadSecretsFromVault);

  // Mirror the current Bitwarden settings into the main-process vault.
  useEffect(() => {
    void window.servercase?.bw.configure(bitwarden);
  }, [bitwarden]);

  // When the vault is enabled and already unlocked, pull secrets into memory.
  useEffect(() => {
    const api = window.servercase;
    if (!api || !bitwarden.enabled) return;
    let cancelled = false;
    void (async () => {
      const status = await api.bw.status();
      if (!cancelled && status.state === 'unlocked') {
        await loadSecretsFromVault().catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bitwarden.enabled, loadSecretsFromVault]);

  // Auto-push the config to the cloud (debounced) when servers/settings change.
  useEffect(() => {
    if (!cloud.enabled || !cloud.autoPush) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void cloudPush().catch(() => undefined), 3000);
    };
    const unsubServers = useServers.subscribe((state, prev) => {
      if (state.servers !== prev.servers) schedule();
    });
    const unsubSettings = useSettings.subscribe((state, prev) => {
      if (state.settings !== prev.settings) schedule();
    });
    return () => {
      clearTimeout(timer);
      unsubServers();
      unsubSettings();
    };
  }, [cloud.enabled, cloud.autoPush]);
}
