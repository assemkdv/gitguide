import { describe, it, expect } from 'vitest';
import { BM25Index, tokenize } from './bm25';

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric characters', () => {
    expect(tokenize('getRepoTree(owner, repo)')).toEqual(['getrepotree', 'owner', 'repo']);
  });

  it('drops stopwords and single-character tokens', () => {
    expect(tokenize('a function to get the file')).toEqual(['function', 'get', 'file']);
  });

  it('returns [] for content with no meaningful tokens', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('BM25Index', () => {
  const documents = [
    { id: 'auth', text: 'function authenticateUser(token) { return verifyToken(token); }' },
    { id: 'routes', text: 'router.post("/api/issues", handleCreateIssue);' },
    { id: 'unrelated', text: 'function formatDate(date) { return date.toISOString(); }' },
  ];

  it('ranks the document containing the exact query term first', () => {
    const index = new BM25Index(documents);
    const results = index.score('authenticateUser');
    expect(results[0].id).toBe('auth');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('excludes documents that share no term with the query', () => {
    const index = new BM25Index(documents);
    const results = index.score('authenticateUser');
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain('unrelated');
  });

  it('matches an API-route-shaped query against the routing document', () => {
    const index = new BM25Index(documents);
    const results = index.score('issues route handler');
    expect(results[0].id).toBe('routes');
  });

  it('returns [] for a query with no indexable terms', () => {
    const index = new BM25Index(documents);
    expect(index.score('the a to')).toEqual([]);
  });

  it('handles an empty corpus without throwing', () => {
    const index = new BM25Index([]);
    expect(index.score('anything')).toEqual([]);
  });

  it('scores a rare exact-match term higher than a term common to every document', () => {
    const corpus = [
      { id: 'a', text: 'common word here, plus rareidentifier appears' },
      { id: 'b', text: 'common word here as well, nothing special' },
      { id: 'c', text: 'common word here too, just filler text' },
    ];
    const index = new BM25Index(corpus);
    const rareResults = index.score('rareidentifier');
    const commonResults = index.score('common');
    expect(rareResults[0].id).toBe('a');
    // The rare term's idf-weighted score should exceed any single document's
    // contribution from a term that appears in every document in the corpus.
    expect(rareResults[0].score).toBeGreaterThan(commonResults[0].score);
  });
});
