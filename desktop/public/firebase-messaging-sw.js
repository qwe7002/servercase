/* global importScripts, firebase */
// FCM background message handler (desktop web push).
//
// The Firebase config is passed as query params at registration time (see
// src/lib/push.ts), so no project keys are committed here. Loads the compat
// SDK from gstatic; a service worker has its own context, so the page CSP does
// not apply to these importScripts.
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

const params = new URLSearchParams(self.location.search);
firebase.initializeApp({
  apiKey: params.get('apiKey'),
  authDomain: params.get('authDomain'),
  projectId: params.get('projectId'),
  messagingSenderId: params.get('messagingSenderId'),
  appId: params.get('appId'),
});

// Showing the notification is automatic for messages with a `notification`
// payload; initializing messaging here is enough to receive them in the
// background.
firebase.messaging();
