import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./github', () => ({
  getTree: vi.fn(),
  getFileAtCommit: vi.fn(),
}));
vi.mock('./repo-summary', () => ({
  generateRepoSummary: vi.fn(),
}));
vi.mock('./embeddings', () => ({
  embedTexts: vi.fn(),
  embeddingsEnabled: vi.fn(),
}));

import { getTree, getFileAtCommit } from './github';
import type { RepoSnapshot, TreeFile } from './github';
import { generateRepoSummary } from './repo-summary';
import { embedTexts, embeddingsEnabled } from './embeddings';
import {
  createIndexer,
  hasFullCoverage,
  indexKey,
  selectPriorityFiles,
  MAX_BACKGROUND_ATTEMPTS,
  MAX_FILE_BYTES,
  MAX_INDEXED_FILES,
  RepoIndexEntry,
} from './indexer';
import { InMemoryVectorStore } from './vector-store';
import { ApiError } from './errors';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, maxTicks = 200) {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('waitUntil: condition not met in time');
}

const SUMMARY = {
  purpose: 'x', techStack: [], folderStructure: [], architecture: [],
  entrypoints: [], dataFlow: '', authPersistence: '', howToRun: [], beginnerStart: '',
};
const FILE_CONTENT = 'function helper() {\n  return 42;\n}\n';

function snap(commitSha = 'a'.repeat(40), repo = 'repo'): RepoSnapshot {
  return {
    owner: 'owner',
    repo,
    repoInfo: { description: null, defaultBranch: 'main', language: null, topics: [] },
    ref: 'main',
    commitSha,
  };
}

function files(paths: string[], size = 100): TreeFile[] {
  return paths.map((path) => ({ path, size }));
}

function mockTree(paths: TreeFile[], truncated = false) {
  vi.mocked(getTree).mockResolvedValue({ files: paths, truncated });
}

function fileContentOk() {
  vi.mocked(getFileAtCommit).mockImplementation(async () => ({ content: FILE_CONTENT, truncated: false, bytesRead: FILE_CONTENT.length }));
}

beforeEach(() => {
  vi.mocked(embeddingsEnabled).mockReset().mockReturnValue(false);
  vi.mocked(embedTexts).mockReset().mockImplementation(async (texts) => texts.map(() => new Float32Array([1, 0])));
  vi.mocked(getTree).mockReset();
  vi.mocked(getFileAtCommit).mockReset();
  vi.mocked(generateRepoSummary).mockReset().mockResolvedValue({ tree: { files: [], truncated: false }, summary: SUMMARY, coverage: {} as any });
});

describe('selectPriorityFiles', () => {
  it('prioritizes README, docs, manifests, question matches, and routing-ish files', () => {
    const tree = ['README.md', 'docs/setup.md', 'package.json', 'src/routes/issues.ts', 'src/auth/login.ts', 'src/unrelated/formatter.ts'];
    const selected = selectPriorityFiles(tree, 'where is authentication implemented');
    expect(selected).toEqual(expect.arrayContaining(['README.md', 'docs/setup.md', 'package.json', 'src/routes/issues.ts', 'src/auth/login.ts']));
    expect(selected).not.toContain('src/unrelated/formatter.ts');
  });

  it('ranks question matches ahead of generic routing-ish names when the cap is tight', () => {
    const routing = Array.from({ length: 40 }, (_, i) => `src/api/handler${i}.ts`);
    const selected = selectPriorityFiles([...routing, 'src/billing/invoice.ts'], 'how are invoices generated');
    expect(selected).toContain('src/billing/invoice.ts');
  });

  it('caps the result at PRIORITY_FILE_CAP', () => {
    const tree = Array.from({ length: 100 }, (_, i) => `docs/page${i}.md`);
    expect(selectPriorityFiles(tree, 'irrelevant').length).toBeLessThanOrEqual(30);
  });
});

