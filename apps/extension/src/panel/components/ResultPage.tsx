import { useEffect } from 'react';
import { useStore } from '../store';
import { runExplainFile, runSummarizeIssue, runAction, targetOf } from '../runActions';
import { navigateToIssue } from '../navigate';
import {
  RepoCard,
  FileCard,
  QuickFilePreview,
  IssueCard,
  GoodFirstIssueList,
  formatRepoResultAsText,
  formatFileResultAsText,
  formatIssueResultAsText,
} from './cards';
import { FileEmptyState, IssueEmptyState } from './guidance';
import { BackButton, ResultFooter, LoadingTicker, ErrorCard, sectionLabel } from './shared';
import type { GoodFirstIssueItem } from '../store';
import { isFileContentReady } from '../../content/page-parser';

const REPO_STEPS = ['Reading repository…', 'Understanding architecture…', 'Identifying key files…', 'Preparing explanation…'];
const ISSUE_STEPS = ['Reading the issue on GitHub…', 'Loading discussion comments…', 'Matching repository files…', 'Preparing implementation guidance…'];
const GOOD_FIRST_STEPS = ['Searching open issues…', 'Filtering by label…', 'Preparing list…'];
const DETECTING_ISSUE_STEPS = ['Detecting issue…'];

const ISSUE_OPEN_GRACE_MS = 400;

function formatGoodFirstIssuesAsText(issues: { number: number; title: string; category: string }[]): string {
  return issues.map((i) => `#${i.number} ${i.title} [${i.category}]`).join('\n');
}

function fileStepsFor(fileName: string): string[] {
  return [`Opening ${fileName}…`, 'Reading the file from GitHub…', 'Identifying imports and exports…', 'Understanding main functions…', 'Preparing explanation…'];
}

