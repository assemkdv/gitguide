import { describe, it, expect } from 'vitest';
import { createSseParser } from './sse';

function parseAll(chunks: string[]): string[] {
  const parser = createSseParser();
  return [...chunks.flatMap((c) => parser.push(c)), ...parser.end()];
}

describe('createSseParser', () => {
  const stream = 'data: {"type":"chunk","content":"a"}\n\ndata: {"type":"done"}\n\n';

  it('parses whole events', () => {
    expect(parseAll([stream])).toEqual(['{"type":"chunk","content":"a"}', '{"type":"done"}']);
  });

  it('handles events split at every possible position', () => {
    for (let i = 1; i < stream.length; i++) {
      expect(parseAll([stream.slice(0, i), stream.slice(i)])).toEqual(['{"type":"chunk","content":"a"}', '{"type":"done"}']);
    }
  });

  it('handles one character at a time', () => {
    expect(parseAll(stream.split(''))).toHaveLength(2);
  });

  it('accepts CRLF and lone CR line endings, including a CRLF split across chunks', () => {
    expect(parseAll(['data: 1\r\n\r\ndata: 2\r\rdata: 3\n\n'])).toEqual(['1', '2', '3']);
    expect(parseAll(['data: 1\r', '\n\r', '\n'])).toEqual(['1']);
  });

  it('joins multi-line data fields and ignores comments and other fields', () => {
    expect(parseAll([': keep-alive\n\nevent: x\nid: 1\ndata: line1\ndata: line2\n\n'])).toEqual(['line1\nline2']);
  });

  it('returns a final event without a trailing blank line at end of stream', () => {
    expect(parseAll(['data: {"type":"done"}'])).toEqual(['{"type":"done"}']);
  });

  it('does not emit anything for a stream of only heartbeats', () => {
    expect(parseAll([': ping\n\n', ': ping\n\n'])).toEqual([]);
  });
});
