import { describe, it, expect } from 'vitest';
import { cosineSimilarity, InMemoryVectorStore } from './vector-store';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3]))).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1);
  });

  it('returns 0 (not NaN) when either vector is all zeros', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 2]))).toBe(0);
  });
});

describe('InMemoryVectorStore', () => {
  it('stores and retrieves values by key', () => {
    const store = new InMemoryVectorStore<string>(5);
    store.set('owner/repo@sha1', 'entry-1');
    expect(store.get('owner/repo@sha1')).toBe('entry-1');
    expect(store.has('owner/repo@sha1')).toBe(true);
    expect(store.has('missing')).toBe(false);
    expect(store.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry once over the max size', () => {
    const store = new InMemoryVectorStore<string>(3);
    store.set('a', '1');
    store.set('b', '2');
    store.set('c', '3');
    store.set('d', '4'); // over capacity — 'a' (oldest, never re-accessed) should go

    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(true);
    expect(store.has('c')).toBe(true);
    expect(store.has('d')).toBe(true);
  });

  it('a get() bumps recency, protecting an entry from eviction', () => {
    const store = new InMemoryVectorStore<string>(3);
    store.set('a', '1');
    store.set('b', '2');
    store.set('c', '3');
    store.get('a'); // 'a' is now the most recently used, 'b' is now the oldest
    store.set('d', '4'); // should evict 'b', not 'a'

    expect(store.has('a')).toBe(true);
    expect(store.has('b')).toBe(false);
    expect(store.has('c')).toBe(true);
    expect(store.has('d')).toBe(true);
  });

  it('re-setting an existing key refreshes its recency without growing the store', () => {
    const store = new InMemoryVectorStore<string>(3);
    store.set('a', '1');
    store.set('b', '2');
    store.set('c', '3');
    store.set('a', '1-updated'); // 'a' refreshed, 'b' is now the oldest
    store.set('d', '4');

    expect(store.get('a')).toBe('1-updated');
    expect(store.has('b')).toBe(false);
  });
});
