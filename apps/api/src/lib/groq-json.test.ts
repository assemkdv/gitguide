import { describe, it, expect } from 'vitest';
import { parseJsonCompletion } from './groq-json';

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

  it('throws on genuinely invalid JSON rather than silently returning something wrong', () => {
    expect(() => parseJsonCompletion('not json at all')).toThrow();
  });
});
