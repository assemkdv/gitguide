import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseJsonCompletion, GroqResponseError } from './groq-json';

describe('parseJsonCompletion', () => {
  it('parses plain JSON with no fencing', () => {
    expect(parseJsonCompletion<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it('strips a ```json fenced block', () => {
    const raw = '```json\n{"a": 1}\n```';
    expect(parseJsonCompletion<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it('strips a plain ``` fenced block with no language tag', () => {
    const raw = '```\n{"a": 1}\n```';
    expect(parseJsonCompletion<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it('trims surrounding whitespace', () => {
    expect(parseJsonCompletion<{ a: number }>('  \n{"a": 1}\n  ')).toEqual({ a: 1 });
  });

  it('throws GroqResponseError on genuinely invalid JSON rather than silently returning something wrong', () => {
    expect(() => parseJsonCompletion('not json at all')).toThrow(GroqResponseError);
  });

  describe('with a schema', () => {
    const schema = z.object({
      title: z.string().catch(''),
      tags: z.array(z.string()).catch([]),
    });

    it('returns the parsed data unchanged when it matches the schema', () => {
      expect(parseJsonCompletion('{"title": "hi", "tags": ["a", "b"]}', schema)).toEqual({
        title: 'hi',
        tags: ['a', 'b'],
      });
    });

    it('degrades an individual malformed field to its .catch() fallback instead of failing the whole response', () => {
      expect(parseJsonCompletion('{"title": 42, "tags": ["a"]}', schema)).toEqual({
        title: '',
        tags: ['a'],
      });
    });

    it('degrades a missing field to its .catch() fallback', () => {
      expect(parseJsonCompletion('{"title": "hi"}', schema)).toEqual({
        title: 'hi',
        tags: [],
      });
    });

    it('throws GroqResponseError when the top-level response is not an object at all', () => {
      expect(() => parseJsonCompletion('["a", "b"]', schema)).toThrow(GroqResponseError);
    });
  });
});
