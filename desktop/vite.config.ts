import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

// Electron main + preload are built by vite-plugin-electron into dist-electron/.
// The React renderer is built by Vite into dist/.
export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external: ['ssh2', 'electron'] },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload();
        },
        vite: { build: { outDir: 'dist-electron' } },
      },
    ]),
    renderer(),
  ],
  build: {
    outDir: 'dist',
  },
});