describe('createIndexer — phases and coverage', () => {
  it('answers from the priority subset, then completes in the background with accurate coverage', async () => {
    const paths = ['README.md', ...Array.from({ length: 40 }, (_, i) => `lib/mod${i}.ts`)];
    mockTree(files(paths));
    fileContentOk();
    const store = new InMemoryVectorStore<RepoIndexEntry>();
    const indexer = createIndexer(store, { maxConcurrentJobs: 2, maxBackgroundJobs: 1 });

    const entry = await indexer.ensureIndexed(snap(), 'question');
    expect(entry.chunks.length).toBeGreaterThan(0);
    expect(entry.chunks.length).toBeLessThan(paths.length);
    expect(['partial', 'background-indexing']).toContain(entry.status);

    await waitUntil(() => entry.status === 'complete');
    expect(entry.coverage).toMatchObject({ eligibleFiles: 41, plannedFiles: 41, indexedFiles: 41, failedFiles: 0, treeTruncated: false });
    expect(hasFullCoverage(entry.coverage, entry.status)).toBe(true);
    // Every file was read from the pinned commit, never from a branch name.
    for (const call of vi.mocked(getFileAtCommit).mock.calls) expect(call[2]).toBe('a'.repeat(40));
  });

  it('deduplicates concurrent requests for the same commit into a single build', async () => {
    mockTree(files(['README.md']));
    fileContentOk();
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const [a, b] = await Promise.all([indexer.ensureIndexed(snap(), 'q1'), indexer.ensureIndexed(snap(), 'q2')]);
    expect(a).toBe(b);
    expect(getTree).toHaveBeenCalledTimes(1);
  });

  it('builds a separate index when the branch moves to a new commit', async () => {
    mockTree(files(['README.md']));
    fileContentOk();
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const first = await indexer.ensureIndexed(snap('a'.repeat(40)), 'q');
    const second = await indexer.ensureIndexed(snap('b'.repeat(40)), 'q');
    expect(first).not.toBe(second);
    expect(second.sha).toBe('b'.repeat(40));
  });

  it('marks a repository with nothing indexable as complete with zero chunks', async () => {
    mockTree(files(['logo.png', 'package-lock.json']));
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    expect(entry).toMatchObject({ status: 'complete', chunks: [] });
    expect(getFileAtCommit).not.toHaveBeenCalled();
  });

  it('skips files larger than MAX_FILE_BYTES without downloading them, and reports it', async () => {
    mockTree([{ path: 'README.md', size: 50 }, { path: 'src/huge.ts', size: MAX_FILE_BYTES + 1 }]);
    fileContentOk();
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    expect(vi.mocked(getFileAtCommit).mock.calls.map((c) => c[3])).toEqual(['README.md']);
    expect(entry.coverage.skippedTooLarge).toBe(1);
    expect(hasFullCoverage(entry.coverage, entry.status)).toBe(false);
  });

  it('caps planned files at MAX_INDEXED_FILES and reports the rest as skipped, not covered', async () => {
    mockTree(files(Array.from({ length: MAX_INDEXED_FILES + 50 }, (_, i) => `lib/f${i}.ts`)));
    fileContentOk();
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    await waitUntil(() => entry.status === 'complete');
    expect(entry.coverage).toMatchObject({ plannedFiles: MAX_INDEXED_FILES, skippedByFileLimit: 50, indexedFiles: MAX_INDEXED_FILES });
    expect(hasFullCoverage(entry.coverage, entry.status)).toBe(false);
  });

  it('never claims full coverage when GitHub truncated the tree', async () => {
    mockTree(files(['README.md']), true);
    fileContentOk();
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    expect(entry.status).toBe('complete');
    expect(hasFullCoverage(entry.coverage, entry.status)).toBe(false);
  });

  it('skips and counts an individual missing/binary file, but fails Phase A on a systemic GitHub error', async () => {
    mockTree(files(['README.md', 'src/a.ts']));
    vi.mocked(getFileAtCommit).mockImplementation(async (_o, _r, _s, path) => {
      if (path === 'src/a.ts') throw new ApiError('FILE_NOT_TEXT', 422, 'binary');
      return { content: FILE_CONTENT, truncated: false, bytesRead: 10 };
    });
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    await waitUntil(() => entry.status === 'complete');
    expect(entry.coverage).toMatchObject({ indexedFiles: 1, failedFiles: 1 });
    expect(hasFullCoverage(entry.coverage, entry.status)).toBe(false);

    vi.mocked(getFileAtCommit).mockRejectedValue(new ApiError('GITHUB_RATE_LIMITED', 503, 'limited', 60));
    await expect(indexer.ensureIndexed(snap('c'.repeat(40)), 'q')).rejects.toMatchObject({ code: 'GITHUB_RATE_LIMITED' });
  });

  it('still answers when the optional summary generation fails', async () => {
    mockTree(files(['README.md']));
    fileContentOk();
    vi.mocked(generateRepoSummary).mockRejectedValue(new ApiError('AI_MALFORMED', 502, 'bad json'));
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    expect(entry.summary).toBeNull();
    expect(entry.chunks.length).toBe(1);
  });
});

