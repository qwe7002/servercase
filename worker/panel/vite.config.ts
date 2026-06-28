import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Builds the static panel into ./dist, which the worker serves via Workers
// Static Assets (see ../wrangler.toml [assets]).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
