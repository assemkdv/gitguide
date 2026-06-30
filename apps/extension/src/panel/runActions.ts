import { useStore, PageContext, repoKeyOf } from './store';
import {
  loadRepoCache,
  saveRepoCache,
  loadFileCache,
  saveFileCache,
  loadIssueCache,
  saveIssueCache,
  loadGoodFirstIssuesCache,
  saveGoodFirstIssuesCache,
} from './storage';
import { devLog } from './dev-log';
import { API_BASE_URL } from '../config';

const NETWORK_ERROR = 'Could not reach the GitGuide API.';

export async function runExplainRepo(ctx: PageContext): Promise<void> {
  const repoKey = repoKeyOf(ctx.repoOwner, ctx.repoName);
  const { setActiveAction, setView, setRepoResult, setRepoLoading, setRepoError } = useStore.getState();

  setActiveAction('repo');
  setView('result');
  if (useStore.getState().repoResult) return;

  setRepoLoading(true);
  setRepoError(null);
  try {
    const cached = await loadRepoCache(repoKey);
    if (cached) {
      setRepoResult(cached);
      return;
    }
    const res = await fetch(`${API_BASE_URL}/v1/explain-repo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoOwner: ctx.repoOwner, repoName: ctx.repoName }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    setRepoResult(data);
    await saveRepoCache(repoKey, data);
  } catch {
    setRepoError(NETWORK_ERROR);
  } finally {
    setRepoLoading(false);
  }
}

export async function runExplainFile(ctx: PageContext): Promise<void> {
  const repoKey = repoKeyOf(ctx.repoOwner, ctx.repoName);
  const { setActiveAction, setView, setFileResult, setFileQuickResult, setFileLoading, setFileError, setFileStage } =
    useStore.getState();

  setActiveAction('file');
  setView('result');
  if (useStore.getState().fileResult) return;

  // Not on a file page (or the file hasn't finished rendering yet) — this isn't an
  // error, ResultPage shows friendly guidance and re-invokes this once the page is ready.
  if (!ctx.filePath || !ctx.fileContent || ctx.fileContent.trim().length < 20) {
    return;
  }

  const navStart = useStore.getState().fileNavStartedAt;
  if (navStart != null) {
    devLog(`explanation request started at ${Math.round(performance.now() - navStart)}ms`);
  }
  setFileStage('request_started');

  const fileRef = ctx.fileRef ?? 'HEAD';

  setFileQuickResult(null);
  setFileLoading(true);
  setFileError(null);
  try {
    const cached = await loadFileCache(repoKey, fileRef, ctx.filePath);
    if (cached) {
      setFileResult(cached);
      setFileStage('complete');
      return;
    }

    // Kick off a fast, low-detail pass in parallel — a small/fast model gives the user
    // something to read within a second or two while the full detailed pass below
    // (larger model, more tokens) keeps running. Guarded so a slow/failed quick pass
    // can never clobber a full result that already landed or apply to a file the user
    // has since navigated away from.
    fetch(`${API_BASE_URL}/v1/explain-file/quick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoOwner: ctx.repoOwner, repoName: ctx.repoName, filePath: ctx.filePath, fileContent: ctx.fileContent }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((quick) => {
        const s = useStore.getState();
        if (quick && s.pageContext?.page === 'file' && s.pageContext.filePath === ctx.filePath && !s.fileResult) {
          setFileQuickResult(quick);
        }
      })
      .catch(() => {});

    const res = await fetch(`${API_BASE_URL}/v1/explain-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoOwner: ctx.repoOwner, repoName: ctx.repoName, filePath: ctx.filePath, fileContent: ctx.fileContent }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    setFileResult(data);
    setFileQuickResult(null);
    setFileStage('complete');
    await saveFileCache(repoKey, fileRef, ctx.filePath, data);
  } catch {
    setFileError(NETWORK_ERROR);
  } finally {
    setFileLoading(false);
  }
}

export async function runSummarizeIssue(ctx: PageContext): Promise<void> {
  const repoKey = repoKeyOf(ctx.repoOwner, ctx.repoName);
  const { setActiveAction, setView, setIssueResult, setIssueLoading, setIssueError } = useStore.getState();

  setActiveAction('issue');
  setView('result');
  if (useStore.getState().issueResult) return;

  // Not on an issue page (or it hasn't finished rendering yet) — this isn't an error,
  // ResultPage shows friendly guidance and re-invokes this once the page is ready.
  if (!ctx.issueNumber || !ctx.issueTitle) {
    return;
  }

  setIssueLoading(true);
  setIssueError(null);
  try {
    const cached = await loadIssueCache(repoKey, ctx.issueNumber);
    if (cached) {
      setIssueResult(cached);
      return;
    }
    const res = await fetch(`${API_BASE_URL}/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoOwner: ctx.repoOwner,
        repoName: ctx.repoName,
        issueNumber: ctx.issueNumber,
        issueTitle: ctx.issueTitle,
        issueBody: ctx.issueBody,
        issueComments: ctx.issueComments,
      }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    setIssueResult(data);
    await saveIssueCache(repoKey, ctx.issueNumber, data);
  } catch {
    setIssueError(NETWORK_ERROR);
  } finally {
    setIssueLoading(false);
  }
}

export async function runGoodFirstIssues(ctx: PageContext): Promise<void> {
  const repoKey = repoKeyOf(ctx.repoOwner, ctx.repoName);
  const { setActiveAction, setView, setGoodFirstIssuesResult, setGoodFirstIssuesLoading, setGoodFirstIssuesError } =
    useStore.getState();

  setActiveAction('good-first-issues');
  setView('result');
  if (useStore.getState().goodFirstIssuesResult) return;

  setGoodFirstIssuesLoading(true);
  setGoodFirstIssuesError(null);
  try {
    const cached = await loadGoodFirstIssuesCache(repoKey);
    if (cached) {
      setGoodFirstIssuesResult(cached);
      return;
    }
    const res = await fetch(`${API_BASE_URL}/v1/good-first-issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoOwner: ctx.repoOwner, repoName: ctx.repoName }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    setGoodFirstIssuesResult(data.goodFirstIssues);
    await saveGoodFirstIssuesCache(repoKey, data.goodFirstIssues);
  } catch {
    setGoodFirstIssuesError(NETWORK_ERROR);
  } finally {
    setGoodFirstIssuesLoading(false);
  }
}
