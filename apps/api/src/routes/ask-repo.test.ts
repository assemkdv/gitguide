import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../lib/github', () => ({ getRepoInfo: vi.fn() }));
vi.mock('../lib/indexer', () => ({ ensureIndexed: vi.fn() }));
vi.mock('../lib/groq-client', () => ({ getGroqClient: vi.fn() }));
vi.mock('../lib/embeddings', () => ({ embedText: vi.fn(), embeddingsEnabled: vi.fn() }));

import { getRepoInfo } from '../lib/github';
import { ensureIndexed } from '../lib/indexer';
import { getGroqClient } from '../lib/groq-client';
import { embedText, embeddingsEnabled } from '../lib/embeddings';
import { BM25Index } from '../lib/bm25';
import { app } from '../server';
import type { ChunkRecord } from '../lib/vector-store';
import type { RepoIndexEntry } from '../lib/indexer';

function makeChunk(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    id: 'src/auth.ts:1-10',
    repoOwner: 'owner',
    repoName: 'repo',
    sha: 'sha1',
    filePath: 'src/auth.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    text: 'function login() { /* auth logic */ }',
    embedding: new Float32Array([1, 0]),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RepoIndexEntry> = {}): RepoIndexEntry {
  const chunks = overrides.chunks ?? [makeChunk()];
  return {
    sha: 'sha1',
    chunks,
    bm25: new BM25Index(chunks.map((c) => ({ id: c.id, text: c.text }))),
    summary: null,
    status: 'complete',
    remainingFiles: [],
    ...overrides,
  };
}

async function* fakeStream(pieces: string[]) {
  for (const content of pieces) yield { choices: [{ delta: { content } }] };
}

function mockGroq(pieces: string[] = ['Hello', ' world']) {
  vi.mocked(getGroqClient).mockReturnValue({
    chat: { completions: { create: vi.fn().mockResolvedValue(fakeStream(pieces)) } },
  } as any);
  vi.mocked(embedText).mockResolvedValue(new Float32Array([1, 0]));
}

