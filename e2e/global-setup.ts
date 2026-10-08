import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const E2E_API_PORT = 4319;
export const E2E_DIST = join(__dirname, '..', 'apps', 'extension', 'dist-e2e');

/** Builds the extension (development mode) pointed at the local mock API. */
export default function globalSetup(): void {
  execFileSync('npx', ['vite', 'build', '--mode', 'development', '--outDir', 'dist-e2e', '--logLevel', 'warn'], {
    cwd: join(__dirname, '..', 'apps', 'extension'),
    env: { ...process.env, VITE_API_URL: `http://localhost:${E2E_API_PORT}` },
    stdio: 'inherit',
  });
}
