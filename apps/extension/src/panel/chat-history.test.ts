import { describe, it, expect } from 'vitest';
import { buildChatHistory, MAX_HISTORY_MESSAGES } from './chat-history';
import type { ChatMessage } from './store';

describe('buildChatHistory', () => {
  it('maps messages to plain {role, content} pairs, dropping citations and indexingStatus', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'where is auth?' },
      {
        role: 'assistant',
        content: 'It is in src/auth.ts.',
        citations: [{ path: 'src/auth.ts', startLine: 1, endLine: 10, url: 'https://github.com/o/r/blob/main/src/auth.ts#L1-L10' }],
        indexingStatus: 'complete',
      },
    ];

    expect(buildChatHistory(messages)).toEqual([
      { role: 'user', content: 'where is auth?' },
      { role: 'assistant', content: 'It is in src/auth.ts.' },
    ]);
  });

  it('excludes an empty message (the in-flight streaming placeholder for the new turn)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
    ];

    expect(buildChatHistory(messages)).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('excludes a whitespace-only message', () => {
    expect(buildChatHistory([{ role: 'assistant', content: '   ' }])).toEqual([]);
  });

  it(`bounds the result to the most recent ${MAX_HISTORY_MESSAGES} messages`, () => {
    const messages: ChatMessage[] = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : ('assistant' as const),
      content: `turn ${i}`,
    }));

    const history = buildChatHistory(messages);

    expect(history).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(history[0].content).toBe('turn 5'); // oldest 5 dropped
    expect(history[history.length - 1].content).toBe(`turn ${MAX_HISTORY_MESSAGES + 4}`);
  });

  it('returns an empty array for a brand-new conversation', () => {
    expect(buildChatHistory([])).toEqual([]);
  });
});
