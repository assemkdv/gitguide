// Ask GitGuide conversation logic. Streams answers through the background service worker
// (port 'chat-stream'), which relays the API's SSE events.
//
// Invariants:
// - Updates are addressed to a message *id* in a specific conversation, never "the last
//   message", so a late event can't land in a different conversation or answer.
// - Loading saved history merges with anything typed meanwhile instead of replacing it.
// - An answer is only 'complete' after an explicit `done` event. A stream that ends any
//   other way is shown as interrupted (or stopped, if the user pressed Stop).
// - Storage failures never discard an answer; they surface a warning instead.
import { useStore, ChatMessage, ChatMessageStatus, PageContext, repoKeyOf } from './store';
import { loadRepoChatMessages, saveRepoChatMessages, clearRepoChatMessages } from './storage';
import { buildChatHistory } from './chat-history';
import { normalizeCitation, normalizeIndexInfo, isObject } from './validate';
import { toUiError, ApiClientError } from './api-client';
import { detectRepoVisibility } from '../content/page-parser';

export const CHAT_PORT_NAME = 'chat-stream';
const STORAGE_WARNING = "Chat history couldn't be saved on this device (browser storage may be full). Your answers are still shown here.";

interface ActiveStream {
  port: chrome.runtime.Port;
  conversationKey: string;
  messageId: string;
  finished: boolean;
}

let active: ActiveStream | null = null;
let hydrateGeneration = 0;
let idCounter = 0;

function newId(prefix: string): string {
  idCounter++;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

function updateMessage(conversationKey: string, id: string, update: (m: ChatMessage) => ChatMessage): void {
  useStore.setState((s) => {
    if (s.chatConversationKey !== conversationKey) return {};
    const index = s.chatMessages.findIndex((m) => m.id === id);
    if (index === -1) return {};
    const chatMessages = [...s.chatMessages];
    chatMessages[index] = update(chatMessages[index]);
    return { chatMessages };
  });
}

async function persist(conversationKey: string): Promise<void> {
  const s = useStore.getState();
  // Until saved history has been loaded and merged, writing would overwrite it in
  // storage; hydrateChat persists once the merge is done.
  if (s.chatConversationKey !== conversationKey || !s.chatHydrated) return;
  const ok = await saveRepoChatMessages(conversationKey, s.chatMessages.filter((m) => m.status !== 'streaming'));
  if (useStore.getState().chatConversationKey === conversationKey) {
    useStore.setState({ chatStorageWarning: ok ? null : STORAGE_WARNING });
  }
}

/** Switches the in-memory conversation to `repoKey` and loads its saved history. Safe to
 * call repeatedly; a slow load can never overwrite messages added in the meantime. */
export async function hydrateChat(repoKey: string | null): Promise<void> {
  const s = useStore.getState();
  if (s.chatConversationKey === repoKey) return;
  disconnectActiveStream();
  const generation = ++hydrateGeneration;
  useStore.setState({ chatConversationKey: repoKey, chatMessages: [], chatHydrated: repoKey == null, chatStreaming: false, chatStorageWarning: null });
  if (!repoKey) return;

  const { messages, ok } = await loadRepoChatMessages(repoKey);
  if (generation !== hydrateGeneration || useStore.getState().chatConversationKey !== repoKey) return;
  const addedMeanwhile = useStore.getState().chatMessages.length > 0;
  useStore.setState((state) => ({
    // Anything sent while history was loading stays, after the restored messages.
    chatMessages: [...messages.filter((m) => !state.chatMessages.some((n) => n.id === m.id)), ...state.chatMessages],
    chatHydrated: true,
    chatStorageWarning: ok ? null : "Saved chat history couldn't be loaded.",
  }));
  if (addedMeanwhile && ok) void persist(repoKey);
}

function disconnectActiveStream(): void {
  if (!active) return;
  const stream = active;
  active = null;
  stream.finished = true;
  try {
    stream.port.disconnect();
  } catch {
    // Already disconnected.
  }
  updateMessage(stream.conversationKey, stream.messageId, (m) => (m.status === 'streaming' ? { ...m, status: 'stopped' } : m));
  useStore.setState({ chatStreaming: false });
}

function finish(stream: ActiveStream, status: ChatMessageStatus, extra: Partial<ChatMessage> = {}): void {
  if (stream.finished) return;
  stream.finished = true;
  if (active === stream) active = null;
  try {
    stream.port.disconnect();
  } catch {
    // Already disconnected.
  }
  updateMessage(stream.conversationKey, stream.messageId, (m) => ({ ...m, status, ...extra }));
  if (useStore.getState().chatConversationKey === stream.conversationKey) useStore.setState({ chatStreaming: false });
  void persist(stream.conversationKey);
}

function handleEvent(stream: ActiveStream, raw: unknown): void {
  if (stream.finished || !isObject(raw) || typeof raw.type !== 'string') return;
  const { conversationKey, messageId } = stream;
  switch (raw.type) {
    case 'status': {
      const index = normalizeIndexInfo(raw.index);
      if (index) updateMessage(conversationKey, messageId, (m) => ({ ...m, index }));
      break;
    }
    case 'citations': {
      const citations = Array.isArray(raw.citations) ? raw.citations.map(normalizeCitation).filter((c) => c !== null) : [];
      updateMessage(conversationKey, messageId, (m) => ({ ...m, citations }));
      break;
    }
    case 'chunk':
      if (typeof raw.content === 'string') updateMessage(conversationKey, messageId, (m) => ({ ...m, content: m.content + raw.content }));
      break;
    case 'done':
      finish(stream, 'complete', { finishReason: typeof raw.finishReason === 'string' ? raw.finishReason : null });
      break;
    case 'error': {
      const code = typeof raw.code === 'string' ? raw.code : 'UNKNOWN';
      const error = toUiError(
        new ApiClientError(code, typeof raw.message === 'string' ? raw.message : '', null, typeof raw.retryAfterSec === 'number' ? raw.retryAfterSec : null),
      );
      finish(stream, 'error', { error: { code, message: error.message } });
      break;
    }
  }
}

function startStream(ctx: PageContext, conversationKey: string, question: string, historySource: ChatMessage[]): void {
  const messageId = newId('a');
  const history = buildChatHistory(historySource);
  useStore.setState((s) => ({
    chatMessages: [...s.chatMessages, { id: messageId, role: 'assistant', content: '', status: 'streaming' }],
    chatStreaming: true,
  }));

  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
  } catch {
    // The extension was updated/reloaded under this page: the content script is orphaned.
    updateMessage(conversationKey, messageId, (m) => ({
      ...m,
      status: 'error',
      error: { code: 'EXTENSION_RELOADED', message: 'GitGuide was updated. Reload this page to keep using it.' },
    }));
    useStore.setState({ chatStreaming: false });
    return;
  }

  const stream: ActiveStream = { port, conversationKey, messageId, finished: false };
  active = stream;
  port.onMessage.addListener((raw: unknown) => handleEvent(stream, raw));
  // Disconnect without done/error = the service worker or network went away mid-answer.
  port.onDisconnect.addListener(() => finish(stream, 'interrupted'));
  port.postMessage({
    question,
    context: {
      repoOwner: ctx.repoOwner,
      repoName: ctx.repoName,
      ref: ctx.page === 'file' ? ctx.fileRef : undefined,
    },
    history,
  });
}

