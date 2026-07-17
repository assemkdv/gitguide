import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, repoKeyOf } from './store';

describe('repoKeyOf', () => {
  it('formats a stable owner/repo key', () => {
    expect(repoKeyOf('freeCodeCamp', 'freeCodeCamp')).toBe('freeCodeCamp/freeCodeCamp');
  });
});

describe('resetResults', () => {
  beforeEach(() => {
    // Zustand persists state across tests in the same module instance — start each
    // test from a known baseline instead of relying on execution order.
    useStore.setState(useStore.getInitialState());
  });

  it('clears results, loading, and error state for every action type', () => {
    useStore.setState({
      activeAction: 'file',
      pendingIssueNumber: 7,
      repoResult: { purpose: 'x' } as any,
      fileResult: { purpose: 'x' } as any,
      fileQuickResult: { purpose: 'x', summary: 'y' },
      fileLoading: true,
      fileError: 'boom',
      fileStage: 'complete',
      issueResult: { whatItAsks: [] } as any,
      issueLoading: true,
      issueError: 'boom',
      goodFirstIssuesResult: [{} as any],
      goodFirstIssuesLoading: true,
      goodFirstIssuesError: 'boom',
    });

    useStore.getState().resetResults();

    const s = useStore.getState();
    expect(s.activeAction).toBeNull();
    expect(s.pendingIssueNumber).toBeNull();
    expect(s.repoResult).toBeNull();
    expect(s.fileResult).toBeNull();
    expect(s.fileQuickResult).toBeNull();
    expect(s.fileLoading).toBe(false);
    expect(s.fileError).toBeNull();
    expect(s.fileStage).toBeNull();
    expect(s.issueResult).toBeNull();
    expect(s.issueLoading).toBe(false);
    expect(s.issueError).toBeNull();
    expect(s.goodFirstIssuesResult).toBeNull();
    expect(s.goodFirstIssuesLoading).toBe(false);
    expect(s.goodFirstIssuesError).toBeNull();
  });

  it('does not touch pageContext or chat state', () => {
    const pageContext = { repoOwner: 'o', repoName: 'r', page: 'repo' as const };
    useStore.setState({
      pageContext,
      chatMessages: [{ role: 'user', content: 'where is auth' }],
    });

    useStore.getState().resetResults();

    expect(useStore.getState().pageContext).toBe(pageContext);
    expect(useStore.getState().chatMessages).toHaveLength(1);
  });
});

describe('chat actions', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState());
  });

  it('appendToLastChatMessage only mutates a trailing assistant message', () => {
    useStore.getState().addChatMessage({ role: 'user', content: 'where is auth?' });
    useStore.getState().appendToLastChatMessage('should be ignored');
    expect(useStore.getState().chatMessages[0].content).toBe('where is auth?');

    useStore.getState().addChatMessage({ role: 'assistant', content: '' });
    useStore.getState().appendToLastChatMessage('It is in ');
    useStore.getState().appendToLastChatMessage('src/auth.ts');
    expect(useStore.getState().chatMessages[1].content).toBe('It is in src/auth.ts');
  });

  it('setLastChatMessageCitations sets citations only on a trailing assistant message', () => {
    const citations = [{ path: 'src/auth.ts', startLine: 1, endLine: 10, url: 'https://github.com/o/r/blob/main/src/auth.ts#L1-L10' }];

    useStore.getState().addChatMessage({ role: 'user', content: 'q' });
    useStore.getState().setLastChatMessageCitations(citations);
    expect(useStore.getState().chatMessages[0].citations).toBeUndefined();

    useStore.getState().addChatMessage({ role: 'assistant', content: '' });
    useStore.getState().setLastChatMessageCitations(citations);
    expect(useStore.getState().chatMessages[1].citations).toEqual(citations);
  });

  it('setLastChatMessageIndexingStatus sets status only on a trailing assistant message', () => {
    useStore.getState().addChatMessage({ role: 'assistant', content: '' });
    useStore.getState().setLastChatMessageIndexingStatus('partial');
    expect(useStore.getState().chatMessages[0].indexingStatus).toBe('partial');
  });

  it('resetChat clears messages, input, and streaming state', () => {
    useStore.setState({ chatMessages: [{ role: 'user', content: 'q' }], chatInput: 'typing', chatStreaming: true });
    useStore.getState().resetChat();

    const s = useStore.getState();
    expect(s.chatMessages).toEqual([]);
    expect(s.chatInput).toBe('');
    expect(s.chatStreaming).toBe(false);
  });
});