function parseSseEvents(text: string): any[] {
  return text
    .split('\n\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

describe('POST /v1/ask-repo', () => {
  beforeEach(() => {
    // This describe block predates ENABLE_LOCAL_EMBEDDINGS and tests the hybrid
    // (embeddings-on) path throughout — see 'embeddings disabled (BM25-only)' below for
    // the production-default path.
    vi.mocked(embeddingsEnabled).mockReset().mockReturnValue(true);
    vi.mocked(getRepoInfo).mockReset().mockResolvedValue({ description: '', defaultBranch: 'main', language: null, topics: [] });
    vi.mocked(ensureIndexed).mockReset();
    mockGroq();
  });

  it('rejects a request missing required fields', async () => {
    const res = await request(app).post('/v1/ask-repo').set('Origin', 'https://github.com').send({ context: { repoOwner: 'o' } });
    expect(res.status).toBe(400);
  });

  it('rejects a disallowed origin (CORS still enforced)', async () => {
    const res = await request(app)
      .post('/v1/ask-repo')
      .set('Origin', 'https://evil.com')
      .send({ question: 'where is auth', context: { repoOwner: 'owner', repoName: 'repo' } });
    expect(res.status).toBe(500);
    expect(res.text).toContain('Not allowed by CORS');
  });

  it('streams citations, then status, then answer chunks, then done — in that order', async () => {
    vi.mocked(ensureIndexed).mockResolvedValue(makeEntry());

    const res = await request(app)
      .post('/v1/ask-repo')
      .set('Origin', 'https://github.com')
      .send({ question: 'where is login handled', context: { repoOwner: 'owner', repoName: 'repo' } });

    const events = parseSseEvents(res.text);
    expect(events[0].type).toBe('citations');
    expect(events[0].citations).toEqual([
      { path: 'src/auth.ts', startLine: 1, endLine: 10, url: 'https://github.com/owner/repo/blob/main/src/auth.ts#L1-L10' },
    ]);
    expect(events[1]).toEqual({ type: 'status', indexing: 'complete' });
    const chunkEvents = events.filter((e) => e.type === 'chunk');
    expect(chunkEvents.map((e) => e.content).join('')).toBe('Hello world');
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('uses context.ref instead of looking up the default branch when a ref is provided', async () => {
    vi.mocked(ensureIndexed).mockResolvedValue(makeEntry());

    const res = await request(app)
      .post('/v1/ask-repo')
      .set('Origin', 'https://github.com')
      .send({ question: 'q', context: { repoOwner: 'owner', repoName: 'repo', ref: 'feature/x' } });

    expect(getRepoInfo).not.toHaveBeenCalled();
    const events = parseSseEvents(res.text);
    expect(events[0].citations[0].url).toContain('/blob/feature/x/');
    expect(ensureIndexed).toHaveBeenCalledWith('owner', 'repo', 'feature/x', 'q', expect.anything());
  });

  it('emits only an error event, no citations or answer, when the repo has nothing indexable', async () => {
    vi.mocked(ensureIndexed).mockResolvedValue(makeEntry({ chunks: [], bm25: new BM25Index([]), status: 'complete' }));

    const res = await request(app)
      .post('/v1/ask-repo')
      .set('Origin', 'https://github.com')
      .send({ question: 'q', context: { repoOwner: 'owner', repoName: 'repo' } });

    const events = parseSseEvents(res.text);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  it.each(['partial', 'background-indexing'] as const)(
    'reports indexing: "partial" to the client when the store entry status is %s',
    async (status) => {
      vi.mocked(ensureIndexed).mockResolvedValue(makeEntry({ status, remainingFiles: ['src/other.ts'] }));

      const res = await request(app)
        .post('/v1/ask-repo')
        .set('Origin', 'https://github.com')
        .send({ question: 'q', context: { repoOwner: 'owner', repoName: 'repo' } });

      const events = parseSseEvents(res.text);
      expect(events[1]).toEqual({ type: 'status', indexing: 'partial' });
    },
  );
});

describe('POST /v1/ask-repo with embeddings disabled (BM25-only, production default on Render)', () => {
  beforeEach(() => {
    vi.mocked(embeddingsEnabled).mockReset().mockReturnValue(false);
    vi.mocked(embedText).mockReset();
    vi.mocked(getRepoInfo).mockReset().mockResolvedValue({ description: '', defaultBranch: 'main', language: null, topics: [] });
    vi.mocked(ensureIndexed).mockReset();
    mockGroq();
  });

  it('never calls embedText, and still streams citations, status, answer chunks, and done via BM25 alone', async () => {
    // Chunk text/query chosen to lexically overlap ("login") so BM25 actually retrieves
    // it — proving the full pipeline (citations, indexing status, SSE answer stream)
    // keeps working end to end without embeddings, not just that it fails to 503.
    vi.mocked(ensureIndexed).mockResolvedValue(makeEntry({ chunks: [makeChunk({ embedding: null })] }));

    const res = await request(app)
      .post('/v1/ask-repo')
      .set('Origin', 'https://github.com')
      .send({ question: 'where is login handled', context: { repoOwner: 'owner', repoName: 'repo' } });

    expect(embedText).not.toHaveBeenCalled();

    const events = parseSseEvents(res.text);
    expect(events[0].type).toBe('citations');
    expect(events[0].citations).toEqual([
      { path: 'src/auth.ts', startLine: 1, endLine: 10, url: 'https://github.com/owner/repo/blob/main/src/auth.ts#L1-L10' },
    ]);
    expect(events[1]).toEqual({ type: 'status', indexing: 'complete' });
    const chunkEvents = events.filter((e) => e.type === 'chunk');
    expect(chunkEvents.map((e) => e.content).join('')).toBe('Hello world');
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('does not error or 503 just because embeddings are disabled, even when nothing matches lexically', async () => {
    vi.mocked(ensureIndexed).mockResolvedValue(makeEntry({ chunks: [makeChunk({ embedding: null })] }));

    const res = await request(app)
      .post('/v1/ask-repo')
      .set('Origin', 'https://github.com')
      .send({ question: 'zzznomatchingtermzzz', context: { repoOwner: 'owner', repoName: 'repo' } });

    expect(embedText).not.toHaveBeenCalled();
    expect(res.status).toBe(200);

    const events = parseSseEvents(res.text);
    expect(events[0]).toEqual({ type: 'citations', citations: [] }); // no lexical match — zero citations, not an error
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });
});