describe('createIndexer — shared Phase A and cancellation', () => {
  it("keeps building for other subscribers when the first requester disconnects", async () => {
    mockTree(files(['README.md']));
    const gate = deferred<void>();
    vi.mocked(getFileAtCommit).mockImplementation(async () => {
      await gate.promise;
      return { content: FILE_CONTENT, truncated: false, bytesRead: 10 };
    });
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });

    const first = new AbortController();
    const p1 = indexer.ensureIndexed(snap(), 'q', first.signal);
    const p2 = indexer.ensureIndexed(snap(), 'q', new AbortController().signal);
    await waitUntil(() => vi.mocked(getFileAtCommit).mock.calls.length > 0);
    first.abort(new DOMException('gone', 'AbortError'));
    await expect(p1).rejects.toThrow();

    gate.resolve();
    const entry = await p2;
    expect(entry.chunks.length).toBe(1);
  });

  it('cancels the shared build once every subscriber has gone', async () => {
    mockTree(files(['README.md']));
    let seenSignal: AbortSignal | undefined;
    vi.mocked(getFileAtCommit).mockImplementation(async (_o, _r, _s, _p, options) => {
      seenSignal = options?.signal;
      return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason)));
    });
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const a = new AbortController();
    const b = new AbortController();
    const p1 = indexer.ensureIndexed(snap(), 'q', a.signal);
    const p2 = indexer.ensureIndexed(snap(), 'q', b.signal);
    await waitUntil(() => seenSignal !== undefined);
    a.abort();
    expect(seenSignal?.aborted).toBe(false);
    b.abort();
    expect(seenSignal?.aborted).toBe(true);
    await expect(p1).rejects.toBeDefined();
    await expect(p2).rejects.toBeDefined();
    expect(indexer.stats().phaseAInFlight).toBe(0);
  });

  it('bounds concurrent index builds; extra builds wait for a slot', async () => {
    const gate = deferred<void>();
    vi.mocked(getTree).mockImplementation(async () => {
      await gate.promise;
      return { files: files(['README.md']), truncated: false };
    });
    fileContentOk();
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 1 });
    const p1 = indexer.ensureIndexed(snap('a'.repeat(40), 'one'), 'q');
    const p2 = indexer.ensureIndexed(snap('b'.repeat(40), 'two'), 'q');
    await waitUntil(() => vi.mocked(getTree).mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(getTree).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([p1, p2]);
    expect(getTree).toHaveBeenCalledTimes(2);
  });
});

