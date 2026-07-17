import { useEffect } from 'react';
import { useStore } from '../store';
import { runExplainRepo, runExplainFile, runSummarizeIssue, runGoodFirstIssues } from '../runActions';
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
const ISSUE_STEPS = [
  'Reading issue description…',
  'Loading discussion comments…',
  'Identifying expected behavior…',
  'Finding relevant files…',
  'Preparing implementation guidance…',
];
const GOOD_FIRST_STEPS = ['Searching open issues…', 'Filtering by label…', 'Preparing list…'];
const DETECTING_ISSUE_STEPS = ['Detecting issue…'];

const ISSUE_OPEN_GRACE_MS = 400;

function formatGoodFirstIssuesAsText(issues: { number: number; title: string; category: string }[]): string {
  return issues.map((i) => `#${i.number} ${i.title} [${i.category}]`).join('\n');
}

function fileStepsFor(fileName: string, fileContent?: string): string[] {
  const lineCount = fileContent ? fileContent.split('\n').length : 0;
  return [
    `Opening ${fileName}…`,
    lineCount > 0 ? `Reading ${lineCount} lines…` : 'Reading file…',
    'Identifying imports and exports…',
    'Understanding main functions…',
    'Tracing related files…',
    'Preparing explanation…',
  ];
}

export function ResultPage() {
  const {
    pageContext,
    activeAction,
    pendingIssueNumber,
    setPendingIssueNumber,
    goToQuickActions,
    setView,
    setActiveAction,
    setOpen,
    repoResult,
    repoLoading,
    repoError,
    fileResult,
    fileQuickResult,
    fileLoading,
    fileError,
    fileStage,
    issueResult,
    issueLoading,
    issueError,
    goodFirstIssuesResult,
    goodFirstIssuesLoading,
    goodFirstIssuesError,
  } = useStore();

  const fileReady = isFileContentReady(pageContext?.fileContent);
  const issueOnPage = pageContext?.page === 'issue';
  const issueTitleReady = issueOnPage && !!pageContext?.issueTitle;
  const pendingMatched = pendingIssueNumber != null && issueOnPage && pageContext?.issueNumber === pendingIssueNumber && issueTitleReady;

  // Clear the "opening issue" transitional state once the target issue has actually
  // rendered — give it a brief grace period so discussion/comments have a moment to
  // finish painting before analysis reads them.
  useEffect(() => {
    if (!pendingMatched) return;
    const t = setTimeout(() => setPendingIssueNumber(null), ISSUE_OPEN_GRACE_MS);
    return () => clearTimeout(t);
    // setPendingIssueNumber is a zustand action — stable across renders, safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMatched]);

  // Auto-detect: once the right kind of page becomes available, kick off analysis
  // automatically — the user should never have to click the quick action again.
  useEffect(() => {
    if (!pageContext) return;

    if (activeAction === 'file' && pageContext.page === 'file' && fileReady && !fileResult && !fileLoading && !fileError) {
      runExplainFile(pageContext);
    }

    if (
      activeAction === 'issue' &&
      pendingIssueNumber == null &&
      issueTitleReady &&
      !issueResult &&
      !issueLoading &&
      !issueError
    ) {
      runSummarizeIssue(pageContext);
    }
  }, [pageContext, activeAction, pendingIssueNumber, fileReady, issueTitleReady, fileResult, fileLoading, fileError, issueResult, issueLoading, issueError]);

  if (!pageContext || !activeAction) return null;

  const handleSelectIssue = (issue: GoodFirstIssueItem) => {
    setPendingIssueNumber(issue.number);
    setActiveAction('issue');
    setView('result');
    setOpen(true);
    navigateToIssue(pageContext.repoOwner, pageContext.repoName, issue.number);
  };

  const renderBody = () => {
    if (activeAction === 'repo') {
      if (repoLoading) return <LoadingTicker steps={REPO_STEPS} />;
      if (repoError) return <ErrorCard message={repoError} onRetry={() => runExplainRepo(pageContext)} />;
      if (repoResult) return <RepoCard data={repoResult} onSelectIssue={handleSelectIssue} />;
      return <LoadingTicker steps={REPO_STEPS} />;
    }

    if (activeAction === 'file') {
      if (pageContext.page !== 'file') return <FileEmptyState />;
      const fileName = pageContext.filePath?.split('/').pop() ?? 'file';
      const fileHeading = `Analyzing ${fileName}`;
      if (!fileReady) {
        // Stage-driven so the label always reflects what's actually happening instead
        // of a generic "Detecting file…" that never changes: the filename (known from
        // the URL alone, before any content exists) shows immediately, and the label
        // only switches to the "waiting on GitHub" message once the direct fetch +
        // DOM observer race is actually underway (see file-detection.ts).
        const label = fileStage === 'waiting_for_content' ? 'Waiting for GitHub to render the file…' : `Opening ${fileName}…`;
        return <LoadingTicker steps={[label]} title={fileHeading} subtitle={pageContext.filePath} />;
      }
      if (fileResult) return <FileCard data={fileResult} />;
      const steps = fileStepsFor(fileName, pageContext.fileContent);
      if (fileLoading)
        return fileQuickResult ? (
          <QuickFilePreview data={fileQuickResult} />
        ) : (
          <LoadingTicker steps={steps} title={fileHeading} subtitle={pageContext.filePath} />
        );
      if (fileError) return <ErrorCard message={fileError} onRetry={() => runExplainFile(pageContext)} />;
      // Content just landed but the explain-file request hasn't started yet (should be
      // near-instant — the auto-detect effect below fires it on the very next render).
      if (fileStage === 'content_extracted') return <LoadingTicker steps={[`Reading ${fileName}…`]} title={fileHeading} subtitle={pageContext.filePath} />;
      return <LoadingTicker steps={steps} title={fileHeading} subtitle={pageContext.filePath} />;
    }

    if (activeAction === 'issue') {
      if (pendingIssueNumber != null && !pendingMatched) {
        return <LoadingTicker steps={[`Opening Issue #${pendingIssueNumber}…`, 'Waiting for page to load…']} />;
      }
      if (pageContext.page !== 'issue') return <IssueEmptyState />;
      const issueHeading = pageContext.issueNumber ? `Analyzing Issue #${pageContext.issueNumber}` : undefined;
      if (!issueTitleReady) return <LoadingTicker steps={DETECTING_ISSUE_STEPS} title={issueHeading} />;
      if (issueLoading) return <LoadingTicker steps={ISSUE_STEPS} title={issueHeading} subtitle={pageContext.issueTitle} />;
      if (issueError) return <ErrorCard message={issueError} onRetry={() => runSummarizeIssue(pageContext)} />;
      if (issueResult) return <IssueCard data={issueResult} />;
      return <LoadingTicker steps={ISSUE_STEPS} title={issueHeading} subtitle={pageContext.issueTitle} />;
    }

    // good-first-issues
    if (goodFirstIssuesLoading) return <LoadingTicker steps={GOOD_FIRST_STEPS} />;
    if (goodFirstIssuesError) return <ErrorCard message={goodFirstIssuesError} onRetry={() => runGoodFirstIssues(pageContext)} />;
    if (goodFirstIssuesResult) {
      return (
        <div>
          <p style={sectionLabel}>Good first issues</p>
          <div style={{ marginTop: 8 }}>
            <GoodFirstIssueList issues={goodFirstIssuesResult} onSelect={handleSelectIssue} />
          </div>
        </div>
      );
    }
    return <LoadingTicker steps={GOOD_FIRST_STEPS} />;
  };

  const getFooterText = (): string => {
    if (activeAction === 'repo' && repoResult) return formatRepoResultAsText(repoResult);
    if (activeAction === 'file' && fileResult) return formatFileResultAsText(fileResult);
    if (activeAction === 'issue' && issueResult) return formatIssueResultAsText(issueResult);
    if (activeAction === 'good-first-issues' && goodFirstIssuesResult) return formatGoodFirstIssuesAsText(goodFirstIssuesResult);
    return '';
  };

  const isDone =
    (activeAction === 'repo' && !!repoResult) ||
    (activeAction === 'file' && !!fileResult) ||
    (activeAction === 'issue' && !!issueResult) ||
    (activeAction === 'good-first-issues' && !!goodFirstIssuesResult);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <BackButton onClick={goToQuickActions} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px 8px' }}>{renderBody()}</div>
      {isDone && <ResultFooter getText={getFooterText} onContinueInChat={() => setView('chat')} />}
    </div>
  );
}
