import type { ServerCaseApi } from '../electron/preload';

declare global {
  interface Window {
    servercase: ServerCaseApi;
  }
}

export {};