describe('createIndexer — background lifecycle', () => {
  const many = () => files(['README.md', ...Array.from({ length: 60 }, (_, i) => `lib/m${i}.ts`)]);

  it('never leaves an entry stuck in background-indexing after a failure, and records why', async () => {
    mockTree(many());
    let calls = 0;
    vi.mocked(getFileAtCommit).mockImplementation(async () => {
      calls++;
      if (calls > 30) throw new ApiError('GITHUB_RATE_LIMITED', 503, 'limited', 60);
      return { content: FILE_CONTENT, truncated: false, bytesRead: 10 };
    });
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    await waitUntil(() => entry.status === 'failed');
    expect(entry.lastErrorCode).toBe('GITHUB_RATE_LIMITED');
    expect(entry.remainingFiles.length).toBeGreaterThan(0);
    expect(entry.nextRetryAt).toBeGreaterThan(Date.now() + 50_000);
    expect(indexer.stats().backgroundRunning).toBe(0);
  });

  it('resumes a failed background job on a later question once the cooldown has passed', async () => {
    mockTree(many());
    let failing = true;
    vi.mocked(getFileAtCommit).mockImplementation(async (_o, _r, _s, path) => {
      if (failing && path.startsWith('lib/m5')) throw new ApiError('GITHUB_UNAVAILABLE', 502, 'down');
      return { content: FILE_CONTENT, truncated: false, bytesRead: 10 };
    });
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    await waitUntil(() => entry.status === 'failed');

    // Within the cooldown: a new question does not hammer GitHub again.
    await indexer.ensureIndexed(snap(), 'q');
    expect(entry.status).toBe('failed');

    failing = false;
    entry.nextRetryAt = 0;
    const again = await indexer.ensureIndexed(snap(), 'q');
    expect(again).toBe(entry);
    await waitUntil(() => entry.status === 'complete');
    expect(entry.remainingFiles).toEqual([]);
  });

  it(`gives up after ${MAX_BACKGROUND_ATTEMPTS} background attempts`, async () => {
    mockTree(many());
    vi.mocked(getFileAtCommit).mockImplementation(async (_o, _r, _s, path) => {
      if (path.startsWith('lib/m5')) throw new ApiError('GITHUB_UNAVAILABLE', 502, 'down');
      return { content: FILE_CONTENT, truncated: false, bytesRead: 10 };
    });
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    for (let attempt = 1; attempt <= MAX_BACKGROUND_ATTEMPTS + 1; attempt++) {
      await waitUntil(() => entry.status === 'failed');
      entry.nextRetryAt = 0;
      await indexer.ensureIndexed(snap(), 'q');
    }
    expect(entry.backgroundAttempts).toBe(MAX_BACKGROUND_ATTEMPTS);
    expect(entry.status).toBe('failed');
  });

  it('cancels an evicted entry’s background job so it cannot repopulate the cache', async () => {
    mockTree(many());
    const gate = deferred<void>();
    let backgroundSignal: AbortSignal | undefined;
    vi.mocked(getFileAtCommit).mockImplementation(async (_o, repo, _s, path, options) => {
      if (repo === 'one' && path.startsWith('lib/m4')) {
        backgroundSignal = options?.signal;
        await gate.promise;
      }
      return { content: FILE_CONTENT, truncated: false, bytesRead: 10 };
    });
    const store = new InMemoryVectorStore<RepoIndexEntry>(1);
    const indexer = createIndexer(store, { maxConcurrentJobs: 2, maxBackgroundJobs: 2 });

    const one = await indexer.ensureIndexed(snap('a'.repeat(40), 'one'), 'q');
    await waitUntil(() => backgroundSignal !== undefined);
    await indexer.ensureIndexed(snap('b'.repeat(40), 'two'), 'q');

    expect(backgroundSignal?.aborted).toBe(true);
    gate.resolve();
    await waitUntil(() => one.status !== 'background-indexing');
    expect(store.peek(indexKey(snap('a'.repeat(40), 'one')))).toBeUndefined();
    expect(store.peek(indexKey(snap('b'.repeat(40), 'two')))).toBeDefined();
  });

  it('shutdown aborts work and rejects new requests', async () => {
    mockTree(files(['README.md']));
    fileContentOk();
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    indexer.shutdown();
    await expect(indexer.ensureIndexed(snap(), 'q')).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
  });
});

describe('createIndexer — embeddings', () => {
  it('never calls embedTexts when embeddings are disabled (production default)', async () => {
    mockTree(files(['README.md', 'src/a.ts']));
    fileContentOk();
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    await waitUntil(() => entry.status === 'complete');
    expect(embedTexts).not.toHaveBeenCalled();
    expect(entry.chunks.every((c) => c.embedding === null)).toBe(true);
    expect(entry.bm25.score('helper').length).toBeGreaterThan(0);
  });

  it('embeds chunks when embeddings are enabled', async () => {
    vi.mocked(embeddingsEnabled).mockReturnValue(true);
    mockTree(files(['README.md']));
    fileContentOk();
    const indexer = createIndexer(new InMemoryVectorStore(), { maxConcurrentJobs: 2 });
    const entry = await indexer.ensureIndexed(snap(), 'q');
    expect(embedTexts).toHaveBeenCalled();
    expect(entry.chunks[0].embedding).toBeInstanceOf(Float32Array);
  });
});
