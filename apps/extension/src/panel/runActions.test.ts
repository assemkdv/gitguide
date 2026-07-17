import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStore } from './store';
import type { PageContext } from './store';
import { runExplainRepo, runExplainFile, runSummarizeIssue, runGoodFirstIssues } from './runActions';

vi.mock('./storage', () => ({
  loadRepoCache: vi.fn(async () => null),
  saveRepoCache: vi.fn(async () => {}),
  loadFileCache: vi.fn(async () => null),
  saveFileCache: vi.fn(async () => {}),
  loadIssueCache: vi.fn(async () => null),
  saveIssueCache: vi.fn(async () => {}),
  loadGoodFirstIssuesCache: vi.fn(async () => null),
  saveGoodFirstIssuesCache: vi.fn(async () => {}),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

describe('stale AI response guards (navigating away before the request resolves)', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState());
    vi.unstubAllGlobals();
  });

  it('runExplainRepo discards a result that resolves after navigating to a different repo', async () => {
    const repoA: PageContext = { repoOwner: 'owner', repoName: 'repoA', page: 'repo' };
    useStore.setState({ pageContext: repoA });

    const req = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => req.promise));

    const pending = runExplainRepo(repoA);
    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repoB', page: 'repo' } });
    req.resolve(jsonResponse({ purpose: 'stale result for repo A' }));
    await pending;

    expect(useStore.getState().repoResult).toBeNull();
  });

  it('runExplainFile discards a result that resolves after navigating to a different file/ref', async () => {
    const fileA: PageContext = {
      repoOwner: 'owner',
      repoName: 'repo',
      page: 'file',
      filePath: 'src/auth.ts',
      fileRef: 'main',
      fileContent: 'x'.repeat(40),
    };
    useStore.setState({ pageContext: fileA });

    const req = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => (url.endsWith('/quick') ? Promise.resolve(jsonResponse({ purpose: 'q', summary: 'q' })) : req.promise)),
    );

    const pending = runExplainFile(fileA);
    useStore.setState({
      pageContext: { repoOwner: 'owner', repoName: 'repo', page: 'file', filePath: 'src/other.ts', fileRef: 'main', fileContent: 'y'.repeat(40) },
    });
    req.resolve(jsonResponse({ purpose: 'stale result for auth.ts' }));
    await pending;

    expect(useStore.getState().fileResult).toBeNull();
  });

  it('runSummarizeIssue discards a result that resolves after navigating to a different issue', async () => {
    const issue5: PageContext = { repoOwner: 'owner', repoName: 'repo', page: 'issue', issueNumber: 5, issueTitle: 'Bug five' };
    useStore.setState({ pageContext: issue5 });

    const req = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => req.promise));

    const pending = runSummarizeIssue(issue5);
    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repo', page: 'issue', issueNumber: 6, issueTitle: 'Bug six' } });
    req.resolve(jsonResponse({ whatItAsks: ['stale'] }));
    await pending;

    expect(useStore.getState().issueResult).toBeNull();
  });

  it('runGoodFirstIssues discards a result that resolves after navigating to a different repo', async () => {
    const repoA: PageContext = { repoOwner: 'owner', repoName: 'repoA', page: 'repo' };
    useStore.setState({ pageContext: repoA });

    const req = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => req.promise));

    const pending = runGoodFirstIssues(repoA);
    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repoB', page: 'repo' } });
    req.resolve(jsonResponse({ goodFirstIssues: [{ number: 1 }] }));
    await pending;

    expect(useStore.getState().goodFirstIssuesResult).toBeNull();
  });
});
