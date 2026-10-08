import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installChromeMock, deferred, flush, ChromeMock } from '../test/chrome-mock';
import { useStore } from './store';
import type { PageContext } from './store';
import { runExplainRepo, runExplainFile, runSummarizeIssue, runGoodFirstIssues, abortAllRequests, targetOf } from './runActions';
import { cacheKeys, fingerprint } from './storage';

const SHA = 'a'.repeat(40);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const repoResult = (purpose: string) => ({ purpose, techStack: [], keyEntrypoints: [], goodFirstIssues: [], meta: { ref: 'main', commitSha: SHA } });
const fileResult = (purpose: string) => ({ purpose, summary: 's', relatedFiles: [], meta: { ref: 'main', commitSha: SHA, truncated: false } });
const issueResult = (what: string) => ({ whatItAsks: [what], relevantFiles: [] });

const repoA: PageContext = { repoOwner: 'owner', repoName: 'repoA', page: 'repo' };
const repoB: PageContext = { repoOwner: 'owner', repoName: 'repoB', page: 'repo' };
function file(overrides: Partial<PageContext> = {}): PageContext {
  return { repoOwner: 'owner', repoName: 'repo', page: 'file', filePath: 'src/auth.ts', fileRef: 'main', fileContent: 'x'.repeat(40), ...overrides };
}
function issue(n: number, overrides: Partial<PageContext> = {}): PageContext {
  return { repoOwner: 'owner', repoName: 'repo', page: 'issue', issueNumber: n, issueTitle: `Bug ${n}`, ...overrides };
}