export function ResultPage() {
  const {
    pageContext,
    activeAction,
    pendingIssueNumber,
    setPendingIssueNumber,
    goToQuickActions,
    setView,
    setOpen,
    repoResult,
    repoResultTarget,
    repoLoading,
    repoError,
    fileResult,
    fileResultTarget,
    fileQuickResult,
    fileLoading,
    fileError,
    fileStage,
    issueResult,
    issueResultTarget,
    issueLoading,
    issueError,
    goodFirstIssuesResult,
    goodFirstIssuesResultTarget,
    goodFirstIssuesLoading,
    goodFirstIssuesError,
  } = useStore();

  // A result is only shown for the exact target it was produced for.
  const repoData = repoResult && repoResultTarget === targetOf('repo', pageContext) ? repoResult : null;
  const fileData = fileResult && fileResultTarget === targetOf('file', pageContext) ? fileResult : null;
  const issueData = issueResult && issueResultTarget === targetOf('issue', pageContext) ? issueResult : null;
  const gfiData =
    goodFirstIssuesResult && goodFirstIssuesResultTarget === targetOf('good-first-issues', pageContext) ? goodFirstIssuesResult : null;

  const fileReady = isFileContentReady(pageContext?.fileContent);
  const issueOnPage = pageContext?.page === 'issue';
  const issueTitleReady = issueOnPage && !!pageContext?.issueTitle;
  const pendingMatched = pendingIssueNumber != null && issueOnPage && pageContext?.issueNumber === pendingIssueNumber && issueTitleReady;

  // Clear the "opening issue" transitional state once the target issue has rendered.
  useEffect(() => {
    if (!pendingMatched) return;
    const t = setTimeout(() => setPendingIssueNumber(null), ISSUE_OPEN_GRACE_MS);
    return () => clearTimeout(t);
    // setPendingIssueNumber is a zustand action — stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMatched]);

  // Auto-detect: once the right kind of page is ready, start the analysis without another
  // click. runActions dedupes, so re-running this effect never duplicates a request.
  useEffect(() => {
    if (!pageContext) return;
    if (activeAction === 'file' && pageContext.page === 'file' && fileReady && !fileData && !fileLoading && !fileError) {
      void runExplainFile(pageContext);
    }
    if (activeAction === 'issue' && pendingIssueNumber == null && issueTitleReady && !issueData && !issueLoading && !issueError) {
      void runSummarizeIssue(pageContext);
    }
  }, [pageContext, activeAction, pendingIssueNumber, fileReady, issueTitleReady, fileData, fileLoading, fileError, issueData, issueLoading, issueError]);

  if (!pageContext || !activeAction) return null;

  const handleSelectIssue = (issue: GoodFirstIssueItem) => {
    setPendingIssueNumber(issue.number);
    useStore.setState({ activeAction: 'issue', view: 'result' });
    setOpen(true);
    navigateToIssue(pageContext.repoOwner, pageContext.repoName, issue.number);
  };

  const retry = () => void runAction[activeAction](pageContext, { force: true });

  const renderBody = () => {
    if (activeAction === 'repo') {
      if (repoLoading) return <LoadingTicker steps={REPO_STEPS} />;
      if (repoError) return <ErrorCard error={repoError} onRetry={retry} />;
      if (repoData) return <RepoCard data={repoData} onSelectIssue={handleSelectIssue} />;
      return <LoadingTicker steps={REPO_STEPS} />;
    }

    if (activeAction === 'file') {
      if (pageContext.page !== 'file') return <FileEmptyState />;
      const fileName = pageContext.filePath?.split('/').pop() ?? 'file';
      const fileHeading = `Analyzing ${fileName}`;
      if (fileError) return <ErrorCard error={fileError} onRetry={retry} />;
      if (!fileReady) {
        const label = fileStage === 'waiting_for_content' ? 'Waiting for GitHub to show the file…' : `Opening ${fileName}…`;
        return <LoadingTicker steps={[label]} title={fileHeading} subtitle={pageContext.filePath} />;
      }
      if (fileData) return <FileCard data={fileData} />;
      if (fileLoading && fileQuickResult) return <QuickFilePreview data={fileQuickResult} />;
      return <LoadingTicker steps={fileStepsFor(fileName)} title={fileHeading} subtitle={pageContext.filePath} />;
    }

    if (activeAction === 'issue') {
      if (pendingIssueNumber != null && !pendingMatched) {
        return <LoadingTicker steps={[`Opening Issue #${pendingIssueNumber}…`, 'Waiting for page to load…']} />;
      }
      if (pageContext.page !== 'issue') return <IssueEmptyState />;
      const issueHeading = pageContext.issueNumber ? `Analyzing Issue #${pageContext.issueNumber}` : undefined;
      if (issueError) return <ErrorCard error={issueError} onRetry={retry} />;
      if (!issueTitleReady) return <LoadingTicker steps={DETECTING_ISSUE_STEPS} title={issueHeading} />;
      if (issueData) return <IssueCard data={issueData} />;
      return <LoadingTicker steps={ISSUE_STEPS} title={issueHeading} subtitle={pageContext.issueTitle} />;
    }

    if (goodFirstIssuesLoading) return <LoadingTicker steps={GOOD_FIRST_STEPS} />;
    if (goodFirstIssuesError) return <ErrorCard error={goodFirstIssuesError} onRetry={retry} />;
    if (gfiData) {
      return (
        <div>
          <p style={sectionLabel}>Good first issues</p>
          <div style={{ marginTop: 8 }}>
            <GoodFirstIssueList issues={gfiData} onSelect={handleSelectIssue} />
          </div>
        </div>
      );
    }
    return <LoadingTicker steps={GOOD_FIRST_STEPS} />;
  };

  const getFooterText = (): string => {
    if (activeAction === 'repo' && repoData) return formatRepoResultAsText(repoData);
    if (activeAction === 'file' && fileData) return formatFileResultAsText(fileData);
    if (activeAction === 'issue' && issueData) return formatIssueResultAsText(issueData);
    if (activeAction === 'good-first-issues' && gfiData) return formatGoodFirstIssuesAsText(gfiData);
    return '';
  };

  const isDone =
    (activeAction === 'repo' && !!repoData && !repoLoading) ||
    (activeAction === 'file' && !!fileData && !fileLoading) ||
    (activeAction === 'issue' && !!issueData && !issueLoading) ||
    (activeAction === 'good-first-issues' && !!gfiData && !goodFirstIssuesLoading);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <BackButton onClick={goToQuickActions} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px 8px' }}>{renderBody()}</div>
      {isDone && <ResultFooter getText={getFooterText} onContinueInChat={() => setView('chat')} onRefresh={retry} />}
    </div>
  );
}
