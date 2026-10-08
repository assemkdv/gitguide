import type { ChatMessage } from './store';

// Mirrors askRepoSchema's own `history.max(12)` cap (apps/api/src/lib/schemas.ts) — kept
// in sync manually since the two live in separate packages with no shared types.
export const MAX_HISTORY_MESSAGES = 12;
// Mirrors the per-turn `content.max(4000)` cap in the same schema.
export const MAX_HISTORY_CONTENT_CHARS = 4000;

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Builds the `history` field sent to /v1/ask-repo from the messages already in the
 * conversation *before* the new turn. Only finished answers count as context: errored,
 * interrupted, stopped, or still-streaming answers are left out so the model never builds
 * on a partial or failed reply. Strips UI-only fields and bounds the result to the
 * backend's documented limits (oversized turns are cut rather than rejected).
 */
export function buildChatHistory(messages: ChatMessage[]): ChatHistoryTurn[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .filter((message) => message.role === 'user' || message.status === undefined || message.status === 'complete')
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({ role: message.role, content: message.content.slice(0, MAX_HISTORY_CONTENT_CHARS) }));
}
