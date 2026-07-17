import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBranchHeadSha, getRepoTree } from './github';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe('getBranchHeadSha', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the sha at the tip of the branch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ object: { sha: 'abc123' } })));
    const sha = await getBranchHeadSha('owner', 'repo', 'main');
    expect(sha).toBe('abc123');
  });

  it('requests the unencoded branch path so slash-containing branch names work', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ object: { sha: 'def456' } }));
    vi.stubGlobal('fetch', fetchMock);
    await getBranchHeadSha('owner', 'repo', 'feature/new-auth');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/git/refs/heads/feature/new-auth',
      expect.anything(),
    );
  });

  it('throws when the GitHub API responds with a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false, 404)));
    await expect(getBranchHeadSha('owner', 'repo', 'main')).rejects.toThrow('GitHub ref lookup failed: 404');
  });

  it('throws when the response has no sha', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ object: {} })));
    await expect(getBranchHeadSha('owner', 'repo', 'main')).rejects.toThrow('GitHub ref lookup returned no sha');
  });
});

describe('getRepoTree (regression: filtering unchanged after ignore-list extraction)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps only blob entries outside ignored directory segments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          tree: [
            { type: 'blob', path: 'src/index.ts' },
            { type: 'tree', path: 'src' },
            { type: 'blob', path: 'node_modules/pkg/index.js' },
            { type: 'blob', path: 'dist/bundle.js' },
            { type: 'blob', path: 'README.md' },
          ],
        }),
      ),
    );
    const paths = await getRepoTree('owner', 'repo', 'main');
    expect(paths).toEqual(['src/index.ts', 'README.md']);
  });

  it('caps the result at 500 paths', async () => {
    const tree = Array.from({ length: 600 }, (_, i) => ({ type: 'blob', path: `src/file${i}.ts` }));
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ tree })));
    const paths = await getRepoTree('owner', 'repo', 'main');
    expect(paths).toHaveLength(500);
  });

  it('returns an empty array on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false, 404)));
    const paths = await getRepoTree('owner', 'repo', 'main');
    expect(paths).toEqual([]);
  });
});
