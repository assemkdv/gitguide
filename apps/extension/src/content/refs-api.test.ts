import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAllRefNames, getRefNames } from './refs-api';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe('fetchAllRefNames', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges branch and tag names into a single deduped list', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/branches')) return Promise.resolve(jsonResponse([{ name: 'main' }, { name: 'feature/auth' }]));
      if (url.includes('/tags')) return Promise.resolve(jsonResponse([{ name: 'v1.0.0' }, { name: 'main' }]));
      return Promise.resolve(jsonResponse([]));
    });

    const names = await fetchAllRefNames('owner', 'repo');
    expect(new Set(names)).toEqual(new Set(['main', 'feature/auth', 'v1.0.0']));
  });

  it('stops paginating once a page comes back with fewer than 100 results', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('page=1')) return Promise.resolve(jsonResponse(Array.from({ length: 50 }, (_, i) => ({ name: `ref-${i}` }))));
      return Promise.resolve(jsonResponse([]));
    });

    await fetchAllRefNames('owner', 'repo');
    const page2Calls = fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('page=2'));
    expect(page2Calls).toHaveLength(0);
  });

  it('returns an empty array on a network failure instead of throwing', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(fetchAllRefNames('owner', 'repo')).resolves.toEqual([]);
  });

  it('returns an empty array when GitHub responds with a non-OK status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, false));
    await expect(fetchAllRefNames('owner', 'repo')).resolves.toEqual([]);
  });
});

describe('getRefNames', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ name: 'main' }]));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('caches results per owner/repo so a second call does not refetch', async () => {
    await getRefNames('owner', 'cache-test-repo');
    await getRefNames('owner', 'cache-test-repo');
    // 2 calls for the first request (branches + tags page 1), none for the second.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
