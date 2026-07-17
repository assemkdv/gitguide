import { describe, it, expect, beforeEach, vi } from 'vitest';

// Minimal in-memory mock of the chrome.storage.local surface storage.ts relies on.
function installChromeStorageMock() {
  const store = new Map<string, unknown>();

  const local = {
    get: vi.fn(async (query: string | string[] | null) => {
      if (query === null) {
        return Object.fromEntries(store.entries());
      }
      const keys = Array.isArray(query) ? query : [query];
      const result: Record<string, unknown> = {};
      for (const k of keys) {
        if (store.has(k)) result[k] = store.get(k);
      }
      return result;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    }),
  };

  (globalThis as any).chrome = { storage: { local } };
  return store;
}

describe('storage cache scoping and lifecycle', () => {
  let store: Map<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    store = installChromeStorageMock();
  });

  it('scopes file cache entries by repo + ref + path, not just repo + path', async () => {
    const { loadFileCache, saveFileCache } = await import('./storage');
    const result = { purpose: 'p', summary: 's', mainComponents: [], inputsOutputs: '', dependencies: [], usedBy: '', connections: '', importantLogic: '', edgeCases: '', contributorNotes: '', relatedFiles: [] };

    await saveFileCache('owner/repo', 'main', 'src/index.ts', result);

    expect(await loadFileCache('owner/repo', 'main', 'src/index.ts')).toEqual(result);
    // A different ref (e.g. a feature branch) for the exact same path must not hit the
    // same cache entry — the file content can legitimately differ between branches.
    expect(await loadFileCache('owner/repo', 'feature-branch', 'src/index.ts')).toBeNull();
  });

  it('scopes issue cache entries by issue number', async () => {
    const { loadIssueCache, saveIssueCache } = await import('./storage');
    const result = { whatItAsks: [], whyItMatters: '', currentBehavior: '', expectedBehavior: '', discussionContext: '', relevantFiles: [], implementationSteps: [], risks: '', testingConsiderations: '', difficulty: 'beginner' as const, timeEstimate: '' };

    await saveIssueCache('owner/repo', 42, result);

    expect(await loadIssueCache('owner/repo', 42)).toEqual(result);
    expect(await loadIssueCache('owner/repo', 43)).toBeNull();
  });

  it('treats an expired entry as a cache miss', async () => {
    const { loadRepoCache } = await import('./storage');
    store.set('cache:repo:owner/repo', { data: { purpose: 'stale' }, savedAt: Date.now() - 1_000_000, expiresAt: Date.now() - 1 });

    expect(await loadRepoCache('owner/repo')).toBeNull();
  });

  it('does not crash and treats malformed cache entries as a miss', async () => {
    const { loadRepoCache } = await import('./storage');
    store.set('cache:repo:owner/repo', 'not-an-object');

    await expect(loadRepoCache('owner/repo')).resolves.toBeNull();
  });

  it('prunes only expired cache: entries, leaving chat history and fresh entries untouched', async () => {
    const { pruneExpiredCache } = await import('./storage');
    const now = Date.now();

    store.set('cache:repo:owner/repo', { data: {}, savedAt: now - 100, expiresAt: now - 1 }); // expired
    store.set('cache:file:owner/repo:main:a.ts', { data: {}, savedAt: now, expiresAt: now + 100_000 }); // fresh
    store.set('chat:owner/repo', [{ role: 'user', content: 'hi' }]); // never pruned — no TTL
    store.set('askrepo:owner/repo', [{ role: 'user', content: 'where is auth' }]); // never pruned — no TTL

    await pruneExpiredCache();

    expect(store.has('cache:repo:owner/repo')).toBe(false);
    expect(store.has('cache:file:owner/repo:main:a.ts')).toBe(true);
    expect(store.has('chat:owner/repo')).toBe(true);
    expect(store.has('askrepo:owner/repo')).toBe(true);
  });

  it('round-trips ask-repo messages under their own key, separate from chat history', async () => {
    const { loadRepoAskMessages, saveRepoAskMessages, clearRepoAskMessages, loadRepoChatMessages } = await import('./storage');
    const messages = [
      { role: 'user' as const, content: 'where is auth?' },
      {
        role: 'assistant' as const,
        content: 'It is in src/auth.ts [1].',
        citations: [{ path: 'src/auth.ts', startLine: 1, endLine: 10, url: 'https://github.com/owner/repo/blob/main/src/auth.ts#L1-L10' }],
        indexingStatus: 'complete' as const,
      },
    ];

    await saveRepoAskMessages('owner/repo', messages);

    expect(await loadRepoAskMessages('owner/repo')).toEqual(messages);
    expect(await loadRepoChatMessages('owner/repo')).toEqual([]); // distinct key namespace

    await clearRepoAskMessages('owner/repo');
    expect(await loadRepoAskMessages('owner/repo')).toEqual([]);
  });

  it('returns [] for ask-repo messages when the stored value is not an array', async () => {
    const { loadRepoAskMessages } = await import('./storage');
    store.set('askrepo:owner/repo', 'not-an-array');

    expect(await loadRepoAskMessages('owner/repo')).toEqual([]);
  });
});
