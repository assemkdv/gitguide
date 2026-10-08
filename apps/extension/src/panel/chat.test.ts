import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock, deferred, flush, ChromeMock } from '../test/chrome-mock';
import { useStore } from './store';
import type { PageContext } from './store';
import { hydrateChat, sendChatMessage, stopChat, retryAnswer, clearConversation, resetChatModuleForTests } from './chat';
import { buildChatHistory } from './chat-history';

const SHA = 'b'.repeat(40);
const repo: PageContext = { repoOwner: 'owner', repoName: 'repo', page: 'repo' };
const chatKey = 'chat:v2:owner/repo';

let chrome: ChromeMock;

async function startConversation(ctx: PageContext = repo) {
  useStore.setState({ pageContext: ctx });
  await hydrateChat(`${ctx.repoOwner}/${ctx.repoName}`);
}

const lastPort = () => chrome.ports[chrome.ports.length - 1];
const messages = () => useStore.getState().chatMessages;
const assistant = () => messages().filter((m) => m.role === 'assistant').at(-1)!;

beforeEach(() => {
  chrome = installChromeMock();
  useStore.setState(useStore.getInitialState());
  resetChatModuleForTests();
  document.head.innerHTML = '';
});

describe('hydration', () => {
  it('restores and validates saved history (dropping malformed entries)', async () => {
    chrome.store[chatKey] = {
      updatedAt: 1,
      messages: [
        { id: 'u1', role: 'user', content: 'hi' },
        { role: 'robot', content: 'bad' },
        { id: 'a1', role: 'assistant', content: 'hello', status: 'complete', citations: [{ path: 'x', startLine: 1, endLine: 2, url: 'javascript:alert(1)' }] },
      ],
    };
    await startConversation();
    expect(messages().map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(messages()[1].citations).toBeUndefined(); // unsafe URL dropped
  });

  it('a late hydration cannot overwrite a conversation started meanwhile', async () => {
    chrome.store[chatKey] = { updatedAt: 1, messages: [{ id: 'old', role: 'user', content: 'earlier question' }] };
    const gate = deferred<void>();
    const realGet = (globalThis as any).chrome.storage.local.get;
    (globalThis as any).chrome.storage.local.get = async (k: unknown) => {
      await gate.promise;
      return realGet(k);
    };
    useStore.setState({ pageContext: repo });
    const hydrating = hydrateChat('owner/repo');
    expect(sendChatMessage('new question')).toBe('sent');
    gate.resolve();
    await hydrating;
    expect(messages().map((m) => m.content)).toEqual(['earlier question', 'new question', '']);
    expect(assistant().status).toBe('streaming');
    await flush();
    // Storage keeps the earlier history too (it isn't overwritten by the early send).
    expect((chrome.store[chatKey] as any).messages.map((m: any) => m.content)).toEqual(['earlier question', 'new question']);
  });

  it('a slow load for repo A is discarded after switching to repo B', async () => {
    chrome.store[chatKey] = { updatedAt: 1, messages: [{ id: 'a', role: 'user', content: 'about A' }] };
    const gate = deferred<void>();
    const realGet = (globalThis as any).chrome.storage.local.get;
    (globalThis as any).chrome.storage.local.get = async (k: unknown) => {
      if (JSON.stringify(k).includes('owner/repo"')) await gate.promise;
      return realGet(k);
    };
    const loadingA = hydrateChat('owner/repo');
    await hydrateChat('owner/other');
    gate.resolve();
    await loadingA;
    expect(useStore.getState().chatConversationKey).toBe('owner/other');
    expect(messages()).toEqual([]);
  });

  it('reports unreadable storage without crashing', async () => {
    chrome.failGetWith = new Error('storage unavailable');
    await startConversation();
    expect(useStore.getState().chatHydrated).toBe(true);
    expect(useStore.getState().chatStorageWarning).toMatch(/couldn't be loaded/);
  });
});

describe('streaming', () => {
  it('builds an answer from status, citations, and chunks, completing only on done', async () => {
    await startConversation();
    sendChatMessage('where is login?');
    const port = lastPort();
    expect(port.posted[0]).toEqual({ question: 'where is login?', context: { repoOwner: 'owner', repoName: 'repo', ref: undefined }, history: [] });
    port.emit({ type: 'status', index: { status: 'complete', ref: 'main', commitSha: SHA, fullCoverage: true, retrieval: 'lexical', coverage: { indexedFiles: 3, eligibleFiles: 3 } } });
    port.emit({ type: 'citations', citations: [{ path: 'src/a.ts', startLine: 1, endLine: 4, url: `https://github.com/owner/repo/blob/${SHA}/src/a.ts#L1-L4` }] });
    port.emit({ type: 'chunk', content: 'In ' });
    port.emit({ type: 'chunk', content: '[1].' });
    expect(assistant().status).toBe('streaming');
    port.emit({ type: 'done', finishReason: 'stop' });
    expect(assistant()).toMatchObject({ status: 'complete', content: 'In [1].', index: { ref: 'main', indexedFiles: 3 } });
    expect(assistant().citations).toHaveLength(1);
    expect(useStore.getState().chatStreaming).toBe(false);
    await flush();
    expect((chrome.store[chatKey] as any).messages).toHaveLength(2);
  });

  it('marks an answer interrupted (not complete) when the stream disconnects without done', async () => {
    await startConversation();
    sendChatMessage('q');
    lastPort().emit({ type: 'chunk', content: 'partial' });
    lastPort().remoteDisconnect();
    expect(assistant()).toMatchObject({ status: 'interrupted', content: 'partial' });
    expect(useStore.getState().chatStreaming).toBe(false);
  });

  it('shows a structured error separately from the answer text', async () => {
    await startConversation();
    sendChatMessage('q');
    lastPort().emit({ type: 'error', code: 'AI_RATE_LIMITED', message: 'The AI provider is rate-limiting GitGuide right now. Please wait a moment and try again.', retryAfterSec: 30 });
    expect(assistant().status).toBe('error');
    expect(assistant().content).toBe('');
    expect(assistant().error?.message).toMatch(/about 30 seconds/);
  });

  it('Stop keeps the partial answer, marks it stopped, and disconnects the port', async () => {
    await startConversation();
    sendChatMessage('q');
    const port = lastPort();
    port.emit({ type: 'chunk', content: 'half an answer' });
    stopChat();
    expect(port.disconnected).toBe(true);
    expect(assistant()).toMatchObject({ status: 'stopped', content: 'half an answer' });
    port.emit({ type: 'chunk', content: ' late' }); // ignored after stop
    expect(assistant().content).toBe('half an answer');
  });

  it('refuses to start a second answer while one is streaming', async () => {
    await startConversation();
    expect(sendChatMessage('one')).toBe('sent');
    expect(sendChatMessage('two')).toBe('busy');
    expect(chrome.ports).toHaveLength(1);
  });

  it('late events from a previous repository never reach the new conversation', async () => {
    await startConversation();
    sendChatMessage('about repo');
    const oldPort = lastPort();
    await hydrateChat('owner/other');
    expect(oldPort.disconnected).toBe(true);
    oldPort.emit({ type: 'chunk', content: 'stale' });
    expect(messages()).toEqual([]);
  });

  it('sends the viewed ref on file pages', async () => {
    await startConversation({ ...repo, page: 'file', filePath: 'a.ts', fileRef: 'v2.0.0' });
    sendChatMessage('q');
    expect((lastPort().posted[0] as any).context.ref).toBe('v2.0.0');
  });

  it('does not send anything for a repository the page marks as private', async () => {
    document.head.innerHTML =
      '<meta name="octolytics-dimension-repository_nwo" content="owner/repo"><meta name="octolytics-dimension-repository_public" content="false">';
    await startConversation();
    expect(sendChatMessage('q')).toBe('private');
    expect(chrome.ports).toHaveLength(0);
  });
});

describe('retry', () => {
  it('re-asks the same question, replacing the failed answer, with history from before it', async () => {
    await startConversation();
    sendChatMessage('first');
    lastPort().emit({ type: 'chunk', content: 'answer one' });
    lastPort().emit({ type: 'done', finishReason: 'stop' });
    sendChatMessage('second');
    lastPort().emit({ type: 'error', code: 'UPSTREAM_TIMEOUT', message: 'timeout' });
    const failedId = assistant().id;

    expect(retryAnswer(failedId)).toBe(true);
    expect(messages().map((m) => m.content)).toEqual(['first', 'answer one', 'second', '']);
    expect(lastPort().posted[0]).toMatchObject({
      question: 'second',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer one' },
      ],
    });
  });
});

describe('storage failures', () => {
  it('keeps the answer on screen and warns when history cannot be saved', async () => {
    await startConversation();
    chrome.failSetWith = new Error('QUOTA_BYTES quota exceeded');
    sendChatMessage('q');
    lastPort().emit({ type: 'chunk', content: 'kept' });
    lastPort().emit({ type: 'done', finishReason: 'stop' });
    await flush();
    expect(assistant()).toMatchObject({ status: 'complete', content: 'kept' });
    expect(useStore.getState().chatStorageWarning).toMatch(/couldn't be saved/);
  });

  it('clearConversation removes saved history', async () => {
    chrome.store[chatKey] = { updatedAt: 1, messages: [{ id: 'u', role: 'user', content: 'x' }] };
    await startConversation();
    await clearConversation();
    expect(chrome.store[chatKey]).toBeUndefined();
    expect(messages()).toEqual([]);
  });
});

describe('buildChatHistory', () => {
  it('excludes failed, interrupted, stopped, and streaming answers', () => {
    const history = buildChatHistory([
      { id: '1', role: 'user', content: 'q1' },
      { id: '2', role: 'assistant', content: 'good', status: 'complete' },
      { id: '3', role: 'user', content: 'q2' },
      { id: '4', role: 'assistant', content: 'partial', status: 'interrupted' },
      { id: '5', role: 'assistant', content: 'stopped', status: 'stopped' },
      { id: '6', role: 'assistant', content: 'legacy answer' },
    ]);
    expect(history.map((h) => h.content)).toEqual(['q1', 'good', 'q2', 'legacy answer']);
  });

  it('truncates oversized turns to the server limit', () => {
    const [turn] = buildChatHistory([{ id: '1', role: 'user', content: 'x'.repeat(5000) }]);
    expect(turn.content.length).toBe(4000);
  });
});
