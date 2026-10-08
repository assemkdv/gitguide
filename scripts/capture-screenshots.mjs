#!/usr/bin/env node
// Captures Chrome Web Store screenshots (1280x800) of a working build on real github.com.
//
// Prerequisites (see docs/CHROME_WEB_STORE.md):
//   1. API running locally with a real GROQ_API_KEY:  PORT=3999 node apps/api/dist/index.js
//   2. Extension built against it:
//        VITE_API_URL=http://localhost:3999 npm run build:dev --workspace=apps/extension -- --outDir dist-screens
// Usage: node scripts/capture-screenshots.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, 'apps/extension/dist-screens');
const outDir = join(root, 'docs/store/screenshots');
mkdirSync(outDir, { recursive: true });

const userDataDir = mkdtempSync(join(tmpdir(), 'gitguide-shots-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});
const page = context.pages()[0] ?? (await context.newPage());
const panel = page.locator('#gitguide-panel');

async function open(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open GitGuide panel' }).click();
  await panel.waitFor({ state: 'visible' });
}

async function shot(name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, name) });
  console.log(`✓ ${name}`);
}

// ONLY=home captures just Quick Actions with the data disclosure (no API needed), e.g. from
// a build carrying the production API URL.
const only = process.env.ONLY;

try {
  // 1. Quick Actions, with the short disclosure of where data goes.
  await open('https://github.com/sindresorhus/slugify');
  await panel.getByText('Public repositories only.').waitFor();
  await shot('1-quick-actions.png');
  if (only === 'home') throw new Error('done');

  // 2. Repository overview.
  await panel.getByRole('button', { name: /Explain Repository/ }).click();
  await panel.getByText(/Based on main @/).waitFor({ timeout: 90_000 });
  await shot('2-explain-repository.png');

  // 3. File explanation pinned to a tag.
  await open('https://github.com/sindresorhus/slugify/blob/v2.2.1/index.js');
  await panel.getByRole('button', { name: /Explain File/ }).click();
  await panel.getByText(/Based on v2\.2\.1 @/).waitFor({ timeout: 90_000 });
  await shot('3-explain-file.png');

  // 4. Ask GitGuide with citations.
  await panel.getByRole('button', { name: /Back to Quick Actions/ }).click();
  await panel.getByRole('button', { name: /Ask GitGuide/ }).click();
  const input = panel.getByRole('textbox', { name: 'Ask about this repository' });
  await input.fill('How does slugifyWithCounter avoid duplicate slugs?');
  await input.press('Enter');
  await panel.getByRole('button', { name: 'Send message' }).waitFor({ timeout: 120_000 });
  await shot('4-ask-gitguide.png');
} catch (err) {
  if (err.message !== 'done') throw err;
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
