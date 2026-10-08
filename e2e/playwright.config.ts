import { defineConfig } from '@playwright/test';

// Real-Chromium tests of the built MV3 extension against fixture GitHub pages and a
// local mock API (no network, no Groq, no live GitHub). See e2e/README.md.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
