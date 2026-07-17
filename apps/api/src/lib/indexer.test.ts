import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./github', () => ({
  getBranchHeadSha: vi.fn(),
  getFileContent: vi.fn(),
}));
vi.mock('./repo-summary', () => ({
  generateRepoSummary: vi.fn(),
}));
vi.mock('./embeddings', () => ({
  embedTexts: vi.fn(),
}));

import { getBranchHeadSha, getFileContent } from './github';
import { generateRepoSummary } from './repo-summary';
import { embedTexts } from './embeddings';
import { createIndexer, selectPriorityFiles } from './indexer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, maxTicks = 100) {
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

function mockEmbeddings() {
  vi.mocked(embedTexts).mockImplementation(async (texts) => texts.map(() => new Float32Array([1, 0])));
}

describe('selectPriorityFiles', () => {
  it('prioritizes README, docs, manifests, routing-ish files, and question keyword matches', () => {
    const tree = [
      'README.md',
      'docs/setup.md',
      'package.json',
      'src/routes/issues.ts',
      'src/auth/login.ts',
      'src/unrelated/formatter.ts',
    ];
    const selected = selectPriorityFiles(tree, 'where is authentication implemented');
    expect(selected).toContain('README.md');
    expect(selected).toContain('docs/setup.md');
    expect(selected).toContain('package.json');
    expect(selected).toContain('src/routes/issues.ts'); // matches "route"
    expect(selected).toContain('src/auth/login.ts'); // matches question keyword "authentication" -> "auth"... contains check
  });

  it('caps the result at PRIORITY_FILE_CAP', () => {
    const tree = Array.from({ length: 100 }, (_, i) => `docs/page${i}.md`);
    const selected = selectPriorityFiles(tree, 'irrelevant');
    expect(selected.length).toBeLessThanOrEqual(30);
  });
});

describe('createIndexer — lazy/progressive indexing', () => {
  beforeEach(() => {
    vi.mocked(getBranchHeadSha).mockReset();
    vi.mocked(getFileContent).mockReset();
    vi.mocked(generateRepoSummary).mockReset();
    vi.mocked(embedTexts).mockReset();
    mockEmbeddings();
  });

  it('answers from the priority subset before background indexing finishes', async () => {
    vi.mocked(getBranchHeadSha).mockResolvedValue('sha1');
    vi.mocked(generateRepoSummary).mockResolvedValue({
      repoInfo: { description: '', defaultBranch: 'main', language: null, topics: [] },
      ref: 'main',
      tree: ['README.md', 'src/foo.ts', 'src/bar.ts', 'src/baz.ts', 'src/qux.ts'],
      summary: SUMMARY,
    });

    const gate = deferred<void>();
    vi.mocked(getFileContent).mockImplementation(async (_o, _r, _ref, path) => {
      if (path !== 'README.md') await gate.promise; // holds Phase B's fetches back
      return FILE_CONTENT;
    });

    const indexer = createIndexer();
    const entry = await indexer.ensureIndexed('owner', 'repo', 'main', 'no keyword overlap', undefined);

    expect(entry.chunks.map((c) => c.filePath)).toEqual(['README.md']);
    expect(entry.status).not.toBe('complete');

    gate.resolve();
    await waitUntil(() => entry.status === 'complete');

    expect(entry.chunks.map((c) => c.filePath).sort()).toEqual(
      ['README.md', 'src/bar.ts', 'src/baz.ts', 'src/foo.ts', 'src/qux.ts'].sort(),
    );
  });

  it('deduplicates concurrent requests for the same repo+sha into a single build', async () => {
    vi.mocked(getBranchHeadSha).mockResolvedValue('sha1');
    vi.mocked(generateRepoSummary).mockResolvedValue({
      repoInfo: { description: '', defaultBranch: 'main', language: null, topics: [] },
      ref: 'main',
      tree: ['README.md'],
      summary: SUMMARY,
    });
    vi.mocked(getFileContent).mockResolvedValue(FILE_CONTENT);

    const indexer = createIndexer();
    const [entryA, entryB] = await Promise.all([
      indexer.ensureIndexed('owner', 'repo', 'main', 'q1', undefined),
      indexer.ensureIndexed('owner', 'repo', 'main', 'q2', undefined),
    ]);

    expect(entryA).toBe(entryB); // same object — one build, not two
    expect(generateRepoSummary).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the branch head sha changes (stale cache invalidation)', async () => {
    vi.mocked(getBranchHeadSha).mockResolvedValueOnce('sha1').mockResolvedValueOnce('sha2');
    vi.mocked(generateRepoSummary).mockResolvedValue({
      repoInfo: { description: '', defaultBranch: 'main', language: null, topics: [] },
      ref: 'main',
      tree: ['README.md'],
      summary: SUMMARY,
    });
    vi.mocked(getFileContent).mockResolvedValue(FILE_CONTENT);

    const indexer = createIndexer();
    const entry1 = await indexer.ensureIndexed('owner', 'repo', 'main', 'q', undefined);
    const entry2 = await indexer.ensureIndexed('owner', 'repo', 'main', 'q', undefined);

    expect(entry1.sha).toBe('sha1');
    expect(entry2.sha).toBe('sha2');
    expect(generateRepoSummary).toHaveBeenCalledTimes(2);
  });

  it('marks a repo with nothing indexable as complete with zero chunks, not stuck partial', async () => {
    vi.mocked(getBranchHeadSha).mockResolvedValue('sha1');
    vi.mocked(generateRepoSummary).mockResolvedValue({
      repoInfo: { description: '', defaultBranch: 'main', language: null, topics: [] },
      ref: 'main',
      tree: [],
      summary: SUMMARY,
    });

    const indexer = createIndexer();
    const entry = await indexer.ensureIndexed('owner', 'repo', 'main', 'q', undefined);

    expect(entry.chunks).toEqual([]);
    expect(entry.status).toBe('complete');
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('still indexes surviving files when one file fetch fails/returns empty', async () => {
    vi.mocked(getBranchHeadSha).mockResolvedValue('sha1');
    vi.mocked(generateRepoSummary).mockResolvedValue({
      repoInfo: { description: '', defaultBranch: 'main', language: null, topics: [] },
      ref: 'main',
      tree: ['README.md', 'docs/guide.md'],
      summary: SUMMARY,
    });
    vi.mocked(getFileContent).mockImplementation(async (_o, _r, _ref, path) => (path === 'README.md' ? '' : FILE_CONTENT));

    const indexer = createIndexer();
    const entry = await indexer.ensureIndexed('owner', 'repo', 'main', 'q', undefined);

    expect(entry.chunks.map((c) => c.filePath)).toEqual(['docs/guide.md']);
  });
});
