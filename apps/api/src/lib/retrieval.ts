// Hybrid retrieval: merges a semantic (cosine-similarity) ranking with a lexical
// (BM25) ranking via Reciprocal Rank Fusion, then applies a per-file diversity cap.
//
// RRF (not a weighted score blend) is used because cosine similarity (bounded,
// roughly [-1,1]) and BM25 (unbounded, corpus-dependent) aren't on comparable scales —
// RRF sidesteps that by combining rank *positions* rather than raw scores, which is
// simpler to implement correctly and easier to justify than a tuned weight. It's the
// same technique used by e.g. Elasticsearch's hybrid search.
import { BM25Index } from './bm25';
import { ChunkRecord, cosineSimilarity } from './vector-store';

/** Text a chunk is indexed under for keyword search: its file path (so "chunking" finds
 * chunking.ts even when the code never says "chunking") followed by its content. */
export function chunkSearchText(chunk: Pick<ChunkRecord, 'filePath' | 'text'>): string {
  return `${chunk.filePath.replace(/[/._-]/g, ' ')}\n${chunk.text}`;
}

export interface RetrievalResult {
  chunk: ChunkRecord;
  score: number;
}

const RRF_K = 60;
export const TOP_K = 8;
export const MAX_PER_FILE = 3;

function rankByCosine(queryEmbedding: Float32Array, chunks: ChunkRecord[]): string[] {
  return chunks
    // Chunks indexed while embeddings were disabled have embedding: null — they simply
    // don't participate in the semantic ranking (BM25 alone still surfaces them).
    .filter((chunk): chunk is ChunkRecord & { embedding: Float32Array } => chunk.embedding !== null)
    .map((chunk) => ({ id: chunk.id, similarity: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
    .map((entry) => entry.id);
}

export function hybridRetrieve(
  // null when ENABLE_LOCAL_EMBEDDINGS isn't 'true' (see embeddings.ts) — retrieval then
  // runs BM25 only, skipping the semantic ranking/RRF-fusion step entirely rather than
  // treating an absent embedding as a zero vector, which would inject a meaningless,
  // arbitrarily-ordered rank contribution for every chunk.
  queryEmbedding: Float32Array | null,
  query: string,
  chunks: ChunkRecord[],
  bm25: BM25Index,
  options: { k?: number; maxPerFile?: number } = {},
): RetrievalResult[] {
  if (chunks.length === 0) return [];
  const k = options.k ?? TOP_K;
  const maxPerFile = options.maxPerFile ?? MAX_PER_FILE;

  const lexicalRanking = bm25.score(query).map((match) => match.id);

  const rrfScores = new Map<string, number>();
  const addRankContributions = (ranking: string[]) => {
    ranking.forEach((id, rank) => {
      rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  };
  addRankContributions(lexicalRanking);
  if (queryEmbedding) {
    addRankContributions(rankByCosine(queryEmbedding, chunks));
  }

  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const fused = Array.from(rrfScores.entries())
    .map(([id, score]) => ({ chunk: chunksById.get(id), score }))
    .filter((entry): entry is RetrievalResult => entry.chunk !== undefined)
    .sort((a, b) => b.score - a.score);

  // Diversity cap: greedily take the fused ranking in order, skipping any chunk once
  // its file has already contributed maxPerFile chunks — prevents one boilerplate-heavy
  // file from occupying every citation slot.
  const perFileCount = new Map<string, number>();
  const selected: RetrievalResult[] = [];
  for (const entry of fused) {
    const count = perFileCount.get(entry.chunk.filePath) ?? 0;
    if (count >= maxPerFile) continue;
    selected.push(entry);
    perFileCount.set(entry.chunk.filePath, count + 1);
    if (selected.length >= k) break;
  }

  return selected;
}
