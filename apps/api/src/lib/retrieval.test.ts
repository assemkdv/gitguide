import { describe, it, expect } from 'vitest';
import { BM25Index, BM25Document } from './bm25';
import { ChunkRecord } from './vector-store';
import { hybridRetrieve } from './retrieval';

function makeChunk(overrides: Partial<ChunkRecord> & Pick<ChunkRecord, 'id' | 'filePath' | 'text' | 'embedding'>): ChunkRecord {
  return {
    repoOwner: 'owner',
    repoName: 'repo',
    sha: 'sha1',
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    ...overrides,
  };
}

function buildBm25(chunks: ChunkRecord[]): BM25Index {
  const docs: BM25Document[] = chunks.map((c) => ({ id: c.id, text: c.text }));
  return new BM25Index(docs);
}

describe('hybridRetrieve', () => {
  it('returns [] for an empty chunk list', () => {
    const result = hybridRetrieve(new Float32Array([1, 0]), 'anything', [], new BM25Index([]));
    expect(result).toEqual([]);
  });

  it('RRF-fusion favors a chunk that ranks well on both signals over chunks that dominate only one', () => {
    const query = 'identifierX';
    const queryEmbedding = new Float32Array([1, 0]);

    // Ranks 1st semantically, but never mentions the query term (absent from lexical
    // ranking entirely).
    const pureSemantic = makeChunk({
      id: 'pure-semantic',
      filePath: 'a.ts',
      text: 'nothing relevant to the query lexically at all',
      embedding: new Float32Array([1, 0]), // cos = 1
    });

    // Strong lexical match (term repeated), but semantically the worst possible match —
    // ranks dead last semantically, well behind the filler chunks below.
    const pureLexical = makeChunk({
      id: 'pure-lexical',
      filePath: 'b.ts',
      text: 'identifierX identifierX identifierX',
      embedding: new Float32Array([-1, 0]), // cos = -1, worst of all chunks
    });

    // Solidly 2nd-best on both signals — not the top of either ranking, but never the
    // worst either.
    const balanced = makeChunk({
      id: 'balanced',
      filePath: 'c.ts',
      text: 'some surrounding context around an identifierX usage',
      embedding: new Float32Array([0.7, 0.7]), // cos ≈ 0.707
    });

    // Filler chunks: mediocre semantic similarity (below `balanced`, above `pureLexical`),
    // no lexical match — exist purely to push pureLexical's semantic rank down to last,
    // giving RRF a wide enough rank spread to demonstrate the fusion effect.
    const fillers = Array.from({ length: 7 }, (_, i) =>
      makeChunk({
        id: `filler-${i}`,
        filePath: `filler-${i}.ts`,
        text: 'unrelated filler content with no special terms',
        embedding: new Float32Array([0.3, 0.9]), // cos ≈ 0.316
      }),
    );

    const chunks = [pureSemantic, pureLexical, balanced, ...fillers];
    const bm25 = buildBm25(chunks);

    const results = hybridRetrieve(queryEmbedding, query, chunks, bm25, { k: 10, maxPerFile: 10 });

    expect(results[0].chunk.id).toBe('balanced');
  });

  it('caps the number of chunks selected from any single file', () => {
    const queryEmbedding = new Float32Array([1, 0]);
    const popularFileChunks = Array.from({ length: 6 }, (_, i) =>
      makeChunk({
        id: `popular-${i}`,
        filePath: 'popular.ts',
        startLine: i * 10 + 1,
        endLine: i * 10 + 10,
        text: 'matches the query term',
        embedding: new Float32Array([1, 0]), // all tied, cos = 1
      }),
    );
    const otherFileChunks = Array.from({ length: 2 }, (_, i) =>
      makeChunk({
        id: `other-${i}`,
        filePath: 'other.ts',
        text: 'matches the query term',
        embedding: new Float32Array([1, 0]),
      }),
    );

    const chunks = [...popularFileChunks, ...otherFileChunks];
    const bm25 = buildBm25(chunks);

    const results = hybridRetrieve(queryEmbedding, 'matches query term', chunks, bm25, { k: 8, maxPerFile: 3 });

    const popularCount = results.filter((r) => r.chunk.filePath === 'popular.ts').length;
    const otherCount = results.filter((r) => r.chunk.filePath === 'other.ts').length;
    expect(popularCount).toBeLessThanOrEqual(3);
    expect(otherCount).toBe(2); // not crowded out despite popular.ts's chunks tying on score
  });

  it('respects the k limit even when more chunks would otherwise qualify', () => {
    const queryEmbedding = new Float32Array([1, 0]);
    const chunks = Array.from({ length: 20 }, (_, i) =>
      makeChunk({
        id: `c-${i}`,
        filePath: `file-${i}.ts`, // one file each, so the diversity cap never triggers
        text: 'relevant content',
        embedding: new Float32Array([1, 0]),
      }),
    );
    const bm25 = buildBm25(chunks);

    const results = hybridRetrieve(queryEmbedding, 'relevant', chunks, bm25, { k: 5, maxPerFile: 3 });
    expect(results).toHaveLength(5);
  });

  describe('BM25-only mode (queryEmbedding: null — ENABLE_LOCAL_EMBEDDINGS not "true")', () => {
    it('still retrieves purely from the lexical ranking, with no semantic contribution at all', () => {
      // Best possible embedding match, but zero lexical overlap with the query — should
      // NOT be retrieved when queryEmbedding is null, proving semantic ranking is fully
      // skipped rather than merely down-weighted.
      const semanticOnly = makeChunk({
        id: 'semantic-only',
        filePath: 'a.ts',
        text: 'nothing relevant to the query lexically at all',
        embedding: new Float32Array([1, 0]),
      });
      const lexicalMatch = makeChunk({
        id: 'lexical-match',
        filePath: 'b.ts',
        text: 'identifierX identifierX identifierX',
        embedding: new Float32Array([-1, 0]), // worst possible cosine — irrelevant here
      });

      const chunks = [semanticOnly, lexicalMatch];
      const bm25 = buildBm25(chunks);

      const results = hybridRetrieve(null, 'identifierX', chunks, bm25, { k: 10, maxPerFile: 10 });

      expect(results.map((r) => r.chunk.id)).toEqual(['lexical-match']);
    });

    it('returns [] when the query has no lexical overlap with any chunk, rather than falling back to semantic order', () => {
      const chunks = [makeChunk({ id: 'a', filePath: 'a.ts', text: 'completely unrelated content', embedding: new Float32Array([1, 0]) })];
      const bm25 = buildBm25(chunks);

      const results = hybridRetrieve(null, 'nomatchingtermhere', chunks, bm25);

      expect(results).toEqual([]);
    });

    it('still applies the per-file diversity cap using BM25 order alone', () => {
      const popularFileChunks = Array.from({ length: 6 }, (_, i) =>
        makeChunk({
          id: `popular-${i}`,
          filePath: 'popular.ts',
          startLine: i * 10 + 1,
          endLine: i * 10 + 10,
          text: 'matches the query term',
          embedding: null,
        }),
      );
      const bm25 = buildBm25(popularFileChunks);

      const results = hybridRetrieve(null, 'matches query term', popularFileChunks, bm25, { k: 8, maxPerFile: 3 });

      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  it('skips chunks with a null embedding in the semantic ranking, without crashing, when queryEmbedding is provided', () => {
    // A mixed corpus (e.g. some chunks indexed while embeddings were enabled, others
    // while disabled) shouldn't crash cosineSimilarity — chunks lacking an embedding
    // just don't get a semantic-ranking contribution, but can still surface via BM25.
    const withEmbedding = makeChunk({
      id: 'with-embedding',
      filePath: 'a.ts',
      text: 'unrelated to the query',
      embedding: new Float32Array([1, 0]),
    });
    const withoutEmbedding = makeChunk({
      id: 'without-embedding',
      filePath: 'b.ts',
      text: 'identifierX identifierX identifierX',
      embedding: null,
    });
    const chunks = [withEmbedding, withoutEmbedding];
    const bm25 = buildBm25(chunks);

    const results = hybridRetrieve(new Float32Array([1, 0]), 'identifierX', chunks, bm25, { k: 10, maxPerFile: 10 });

    expect(results.map((r) => r.chunk.id)).toContain('without-embedding');
  });
});