/** fetch stub where each call waits for the test to resolve it. */
function controllableFetch() {
  const calls: { url: string; body: any; signal: AbortSignal; respond: (r: Response) => void; fail: (e: unknown) => void }[] = [];
  const fn = vi.fn((url: string, init: RequestInit) => {
    const d = deferred<Response>();
    const signal = init.signal as AbortSignal;
    signal?.addEventListener('abort', () => d.reject(new DOMException('aborted', 'AbortError')));
    calls.push({ url, body: JSON.parse(String(init.body)), signal, respond: d.resolve, fail: d.reject });
    return d.promise;
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls, full: () => calls.filter((c) => !c.url.endsWith('/quick')) };
}

function navigate(ctx: PageContext | null) {
  useStore.setState({ pageContext: ctx });
}

let chrome: ChromeMock;

beforeEach(() => {
  abortAllRequests();
  vi.unstubAllGlobals();
  chrome = installChromeMock();
  useStore.setState(useStore.getInitialState());
  useStore.setState({ consentAccepted: true });
  document.head.innerHTML = '';
});

describe('target identity', () => {
  it('includes repository, ref, and path for files, and repository + number for issues', () => {
    expect(targetOf('file', file())).toBe('file:owner/repo@main:src/auth.ts');
    expect(targetOf('file', file({ repoName: 'other' }))).not.toBe(targetOf('file', file()));
    expect(targetOf('file', file({ fileRef: 'dev' }))).not.toBe(targetOf('file', file()));
    expect(targetOf('issue', issue(3))).toBe('issue:owner/repo#3');
    expect(targetOf('file', repoA)).toBeNull();
  });
});

describe('slow A → B navigation', () => {
  it('a late success for repo A never appears on repo B', async () => {
    const f = controllableFetch();
    navigate(repoA);
    const pending = runExplainRepo(repoA);
    await flush();
    navigate(repoB);
    await flush();
    expect(f.calls[0].signal.aborted).toBe(true); // obsolete network work is cancelled
    f.calls[0].respond(jsonResponse(repoResult('A')));
    await pending;
    expect(useStore.getState().repoResult).toBeNull();
    expect(useStore.getState().repoLoading).toBe(false);
  });

  it("a late failure for page A doesn't put an error on page B", async () => {
    const f = controllableFetch();
    navigate(file());
    const pending = runExplainFile(file());
    await flush();
    navigate(file({ filePath: 'src/other.ts' }));
    f.full()[0].fail(new TypeError('network down'));
    await pending;
    expect(useStore.getState().fileError).toBeNull();
  });

  it("an old request's cleanup can't clear the loading state of the new page's request", async () => {
    const f = controllableFetch();
    navigate(issue(5));
    const first = runSummarizeIssue(issue(5));
    await flush();
    navigate(issue(6));
    const second = runSummarizeIssue(issue(6));
    await flush();
    f.calls[0].fail(new TypeError('late failure'));
    await first;
    expect(useStore.getState().issueLoading).toBe(true); // issue 6 still loading
    f.calls[1].respond(jsonResponse(issueResult('six')));
    await second;
    expect(useStore.getState().issueResult?.whatItAsks).toEqual(['six']);
    expect(useStore.getState().issueLoading).toBe(false);
  });
});

describe('identical paths across repositories and branches', () => {
  it('a result for owner/repoX:src/auth.ts never lands on owner/repoY:src/auth.ts', async () => {
    const f = controllableFetch();
    const x = file({ repoName: 'repoX' });
    const y = file({ repoName: 'repoY' });
    navigate(x);
    const pending = runExplainFile(x);
    await flush();
    navigate(y);
    for (const c of f.calls) c.respond(jsonResponse(c.url.endsWith('/quick') ? { purpose: 'quick X', summary: '' } : fileResult('X')));
    await pending;
    await flush();
    const s = useStore.getState();
    expect(s.fileResult).toBeNull();
    expect(s.fileQuickResult).toBeNull(); // the quick pass checks repository and ref too
  });

  it('a branch switch on the same path discards the other branch’s answer and quick preview', async () => {
    const f = controllableFetch();
    navigate(file({ fileRef: 'main' }));
    const pending = runExplainFile(file({ fileRef: 'main' }));
    await flush();
    navigate(file({ fileRef: 'release/v2' }));
    for (const c of f.calls) c.respond(jsonResponse(c.url.endsWith('/quick') ? { purpose: 'q', summary: '' } : fileResult('main')));
    await pending;
    await flush();
    expect(useStore.getState().fileResult).toBeNull();
    expect(useStore.getState().fileQuickResult).toBeNull();
  });

  it('sends only identifiers (ref + path), never the page content', async () => {
    const f = controllableFetch();
    navigate(file({ fileRef: 'v1.2.0', fileContent: 'SECRET-LOOKING PAGE TEXT '.repeat(3) }));
    const pending = runExplainFile(useStore.getState().pageContext!);
    await flush();
    for (const c of f.calls) {
      expect(c.body).toEqual({ repoOwner: 'owner', repoName: 'repo', ref: 'v1.2.0', filePath: 'src/auth.ts' });
      c.respond(jsonResponse(c.url.endsWith('/quick') ? { purpose: 'q', summary: '' } : fileResult('ok')));
    }
    await pending;
  });

  it('issue requests carry only the issue number', async () => {
    const f = controllableFetch();
    navigate(issue(9, { issueBody: 'body text', issueComments: 'comments' }));
    const pending = runSummarizeIssue(useStore.getState().pageContext!);
    await flush();
    expect(f.calls[0].body).toEqual({ repoOwner: 'owner', repoName: 'repo', issueNumber: 9 });
    f.calls[0].respond(jsonResponse(issueResult('x')));
    await pending;
  });
});

describe('cache reads are owned too', () => {
  it('a slow cache hit for A is not applied after navigating to B', async () => {
    const ctx = file();
    chrome.store[cacheKeys.file('owner', 'repo', 'main', 'src/auth.ts')] = {
      data: fileResult('cached A'),
      savedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const gate = deferred<void>();
    const realGet = (globalThis as any).chrome.storage.local.get;
    (globalThis as any).chrome.storage.local.get = async (k: unknown) => {
      await gate.promise;
      return realGet(k);
    };
    controllableFetch();
    navigate(ctx);
    const pending = runExplainFile(ctx);
    navigate(file({ filePath: 'src/b.ts' }));
    gate.resolve();
    await pending;
    expect(useStore.getState().fileResult).toBeNull();
    expect(useStore.getState().fileLoading).toBe(false);
  });

  it('ignores a cached explanation produced for different file content', async () => {
    const ctx = file({ fileContent: 'new content '.repeat(5) });
    chrome.store[cacheKeys.file('owner', 'repo', 'main', 'src/auth.ts')] = {
      data: fileResult('stale'),
      savedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      fingerprint: fingerprint('old content '.repeat(5)),
    };
    const f = controllableFetch();
    navigate(ctx);
    const pending = runExplainFile(ctx);
    await flush();
    expect(f.full()).toHaveLength(1); // cache miss → network
    for (const c of f.calls) c.respond(jsonResponse(c.url.endsWith('/quick') ? { purpose: 'q', summary: '' } : fileResult('fresh')));
    await pending;
    expect(useStore.getState().fileResult?.purpose).toBe('fresh');
  });

  it('serves a matching cached explanation without a network request', async () => {
    const ctx = file();
    chrome.store[cacheKeys.file('owner', 'repo', 'main', 'src/auth.ts')] = {
      data: fileResult('cached'),
      savedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      fingerprint: fingerprint(ctx.fileContent!),
    };
    const f = controllableFetch();
    navigate(ctx);
    await runExplainFile(ctx);
    expect(f.fn).not.toHaveBeenCalled();
    expect(useStore.getState().fileResult?.purpose).toBe('cached');
  });

  it('Refresh bypasses the cache', async () => {
    chrome.store[cacheKeys.repo('owner', 'repoA')] = { data: repoResult('cached'), savedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const f = controllableFetch();
    navigate(repoA);
    await runExplainRepo(repoA);
    expect(useStore.getState().repoResult?.purpose).toBe('cached');
    const refreshing = runExplainRepo(repoA, { force: true });
    await flush();
    f.calls[0].respond(jsonResponse(repoResult('fresh')));
    await refreshing;
    expect(useStore.getState().repoResult?.purpose).toBe('fresh');
  });
});

describe('overlapping requests', () => {
  it('starting the same target twice reuses the in-flight request', async () => {
    const f = controllableFetch();
    navigate(repoA);
    const p1 = runGoodFirstIssues(repoA);
    const p2 = runGoodFirstIssues(repoA);
    await flush();
    expect(f.calls).toHaveLength(1);
    f.calls[0].respond(jsonResponse({ goodFirstIssues: [{ number: 1, title: 't', labels: [], category: 'help wanted', comments: 0 }] }));
    await Promise.all([p1, p2]);
    expect(useStore.getState().goodFirstIssuesResult).toHaveLength(1);
  });

  it('navigating away and back starts a fresh request and shows only its result', async () => {
    const f = controllableFetch();
    navigate(issue(1));
    const first = runSummarizeIssue(issue(1));
    await flush();
    navigate(issue(2));
    navigate(issue(1));
    const second = runSummarizeIssue(issue(1));
    await flush();
    expect(f.calls[0].signal.aborted).toBe(true);
    f.calls[1].respond(jsonResponse(issueResult('second')));
    await Promise.all([first, second]);
    expect(useStore.getState().issueResult?.whatItAsks).toEqual(['second']);
  });
});

describe('errors and policy', () => {
  it('shows a structured server error message and marks private repositories as not retryable', async () => {
    const f = controllableFetch();
    navigate(repoA);
    const pending = runExplainRepo(repoA);
    await flush();
    f.calls[0].respond(jsonResponse({ error: 'GitGuide supports public repositories only.', code: 'PRIVATE_REPO_UNSUPPORTED' }, 403));
    await pending;
    expect(useStore.getState().repoError).toMatchObject({ code: 'PRIVATE_REPO_UNSUPPORTED', retryable: false });
  });

  it('turns rate limits into a message with the wait time', async () => {
    const f = controllableFetch();
    navigate(repoA);
    const pending = runExplainRepo(repoA);
    await flush();
    f.calls[0].respond(jsonResponse({ error: 'GitHub is rate-limiting GitGuide right now. Please try again later.', code: 'GITHUB_RATE_LIMITED', retryAfterSec: 600 }, 503));
    await pending;
    expect(useStore.getState().repoError?.message).toMatch(/rate-limiting.*about 10 minutes/);
  });

  it('reports an unreachable API distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    navigate(repoA);
    await runExplainRepo(repoA);
    expect(useStore.getState().repoError?.code).toBe('API_UNREACHABLE');
  });

  it('rejects a malformed success response instead of rendering it', async () => {
    const f = controllableFetch();
    navigate(repoA);
    const pending = runExplainRepo(repoA);
    await flush();
    f.calls[0].respond(jsonResponse({ unexpected: true }));
    await pending;
    expect(useStore.getState().repoResult).toBeNull();
    expect(useStore.getState().repoError?.code).toBe('BAD_RESPONSE');
  });

  it('sends nothing for a repository the page marks as private', async () => {
    document.head.innerHTML =
      '<meta name="octolytics-dimension-repository_nwo" content="owner/repoA"><meta name="octolytics-dimension-repository_public" content="false">';
    const f = controllableFetch();
    navigate(repoA);
    await runExplainRepo(repoA);
    expect(f.fn).not.toHaveBeenCalled();
    expect(useStore.getState().repoError?.code).toBe('PRIVATE_REPO_UNSUPPORTED');
  });

  it('sends nothing before the data notice is acknowledged', async () => {
    useStore.setState({ consentAccepted: false });
    const f = controllableFetch();
    navigate(repoA);
    await runExplainRepo(repoA);
    expect(f.fn).not.toHaveBeenCalled();
  });

  it('keeps a successful answer even when saving it to storage fails (quota)', async () => {
    chrome.failSetWith = new Error('QUOTA_BYTES quota exceeded');
    const f = controllableFetch();
    navigate(repoA);
    const pending = runExplainRepo(repoA);
    await flush();
    f.calls[0].respond(jsonResponse(repoResult('kept')));
    await pending;
    expect(useStore.getState().repoResult?.purpose).toBe('kept');
    expect(useStore.getState().repoError).toBeNull();
  });
});
