import type { ChatMessage } from './store';

// Mirrors askRepoSchema's own `history.max(12)` cap (apps/api/src/lib/schemas.ts /
// apps/api/src/routes/ask-repo.ts's MAX_HISTORY_TURNS) — kept in sync manually since the
// two live in separate packages with no shared types.
export const MAX_HISTORY_MESSAGES = 12;

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Builds the `history` field sent to /v1/ask-repo from the messages already in the
 * conversation *before* the new turn — the just-typed question and its empty streaming
 * placeholder aren't prior history yet, so callers must pass the message list as it
 * stood before appending either of those. Strips fields the backend doesn't accept
 * (citations, indexingStatus), drops empty messages (a placeholder left over from an
 * aborted/failed turn), and bounds the result to the backend's own documented turn cap.
 */
export function buildChatHistory(messages: ChatMessage[]): ChatHistoryTurn[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({ role: message.role, content: message.content }));
}