export type SendResult = 'sent' | 'busy' | 'empty' | 'private' | 'no-repo';

export function sendChatMessage(text: string): SendResult {
  const s = useStore.getState();
  const question = text.trim();
  const ctx = s.pageContext;
  if (!question) return 'empty';
  if (!ctx) return 'no-repo';
  if (s.chatStreaming || active) return 'busy';
  if (detectRepoVisibility(ctx.repoOwner, ctx.repoName) === 'private') return 'private';
  const conversationKey = repoKeyOf(ctx.repoOwner, ctx.repoName);
  if (s.chatConversationKey !== conversationKey) return 'no-repo';

  const before = s.chatMessages;
  useStore.setState({ chatInput: '', chatMessages: [...before, { id: newId('u'), role: 'user', content: question }] });
  void persist(conversationKey);
  startStream(ctx, conversationKey, question, before);
  return 'sent';
}

/** Stops the answer being generated. The partial text stays, marked as stopped; the
 * port disconnect makes the service worker abort the request, and the server stops. */
export function stopChat(): void {
  if (!active) return;
  finish(active, 'stopped');
}

/** Re-asks the question behind a failed/stopped/interrupted answer, replacing it. */
export function retryAnswer(assistantMessageId: string): boolean {
  const s = useStore.getState();
  const ctx = s.pageContext;
  if (!ctx || s.chatStreaming || active || !s.chatConversationKey) return false;
  const index = s.chatMessages.findIndex((m) => m.id === assistantMessageId);
  const question = index > 0 ? s.chatMessages[index - 1] : undefined;
  if (index === -1 || !question || question.role !== 'user') return false;

  const conversationKey = s.chatConversationKey;
  const historySource = s.chatMessages.slice(0, index - 1);
  useStore.setState({ chatMessages: s.chatMessages.filter((m) => m.id !== assistantMessageId) });
  startStream(ctx, conversationKey, question.content, historySource);
  return true;
}

export async function clearConversation(): Promise<void> {
  const key = useStore.getState().chatConversationKey;
  disconnectActiveStream();
  if (key) await clearRepoChatMessages(key);
  useStore.setState({ chatMessages: [], chatInput: '', chatStreaming: false, chatStorageWarning: null });
}

/** Clears in-memory chat state after "clear all data" (storage already wiped). */
export function resetChatState(): void {
  disconnectActiveStream();
  useStore.setState({ chatMessages: [], chatInput: '', chatStreaming: false, chatStorageWarning: null });
}

/** Test helper. */
export function resetChatModuleForTests(): void {
  active = null;
  hydrateGeneration = 0;
}
