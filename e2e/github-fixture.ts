import type { BrowserContext, Route } from '@playwright/test';

// A tiny stand-in for github.com, served through request routing. Pages share an inline
// "router" that, like GitHub's Turbo, intercepts link clicks, swaps the page body, and
// calls history.pushState — so the extension sees real SPA navigation, back/forward
// (popstate), and stale-then-updated DOM, without touching the network.

export interface FixtureFile {
  content: string;
}

const files: Record<string, string> = {
  'owner/repo@main:src/auth.ts': 'export function login() {\n  return checkPassword();\n}\n',
  'owner/repo@main:src/b.ts': 'export function other() {\n  return 42; // file b\n}\n',
  'owner/repo@dev:src/auth.ts': 'export function login() {\n  return checkPasswordV2();\n}\n',
  'owner/other@main:src/auth.ts': 'export function otherLogin() {\n  return 1234567;\n}\n',
};

function meta(owner: string, repo: string, isPublic: boolean) {
  return `<meta name="octolytics-dimension-repository_nwo" content="${owner}/${repo}"><meta name="octolytics-dimension-repository_public" content="${isPublic}">`;
}

function repoHeader(owner: string, repo: string, isPublic: boolean) {
  return `<div id="repository-container-header"><strong>${owner}/${repo}</strong> <span class="Label">${isPublic ? 'Public' : 'Private'}</span></div>`;
}

const ROUTER = `<script>
(function () {
  async function load(url, push) {
    const res = await fetch(url, { headers: { 'x-fixture-partial': '1' } });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    document.querySelectorAll('meta[name^="octolytics"]').forEach((m) => m.remove());
    doc.querySelectorAll('meta[name^="octolytics"]').forEach((m) => document.head.appendChild(m));
    document.title = doc.title;
    if (push) history.pushState({}, '', url);
    // GitHub paints the new content a moment after the URL changes.
    setTimeout(() => { document.body.innerHTML = doc.body.innerHTML; }, 60);
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/"], a[href^="https://github.com/"]');
    if (!a || a.target === '_blank') return;
    e.preventDefault();
    load(a.href, true);
  });
  window.addEventListener('popstate', () => load(location.href, false));
})();
</script>`;

function page(title: string, head: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title><style>body{margin:0}</style>${head}${ROUTER}</head><body>${body}</body></html>`;
}

const nav = `<nav>
  <a id="go-repo" href="/owner/repo">repo</a>
  <a id="go-other-repo" href="/owner/other">other repo</a>
  <a id="go-private" href="/owner/secret">private repo</a>
  <a id="go-auth" href="/owner/repo/blob/main/src/auth.ts">auth.ts</a>
  <a id="go-b" href="/owner/repo/blob/main/src/b.ts">b.ts</a>
  <a id="go-auth-dev" href="/owner/repo/blob/dev/src/auth.ts">auth.ts on dev</a>
  <a id="go-other-auth" href="/owner/other/blob/main/src/auth.ts">other/auth.ts</a>
  <a id="go-issue-5" href="/owner/repo/issues/5">issue 5</a>
  <a id="go-issue-6" href="/owner/repo/issues/6">issue 6</a>
</nav>`;

export function renderFixture(pathname: string): string | null {
  let m = pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (m) {
    const [, owner, repo, ref, path] = m;
    const content = files[`${owner}/${repo}@${ref}:${path}`];
    if (content == null) return null;
    const embedded = JSON.stringify({ payload: { refInfo: { name: ref }, path } });
    return page(
      `${path} at ${ref}`,
      meta(owner, repo, true),
      `${repoHeader(owner, repo, true)}${nav}<script type="application/json" data-target="react-app.embeddedData">${embedded}</script>
       <div data-testid="ai-code-viewer"><pre>${content}</pre></div>`,
    );
  }
  m = pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
  if (m) {
    const [, owner, repo, n] = m;
    return page(
      `Issue ${n}`,
      meta(owner, repo, true),
      `${repoHeader(owner, repo, true)}${nav}<h1 data-testid="issue-title">Bug number ${n}</h1>
       <div data-testid="issue-body"><div class="markdown-body">Something breaks in case ${n}.</div></div>`,
    );
  }
  m = pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (m) {
    const [, owner, repo] = m;
    const isPublic = repo !== 'secret';
    return page(`${owner}/${repo}`, meta(owner, repo, isPublic), `${repoHeader(owner, repo, isPublic)}${nav}<main>README</main>`);
  }
  return null;
}

export async function installGitHubFixture(context: BrowserContext): Promise<void> {
  await context.route('https://github.com/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const html = renderFixture(decodeURIComponent(url.pathname));
    if (html == null) return route.fulfill({ status: 404, body: 'Not found' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await context.route('https://raw.githubusercontent.com/**', async (route) => {
    const m = new URL(route.request().url()).pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    const content = m ? files[`${m[1]}/${m[2]}@${m[3]}:${decodeURIComponent(m[4])}`] : undefined;
    return route.fulfill({
      status: content == null ? 404 : 200,
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'text/plain',
      body: content ?? '404: Not Found',
    });
  });
  await context.route('https://api.github.com/**', (route) =>
    route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '[]' }),
  );
}
