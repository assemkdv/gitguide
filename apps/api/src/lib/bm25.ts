// A small, fully-owned BM25 lexical scorer — the "keyword" half of hybrid retrieval,
// merged with cosine-similarity results via Reciprocal Rank Fusion (see retrieval.ts).
// Not a dependency: the corpus is small (a few thousand chunks at most, same scale
// reasoning that ruled out an ANN vector index in favor of brute-force cosine), so a
// compact, easily-explained implementation is simpler than adopting and learning a
// library's API for a search space this size.

export interface BM25Document {
  id: string;
  text: string;
}

export interface BM25Match {
  id: string;
  score: number;
}

const K1 = 1.2;
const B = 0.75;
const MIN_TOKEN_LENGTH = 2;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'as',
  'and', 'or', 'but', 'not', 'this', 'that', 'it', 'its', 'from', 'into', 'than',
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token),
  );
}

// Light suffix stripping so "chunks"/"chunking"/"chunked" and "limits"/"limited" meet.
// Deliberately crude (no dictionary); applied identically to documents and queries.
function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) return token.slice(0, -suffix.length);
  }
  return token;
}

/**
 * Tokens used for BM25 scoring: everything `tokenize` produces, plus the sub-words of
 * camelCase / PascalCase identifiers (so "getRepoTree" also matches "repo tree"), all
 * lightly stemmed. Kept separate from `tokenize`, which other callers use for path
 * matching where whole words are wanted.
 */
export function searchTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9]+/g) ?? []) {
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    const words = parts.length > 1 ? [raw, ...parts] : [raw];
    for (const word of words) {
      const lower = word.toLowerCase();
      if (lower.length < MIN_TOKEN_LENGTH || STOPWORDS.has(lower)) continue;
      out.push(stem(lower));
    }
  }
  return out;
}

interface Posting {
  id: string;
  termFrequency: number;
}

/** Built once per snapshot of a repo's chunk corpus (rebuilt, not mutated, whenever the
 * indexer appends chunks during background/Phase-B indexing — cheap at this corpus
 * size, and far simpler than maintaining incremental postings-list updates). */
export class BM25Index {
  private readonly postings = new Map<string, Posting[]>();
  private readonly docLengths = new Map<string, number>();
  private readonly avgDocLength: number;
  private readonly documentCount: number;

  constructor(documents: BM25Document[]) {
    this.documentCount = documents.length;
    let totalLength = 0;

    for (const doc of documents) {
      const tokens = searchTokens(doc.text);
      this.docLengths.set(doc.id, tokens.length);
      totalLength += tokens.length;

      const termFrequencies = new Map<string, number>();
      for (const token of tokens) {
        termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
      }
      for (const [term, termFrequency] of termFrequencies) {
        const posting: Posting = { id: doc.id, termFrequency };
        const existing = this.postings.get(term);
        if (existing) existing.push(posting);
        else this.postings.set(term, [posting]);
      }
    }

    this.avgDocLength = this.documentCount > 0 ? totalLength / this.documentCount : 0;
  }

  private idf(term: string): number {
    const docFrequency = this.postings.get(term)?.length ?? 0;
    if (docFrequency === 0) return 0;
    return Math.log(1 + (this.documentCount - docFrequency + 0.5) / (docFrequency + 0.5));
  }

  /** Ranked matches, descending by score. Only visits postings for the query's own
   * terms (never a full corpus scan) — documents sharing no term with the query never
   * appear, exactly like a real inverted-index search engine. */
  score(query: string): BM25Match[] {
    const queryTerms = Array.from(new Set(searchTokens(query)));
    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const postings = this.postings.get(term);
      if (!postings) continue;
      const idf = this.idf(term);

      for (const { id, termFrequency } of postings) {
        const docLength = this.docLengths.get(id) ?? 0;
        const denominator = termFrequency + K1 * (1 - B + (B * docLength) / (this.avgDocLength || 1));
        const contribution = idf * ((termFrequency * (K1 + 1)) / denominator);
        scores.set(id, (scores.get(id) ?? 0) + contribution);
      }
    }

    return Array.from(scores.entries())
      .map(([id, matchScore]) => ({ id, score: matchScore }))
      .sort((a, b) => b.score - a.score);
  }
}
