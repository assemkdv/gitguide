// Storage layer for indexed repo chunks. Deliberately in-process/in-memory for v1 (see
// the plan doc's vector-store comparison) — the `VectorStore<T>` interface is what
// keeps this a contained decision: a future SqliteVectorStore or RemoteVectorStore only
// needs to implement get/set/has, with no change to the retrieval/indexing code that
// depends on the interface, not this implementation.

export interface ChunkRecord {
  id: string; // `${filePath}:${startLine}-${endLine}` — stable within one repo+sha
  repoOwner: string;
  repoName: string;
  sha: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  text: string;
  // null when indexed while ENABLE_LOCAL_EMBEDDINGS wasn't 'true' — retrieval.ts skips
  // this chunk in the semantic ranking rather than treating it as a real embedding.
  embedding: Float32Array | null;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface VectorStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
}

const DEFAULT_MAX_ENTRIES = 5;

/**
 * LRU-evicted, keyed by `owner/repo@sha`. Recency is tracked via Map's insertion-order
 * iteration: every get()/set() deletes-then-reinserts the key, so the least-recently-
 * used entry is always the first one Map iterates — eviction just drops that one.
 */
export class InMemoryVectorStore<T> implements VectorStore<T> {
  private readonly entries = new Map<string, T>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
  }
}
