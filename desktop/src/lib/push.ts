/**
 * FCM web push for the desktop renderer.
 *
 * Caveat: web push needs a service worker, which requires the page to be served
 * over an http(s)-style origin. That holds under `vite dev`, but a packaged
 * Electron app loads over `file://` where service workers are unavailable — so
 * `initWebPush` simply returns null there and push is skipped. (Live updates
 * still arrive over the /v1/stream WebSocket while the window is open.)
 *
 * Config comes from VITE_FIREBASE_* env vars at build time (see .env.example).
 */
import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';

interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
}

function readConfig(): { config: FirebaseWebConfig; vapidKey: string } | null {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  const config: FirebaseWebConfig = {
    apiKey: env.VITE_FIREBASE_API_KEY ?? '',
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: env.VITE_FIREBASE_PROJECT_ID ?? '',
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId: env.VITE_FIREBASE_APP_ID ?? '',
  };
  const vapidKey = env.VITE_FIREBASE_VAPID_KEY ?? '';
  if (!vapidKey || Object.values(config).some((v) => !v)) return null;
  return { config, vapidKey };
}

/**
 * Initializes FCM web push and returns the registration token, or null when
 * push is unavailable (no config, no service-worker support, or denied).
 */
export async function initWebPush(): Promise<string | null> {
  const cfg = readConfig();
  if (!cfg) return null;
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    typeof Notification === 'undefined'
  ) {
    return null; // packaged Electron over file:// — see the module docstring
  }

  try {
    const app = initializeApp(cfg.config);
    const messaging = getMessaging(app);
    // The service worker hardcodes nothing — config is passed via the query so
    // no project keys are committed.
    const query = new URLSearchParams(cfg.config as unknown as Record<string, string>);
    const registration = await navigator.serviceWorker.register(
      `/firebase-messaging-sw.js?${query.toString()}`,
    );
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return null;

    const token = await getToken(messaging, {
      vapidKey: cfg.vapidKey,
      serviceWorkerRegistration: registration,
    });

    // Foreground messages don't auto-display; show them ourselves.
    onMessage(messaging, (payload) => {
      const note = payload.notification;
      if (note?.title) new Notification(note.title, { body: note.body });
    });

    return token || null;
  } catch (err) {
    console.warn('web push unavailable', err);
    return null;
  }
}
