import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import baseManifest from './manifest.json';

// Two build modes:
//   vite build                      → release (mode "production", reads .env.production)
//   vite build --mode development   → local development (reads .env.development[.local])
//
// The API URL is fixed at build time and the manifest's host permission is derived from
// it, so the permission can never drift from the server the bundle actually calls. A
// release build refuses anything but an https, non-localhost API URL.
export function apiHostPermission(apiUrl: string, mode: string): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error(`VITE_API_URL is not a valid URL: ${JSON.stringify(apiUrl)}`);
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (mode === 'production') {
    if (url.protocol !== 'https:') throw new Error(`Release builds require an https VITE_API_URL (got ${apiUrl}).`);
    if (isLocal) throw new Error('Release builds cannot point at localhost. Use `npm run build:dev` for local development.');
  } else if (url.protocol !== 'https:' && !isLocal) {
    throw new Error(`VITE_API_URL must be https unless it points at localhost (got ${apiUrl}).`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`VITE_API_URL must be an origin without a path (got ${apiUrl}).`);
  }
  return `${url.origin}/*`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiUrl = env.VITE_API_URL || (mode === 'production' ? '' : 'http://localhost:3000');
  if (!apiUrl) throw new Error('VITE_API_URL must be set for a release build (see apps/extension/.env.production).');

  const manifest = {
    ...baseManifest,
    host_permissions: [apiHostPermission(apiUrl, mode)],
  };

  return {
    plugins: [react(), crx({ manifest })],
    define: {
      // Bake the validated value in, so config.ts can never fall back to localhost in a
      // release bundle even if the environment variable was missing at runtime.
      'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: mode !== 'production',
      minify: mode === 'production',
    },
    server: {
      port: 5173,
      strictPort: true,
      hmr: { port: 5173 },
    },
  };
});
