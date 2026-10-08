import { test as base, expect, chromium, BrowserContext, Page, Locator } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockApi, MOCK_SHA } from './mock-api';
import { installGitHubFixture } from './github-fixture';
import { E2E_API_PORT, E2E_DIST } from './global-setup';

const test = base.extend<{ context: BrowserContext; page: Page; api: MockApi }>({
  // eslint-disable-next-line no-empty-pattern
  api: async ({}, use) => {
    const api = new MockApi(E2E_API_PORT);
    await api.start();
    await use(api);
    await api.stop();
  },
  context: async ({ api: _api }, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'gitguide-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${E2E_DIST}`, `--load-extension=${E2E_DIST}`],
    });
    await installGitHubFixture(context);
    await use(context);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()));
  },
});

const panel = (page: Page): Locator => page.locator('#gitguide-panel');

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'Open GitGuide panel' }).click();
  await expect(panel(page)).toBeVisible();
}

async function runQuickAction(page: Page, label: string) {
  await panel(page).getByRole('button', { name: new RegExp(label) }).click();
}

async function spaClick(page: Page, id: string) {
  await page.locator(`#${id}`).first().click();
}

test.describe('GitGuide extension in Chromium', () => {
  test('Quick Actions show where data goes without blocking; the first action runs immediately', async ({ page, api }) => {
    await page.goto('https://github.com/owner/repo');
    await openPanel(page);
    await expect(panel(page)).toContainText('Public repositories only.');
    await expect(panel(page)).toContainText('uses Groq to answer');
    await expect(panel(page)).not.toContainText('can be wrong');
    expect(await panel(page).innerText()).not.toContain('\u2014');
    expect(api.requests).toHaveLength(0); // opening the panel sends nothing

    // The disclosure links to the full Privacy & data screen, which keeps the clear control.
    await panel(page).getByRole('button', { name: 'Privacy & data', exact: true }).click();
    await expect(panel(page).getByRole('heading', { name: 'Privacy & data' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: /Clear chat history and cached explanations/ })).toBeVisible();
    await expect(panel(page)).not.toContainText('acknowledged');
    expect(await panel(page).innerText()).not.toContain('\u2014');
    await panel(page).getByRole('button', { name: 'Back' }).click();

    await runQuickAction(page, 'Explain Repository');
    await expect(panel(page)).toContainText('Explains repo');
    await expect(panel(page)).toContainText(`Based on main @ ${MOCK_SHA.slice(0, 7)}`);
    expect(api.requestsTo('/v1/explain-repo')[0].body).toEqual({ repoOwner: 'owner', repoName: 'repo' });
  });

  test('SPA navigation: a slow answer for file A never appears on file B; only identifiers are sent', async ({ page, api }) => {
    api.on('/v1/explain-file', async (body, res) => {
      if (body.filePath === 'src/auth.ts') await new Promise((r) => setTimeout(r, 2000));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ purpose: `Explains ${body.repoName}:${body.filePath}@${body.ref}`, summary: 's', relatedFiles: [] }));
    });
    api.on('/v1/explain-file/quick', (_body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ purpose: '', summary: '' })); // unusable → ignored
    });

    await page.goto('https://github.com/owner/repo/blob/main/src/auth.ts');
    await openPanel(page);
    await runQuickAction(page, 'Explain File');
    await expect.poll(() => api.requestsTo('/v1/explain-file').length).toBe(1);

    await spaClick(page, 'go-b');
    await expect(page).toHaveURL(/src\/b\.ts$/);
    await expect(panel(page)).toContainText('Explains repo:src/b.ts@main');
    await page.waitForTimeout(2500); // the slow auth.ts response has now arrived
    await expect(panel(page)).not.toContainText('src/auth.ts@main');
    await expect(panel(page)).toContainText('Explains repo:src/b.ts@main');

    for (const r of [...api.requestsTo('/v1/explain-file'), ...api.requestsTo('/v1/explain-file/quick')]) {
      expect(Object.keys(r.body).sort()).toEqual(['filePath', 'ref', 'repoName', 'repoOwner']);
    }
  });

  test('back/forward, branch switches, and same paths in other repositories each show their own answer', async ({ page, api }) => {
    await page.goto('https://github.com/owner/repo/blob/main/src/auth.ts');
    await openPanel(page);
    await runQuickAction(page, 'Explain File');
    await expect(panel(page)).toContainText('Explains repo:src/auth.ts@main');

    await spaClick(page, 'go-b');
    await expect(panel(page)).toContainText('Explains repo:src/b.ts@main');

    await page.goBack();
    await expect(page).toHaveURL(/blob\/main\/src\/auth\.ts$/);
    await expect(panel(page)).toContainText('Explains repo:src/auth.ts@main');
    await page.goForward();
    await expect(panel(page)).toContainText('Explains repo:src/b.ts@main');
    // Revisits are served from the local cache.
    expect(api.requestsTo('/v1/explain-file').length).toBe(2);

    // A full reload reads b.ts fresh from the server-rendered page, so it hits the cache
    // only if the in-page visit stored b.ts under b.ts's own content (not the previous
    // file's, which is still on screen right after an in-place navigation).
    await page.reload();
    await openPanel(page);
    await runQuickAction(page, 'Explain File');
    await expect(panel(page)).toContainText('Explains repo:src/b.ts@main');
    expect(api.requestsTo('/v1/explain-file').length).toBe(2);

    await spaClick(page, 'go-auth-dev');
    await expect(panel(page)).toContainText('Explains repo:src/auth.ts@dev');
    expect(api.requestsTo('/v1/explain-file').at(-1)?.body.ref).toBe('dev');

    // A different repository with the same path: the panel returns to Quick Actions and
    // nothing from owner/repo is shown; explaining the file gives the other repo's answer.
    await spaClick(page, 'go-other-auth');
    await expect(panel(page)).toContainText('Quick actions');
    await expect(panel(page)).not.toContainText('Explains repo:');
    await runQuickAction(page, 'Explain File');
    await expect(panel(page)).toContainText('Explains other:src/auth.ts@main');
  });

  test('Refresh re-requests a cached explanation', async ({ page, api }) => {
    await page.goto('https://github.com/owner/repo');
    await openPanel(page);
    await runQuickAction(page, 'Explain Repository');
    await expect(panel(page)).toContainText('Explains repo');
    await panel(page).getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => api.requestsTo('/v1/explain-repo').length).toBe(2);
    await expect(panel(page)).toContainText('Explains repo');
  });

  test('issue to issue navigation analyzes the right issue and sends only its number', async ({ page, api }) => {
    await page.goto('https://github.com/owner/repo/issues/5');
    await openPanel(page);
    await runQuickAction(page, 'Summarize Issue');
    await expect(panel(page)).toContainText('Fix issue 5');
    await spaClick(page, 'go-issue-6');
    await expect(panel(page)).toContainText('Fix issue 6');
    expect(api.requestsTo('/v1/analyze').map((r) => r.body)).toEqual([
      { repoOwner: 'owner', repoName: 'repo', issueNumber: 5 },
      { repoOwner: 'owner', repoName: 'repo', issueNumber: 6 },
    ]);
  });

  test('chat streams Markdown with citations and survives closing and reopening the panel', async ({ page }) => {
    await page.goto('https://github.com/owner/repo');
    await openPanel(page);
    await runQuickAction(page, 'Ask GitGuide');
    const input = panel(page).getByRole('textbox', { name: 'Ask about this repository' });
    await input.fill('where is login?');
    await input.press('Enter');

    await expect(panel(page)).toContainText('You asked: where is login?');
    await expect(panel(page).locator('.gg-md code', { hasText: 'src/auth.ts' })).toBeVisible();
    const citation = panel(page).getByRole('link', { name: /src\/auth\.ts:1-3/ });
    await expect(citation).toHaveAttribute('href', `https://github.com/owner/repo/blob/${MOCK_SHA}/src/auth.ts#L1-L3`);
    await expect(citation).toHaveAttribute('target', '_blank');
    await expect(panel(page)).toContainText('searched all 3 indexed files');

    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open GitGuide panel' })).toBeFocused();
    await openPanel(page);
    await expect(panel(page)).toContainText('You asked: where is login?');
  });

  test('an interrupted answer is labelled and can be retried', async ({ page, api }) => {
    api.on('/v1/ask-repo', (_body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'Half an ans' })}\n\n`);
      setTimeout(() => res.destroy(), 100);
    });
    await page.goto('https://github.com/owner/repo');
    await openPanel(page);
    await runQuickAction(page, 'Ask GitGuide');
    const input = panel(page).getByRole('textbox', { name: 'Ask about this repository' });
    await input.fill('q1');
    await input.press('Enter');
    await expect(panel(page)).toContainText(/interrupted|cut off/);
    await expect(panel(page)).toContainText('Half an ans');

    api.reset();
    await panel(page).getByRole('button', { name: 'Retry' }).click();
    await expect(panel(page)).toContainText('You asked: q1');
    await expect(panel(page)).not.toContainText('Half an ans');
  });

  test('Stop ends generation and the server sees the disconnect', async ({ page, api }) => {
    let serverSawClose = false;
    api.on('/v1/ask-repo', (_body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      const timer = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'more ' })}\n\n`), 200);
      res.on('close', () => {
        serverSawClose = true;
        clearInterval(timer);
      });
    });
    await page.goto('https://github.com/owner/repo');
    await openPanel(page);
    await runQuickAction(page, 'Ask GitGuide');
    const input = panel(page).getByRole('textbox', { name: 'Ask about this repository' });
    await input.fill('long question');
    await input.press('Enter');
    await expect(panel(page)).toContainText('more');
    await panel(page).getByRole('button', { name: 'Stop generating' }).click();
    await expect(panel(page)).toContainText('Stopped.');
    await expect.poll(() => serverSawClose).toBe(true);
    await expect(panel(page).getByRole('button', { name: 'Send message' })).toBeVisible();
  });

  test('API errors are explained, with retry only where it makes sense', async ({ page, api }) => {
    api.on('/v1/explain-repo', (_body, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'GitHub is rate-limiting GitGuide right now. Please try again later.', code: 'GITHUB_RATE_LIMITED', retryAfterSec: 600 }));
    });
    await page.goto('https://github.com/owner/repo');
    await openPanel(page);
    await runQuickAction(page, 'Explain Repository');
    await expect(panel(page).getByRole('alert')).toContainText('about 10 minutes');
    await expect(panel(page).getByRole('button', { name: 'Retry' })).toBeVisible();

    api.on('/v1/explain-repo', (_body, res) => res.destroy());
    await panel(page).getByRole('button', { name: 'Retry' }).click();
    await expect(panel(page).getByRole('alert')).toContainText("Couldn't reach the GitGuide server");
  });

  test('private repositories: nothing is sent', async ({ page, api }) => {
    await page.goto('https://github.com/owner/secret');
    await openPanel(page);
    await runQuickAction(page, 'Explain Repository');
    await expect(panel(page).getByRole('alert')).toContainText('public GitHub repositories only');
    await expect(panel(page).getByRole('button', { name: 'Retry' })).toHaveCount(0);
    expect(api.requests).toHaveLength(0);
  });

  test('a corrupted saved panel width falls back to the default; the page is not covered on wide windows', async ({ page, context }) => {
    await page.goto('https://github.com/owner/repo');
    await page.evaluate(() => localStorage.setItem('gitguide-panel-width', 'not-a-number'));
    await page.reload();
    await openPanel(page);
    const box = await panel(page).boundingBox();
    expect(box?.width).toBe(400);
    expect(await page.evaluate(() => localStorage.getItem('gitguide-panel-width'))).toBeNull();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).marginRight)).toBe('400px');

    const [worker] = context.serviceWorkers();
    await worker.evaluate(() => chrome.storage.local.set({ 'settings:panelWidth': { bogus: true } }));
    await page.reload();
    await openPanel(page);
    expect((await panel(page).boundingBox())?.width).toBe(400);
  });

  test('narrow windows: the panel overlays the page and fits the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 700 });
    await page.goto('https://github.com/owner/repo');
    await openPanel(page);
    const box = await panel(page).boundingBox();
    expect(box!.width).toBeLessThanOrEqual(360);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).marginRight)).toBe('0px');
    await expect(panel(page).getByRole('button', { name: 'Close GitGuide panel' })).toBeVisible();
  });

  test('typing in the panel does not trigger GitHub keyboard shortcuts', async ({ page }) => {
    await page.goto('https://github.com/owner/repo');
    await page.evaluate(() => {
      (window as any).__shortcuts = 0;
      document.addEventListener('keydown', () => (window as any).__shortcuts++);
    });
    await openPanel(page);
    await runQuickAction(page, 'Ask GitGuide');
    await panel(page).getByRole('textbox', { name: 'Ask about this repository' }).pressSequentially('st');
    expect(await page.evaluate(() => (window as any).__shortcuts)).toBe(0);
  });
});
