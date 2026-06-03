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
    useStore.setState({ pageContext, chatMessages: [{ role: 'user', content: 'hi' }] });

    useStore.getState().resetResults();

    expect(useStore.getState().pageContext).toBe(pageContext);
    expect(useStore.getState().chatMessages).toHaveLength(1);
  });
});
