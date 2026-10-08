import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStore } from './store';
import { fetchRawFileContent } from '../content/fetch-file';
import { startFileDetection, cancelFileDetection, isSameFileRoute } from './file-detection';
import type { FileRouteInfo } from '../content/page-parser';

vi.mock('../content/fetch-file', () => ({
  fetchRawFileContent: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function routeFor(filePath: string): FileRouteInfo {
  return { repoOwner: 'owner', repoName: 'repo', ref: 'main', filePath };
}

describe('file-detection stale-navigation cancellation', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState());
    vi.mocked(fetchRawFileContent).mockReset();
  });

  it('ignores a raw fetch that resolves after the user has already navigated to a different file', async () => {
    const fileA = deferred<string | null>();
    const fileB = deferred<string | null>();
    vi.mocked(fetchRawFileContent)
      .mockImplementationOnce(() => fileA.promise)
      .mockImplementationOnce(() => fileB.promise);

    // Start detection for file A.
    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repo', page: 'file', filePath: 'a.ts', fileContent: '' } });
    startFileDetection(routeFor('a.ts'), performance.now());

    // Before A's fetch resolves, the user navigates to file B.
    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repo', page: 'file', filePath: 'b.ts', fileContent: '' } });
    startFileDetection(routeFor('b.ts'), performance.now());

    // A's stale fetch finally resolves — it must not overwrite B's context.
    fileA.resolve('x'.repeat(40));
    await Promise.resolve();
    await Promise.resolve();

    expect(useStore.getState().pageContext?.filePath).toBe('b.ts');
    expect(useStore.getState().pageContext?.fileContent).toBe('');

    // B's fetch resolves normally and should be applied.
    fileB.resolve('y'.repeat(40));
    await Promise.resolve();
    await Promise.resolve();

    expect(useStore.getState().pageContext?.filePath).toBe('b.ts');
    expect(useStore.getState().pageContext?.fileContent).toBe('y'.repeat(40));
  });

  it('cancelFileDetection prevents a subsequently-resolving fetch from applying at all', async () => {
    const file = deferred<string | null>();
    vi.mocked(fetchRawFileContent).mockImplementationOnce(() => file.promise);

    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repo', page: 'file', filePath: 'a.ts', fileContent: '' } });
    startFileDetection(routeFor('a.ts'), performance.now());

    cancelFileDetection();
    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repo', page: 'repo' } });

    file.resolve('x'.repeat(40));
    await Promise.resolve();
    await Promise.resolve();

    // Still a repo page — the cancelled file detection must not have turned it back into a file page.
    expect(useStore.getState().pageContext?.page).toBe('repo');
  });
});

describe('isSameFileRoute', () => {
  it('is true for the identical repo/path/ref', () => {
    const prev = { repoOwner: 'owner', repoName: 'repo', page: 'file' as const, filePath: 'src/auth.ts', fileRef: 'main' };
    expect(isSameFileRoute(prev, routeFor('src/auth.ts'))).toBe(true);
  });

  it('is false when the ref (branch) differs, even with the same repo and path', () => {
    // Regression: navigating from main/src/auth.ts to feature/new-auth/src/auth.ts
    // must not be treated as a no-op, or the previous branch's content/explanation
    // would keep showing under the new branch.
    const prev = { repoOwner: 'owner', repoName: 'repo', page: 'file' as const, filePath: 'src/auth.ts', fileRef: 'main' };
    const nextRoute: FileRouteInfo = { repoOwner: 'owner', repoName: 'repo', ref: 'feature/new-auth', filePath: 'src/auth.ts' };
    expect(isSameFileRoute(prev, nextRoute)).toBe(false);
  });

  it('is false when the file path differs', () => {
    const prev = { repoOwner: 'owner', repoName: 'repo', page: 'file' as const, filePath: 'src/auth.ts', fileRef: 'main' };
    expect(isSameFileRoute(prev, routeFor('src/other.ts'))).toBe(false);
  });

  it('is false when the repository differs', () => {
    const prev = { repoOwner: 'owner', repoName: 'repo', page: 'file' as const, filePath: 'src/auth.ts', fileRef: 'main' };
    const nextRoute: FileRouteInfo = { repoOwner: 'other-owner', repoName: 'repo', ref: 'main', filePath: 'src/auth.ts' };
    expect(isSameFileRoute(prev, nextRoute)).toBe(false);
  });

  it('is false when there was no previous file page', () => {
    expect(isSameFileRoute(null, routeFor('src/auth.ts'))).toBe(false);
    const prevRepo = { repoOwner: 'owner', repoName: 'repo', page: 'repo' as const };
    expect(isSameFileRoute(prevRepo, routeFor('src/auth.ts'))).toBe(false);
  });
});

describe('file-detection never attributes the previous page’s DOM to the new file', () => {
  const A = 'export function login() {\n  return checkPassword();\n}\n';
  const B = 'export function other() {\n  return 42; // file b\n}\n';
  // Repaints inside the existing content container, as GitHub's SPA does.
  const paint = (content: string) => {
    const main = document.querySelector('main') ?? document.body.appendChild(document.createElement('main'));
    main.innerHTML = `<div data-testid="ai-code-viewer"><pre>${content}</pre></div>`;
  };
  const flushObserver = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    document.body.innerHTML = '<main></main>';
    useStore.setState(useStore.getInitialState());
    vi.mocked(fetchRawFileContent).mockReset();
    vi.mocked(fetchRawFileContent).mockResolvedValue(null);
    cancelFileDetection();
  });

  it('uses already-rendered content on a fresh page load', () => {
    paint(A);
    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repo', page: 'file', filePath: 'a.ts', fileContent: '' } });
    startFileDetection(routeFor('a.ts'), performance.now(), { inPlaceNavigation: false });

    expect(useStore.getState().pageContext?.fileContent).toBe(A);
  });

  it('after an in-place navigation, ignores the old file still on screen and waits for the repaint', async () => {
    paint(A);
    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repo', page: 'file', filePath: 'b.ts', fileContent: '' } });
    startFileDetection(routeFor('b.ts'), performance.now(), { inPlaceNavigation: true, previousContent: A });

    expect(useStore.getState().pageContext?.fileContent).toBe('');
    document.body.appendChild(document.createElement('span')); // unrelated mutation mid-transition
    await flushObserver();
    expect(useStore.getState().pageContext?.fileContent).toBe('');

    paint(B);
    await flushObserver();
    expect(useStore.getState().pageContext?.fileContent).toBe(B);
  });

  it('rejects the previous file’s content even when it is painted after navigation started', async () => {
    // The previous page is still loading: nothing painted yet.
    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repo', page: 'file', filePath: 'b.ts', fileContent: '' } });
    startFileDetection(routeFor('b.ts'), performance.now(), { inPlaceNavigation: true, previousContent: A });

    paint(A); // the previous navigation's late repaint
    await flushObserver();
    expect(useStore.getState().pageContext?.fileContent).toBe('');

    paint(B);
    await flushObserver();
    expect(useStore.getState().pageContext?.fileContent).toBe(B);
  });

  it('a raw fetch for the new file still wins while the old DOM is on screen', async () => {
    paint(A);
    vi.mocked(fetchRawFileContent).mockResolvedValueOnce(B);
    useStore.setState({ pageContext: { repoOwner: 'owner', repoName: 'repo', page: 'file', filePath: 'b.ts', fileContent: '' } });
    startFileDetection(routeFor('b.ts'), performance.now(), { inPlaceNavigation: true, previousContent: A });

    await flushObserver();
    expect(useStore.getState().pageContext?.fileContent).toBe(B);
  });
});
