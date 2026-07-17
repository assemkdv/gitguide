import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import baseManifest from './manifest.json';

export default defineConfig(({ mode }) => {
  // Mirrors src/config.ts's own VITE_API_URL fallback exactly, so the manifest only
  // requests the localhost host permission when this specific build is actually going
  // to call it — not based on `vite`/`vite dev` vs. `vite build`, since the documented
  // local-dev flow (see README) is a `vite build` with VITE_API_URL left unset, not the
  // Vite dev server. A real production build (VITE_API_URL set to the deployed API
  // before building, per .env.example) never gets this extra, unused host permission.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiBaseUrl = env.VITE_API_URL || 'http://localhost:3000';
  const manifest = apiBaseUrl.startsWith('http://localhost')
    ? { ...baseManifest, host_permissions: [...baseManifest.host_permissions, 'http://localhost:3000/*'] }
    : baseManifest;

  return {
    plugins: [react(), crx({ manifest })],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      strictPort: true,
      hmr: {
        port: 5173,
      },
    },
  };
});
