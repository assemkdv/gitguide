import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStore } from './store';
import { fetchRawFileContent } from '../content/fetch-file';
import { startFileDetection, cancelFileDetection } from './file-detection';
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
