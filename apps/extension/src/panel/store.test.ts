import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, repoKeyOf } from './store';

describe('repoKeyOf', () => {
  it('formats a stable owner/repo key', () => {
    expect(repoKeyOf('owner', 'repo')).toBe('owner/repo');
  });
});

describe('result resets', () => {
  beforeEach(() => useStore.setState(useStore.getInitialState()));
  const err = { code: 'X', message: 'e', retryable: true };

  it('resetResults clears results, targets, loading, and errors for every action', () => {
    useStore.setState({
      activeAction: 'repo',
      repoResult: {} as any,
      repoResultTarget: 'repo:o/r',
      repoLoading: true,
      repoError: err,
      fileResult: {} as any,
      fileLoading: true,
      fileError: err,
      issueResult: {} as any,
      issueError: err,
      goodFirstIssuesResult: [],
      goodFirstIssuesError: err,
    });
    useStore.getState().resetResults();
    const s = useStore.getState();
    expect([s.repoResult, s.repoResultTarget, s.repoError, s.fileResult, s.fileError, s.issueResult, s.issueError, s.goodFirstIssuesResult, s.goodFirstIssuesError, s.activeAction]).toEqual(
      Array(10).fill(null),
    );
    expect(s.repoLoading || s.fileLoading).toBe(false);
  });

  it('does not touch page context or chat', () => {
    const pageContext = { repoOwner: 'o', repoName: 'r', page: 'repo' as const };
    useStore.setState({ pageContext, chatMessages: [{ id: '1', role: 'user', content: 'hi' }] });
    useStore.getState().resetResults();
    const s = useStore.getState();
    expect(s.pageContext).toBe(pageContext);
    expect(s.chatMessages).toHaveLength(1);
  });

  it('resetFileResult and resetIssueResult only clear their own action', () => {
    useStore.setState({ fileResult: {} as any, fileQuickResult: {} as any, issueResult: {} as any, repoResult: {} as any });
    useStore.getState().resetFileResult();
    expect(useStore.getState().fileResult).toBeNull();
    expect(useStore.getState().fileQuickResult).toBeNull();
    expect(useStore.getState().issueResult).not.toBeNull();
    useStore.getState().resetIssueResult();
    expect(useStore.getState().issueResult).toBeNull();
    expect(useStore.getState().repoResult).not.toBeNull();
  });
});
