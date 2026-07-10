import { useEffect, useRef } from 'react';
import { useSettings } from './store/settings';
import { useServers } from './store/servers';
import { useCloud } from './store/cloud';
import { cloudPush, registerPushDevice } from './lib/cloud';
import { initWebPush } from './lib/push';

/**
 * Applies the global settings to the main process: keeps the Bitwarden vault
 * configured, loads vault secrets into memory once the vault is unlocked, and
 * drives cloud auto-push and FCM push registration.
 */
export function useGlobalSettings(): void {
  const bitwarden = useSettings((s) => s.settings.bitwarden);
  const cloud = useSettings((s) => s.settings.cloud);
  const cloudToken = useCloud((s) => s.token);
  const loadSecretsFromVault = useServers((s) => s.loadSecretsFromVault);
  const registeredFcm = useRef<string | null>(null);

  // Mirror the current Bitwarden settings into the main-process vault.
  useEffect(() => {
    void window.servercase?.bw.configure(bitwarden);
  }, [bitwarden]);

  // When the vault is enabled, auto-unlock with the OS-keychain-stored master
  // password if possible (as on iOS), then pull secrets into memory.
  useEffect(() => {
    const api = window.servercase;
    if (!api || !bitwarden.enabled) return;
    let cancelled = false;
    void (async () => {
      let status = await api.bw.status();
      if (status.state === 'locked') {
        status = await api.bw.unlockStored().catch(() => status);
      }
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

  // Register an FCM web-push token with the worker once signed in. No-ops when
  // push is unavailable (no Firebase config, or packaged Electron — see lib/push).
  useEffect(() => {
    if (!cloud.enabled || !cloudToken) return;
    let cancelled = false;
    void (async () => {
      const fcm = await initWebPush();
      if (cancelled || !fcm || registeredFcm.current === fcm) return;
      await registerPushDevice(fcm)
        .then(() => {
          registeredFcm.current = fcm;
        })
        .catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [cloud.enabled, cloudToken]);
}
