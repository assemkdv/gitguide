// Runs the four Quick Actions. Every request is *owned*: it records the exact target it
// was started for (repository, ref, path, or issue) and may only touch the store while it
// is still the latest request for that action AND that target is still what the page
// shows. That rule covers every asynchronous step — cache reads, success, failure, and
// cleanup — so a slow response for page A can never write a result, an error, or a
// "not loading" flag into page B. Obsolete requests are aborted (the server stops work
// too), and starting the same target twice reuses the in-flight request.
import { useStore, CardType, PageContext, UiError } from './store';
import { cacheKeys, fingerprint, loadCached, saveCached, REPO_CACHE_TTL_MS, TARGET_CACHE_TTL_MS } from './storage';
import { ApiClientError, postJson, toUiError } from './api-client';
import {
  normalizeAnalysis,
  normalizeFileQuickResult,
  normalizeFileResult,
  normalizeGoodFirstIssues,
  normalizeRepoResult,
} from './validate';
import { detectRepoVisibility } from '../content/page-parser';
import { devLog } from './dev-log';
import { isObject } from './validate';

type Kind = CardType;

interface OwnedRequest {
  id: number;
  target: string;
  controller: AbortController;
  promise: Promise<void>;
}

const inFlight = new Map<Kind, OwnedRequest>();
let nextRequestId = 0;

/** Complete identity of what an action is about on the given page, or null when the
 * page doesn't (yet) have a target for that action. */
export function targetOf(kind: Kind, ctx: PageContext | null): string | null {
  if (!ctx) return null;
  const repo = `${ctx.repoOwner}/${ctx.repoName}`.toLowerCase();
  switch (kind) {
    case 'repo':
      return `repo:${repo}`;
    case 'good-first-issues':
      return `gfi:${repo}`;
    case 'file':
      return ctx.page === 'file' && ctx.filePath && ctx.fileRef ? `file:${repo}@${ctx.fileRef}:${ctx.filePath}` : null;
    case 'issue':
      return ctx.page === 'issue' && ctx.issueNumber ? `issue:${repo}#${ctx.issueNumber}` : null;
  }
}

const currentTarget = (kind: Kind) => targetOf(kind, useStore.getState().pageContext);

/** True while `req` is both the newest request for its action and still about the page
 * the user is looking at. */
function owns(kind: Kind, req: OwnedRequest): boolean {
  return inFlight.get(kind)?.id === req.id && currentTarget(kind) === req.target;
}

type Patch = Partial<ReturnType<typeof useStore.getState>>;
const loadingField: Record<Kind, keyof Patch> = {
  repo: 'repoLoading',
  file: 'fileLoading',
  issue: 'issueLoading',
  'good-first-issues': 'goodFirstIssuesLoading',
};
const errorField: Record<Kind, keyof Patch> = {
  repo: 'repoError',
  file: 'fileError',
  issue: 'issueError',
  'good-first-issues': 'goodFirstIssuesError',
};

function setLoading(kind: Kind, value: boolean) {
  useStore.setState({ [loadingField[kind]]: value } as Patch);
}
function setError(kind: Kind, error: UiError | null) {
  useStore.setState({ [errorField[kind]]: error } as Patch);
}

/** Aborts requests whose target is no longer on the page and clears their loading flag.
 * Runs automatically whenever the page context changes (see subscription below). */
export function abortObsoleteRequests(): void {
  for (const [kind, req] of inFlight) {
    if (currentTarget(kind) !== req.target) {
      inFlight.delete(kind);
      req.controller.abort();
      setLoading(kind, false);
    }
  }
}

useStore.subscribe((state, prev) => {
  if (state.pageContext !== prev.pageContext) abortObsoleteRequests();
});

/** For tests and full resets. */
export function abortAllRequests(): void {
  for (const [kind, req] of inFlight) {
    inFlight.delete(kind);
    req.controller.abort();
    setLoading(kind, false);
  }
}

const PUBLIC_ONLY_ERROR: UiError = {
  code: 'PRIVATE_REPO_UNSUPPORTED',
  retryable: false,
  message: 'GitGuide works with public GitHub repositories only, so it has not sent anything about this private repository.',
};

interface RunSpec {
  kind: Kind;
  ctx: PageContext;
  force: boolean;
  /** Reads a cached result; null = miss. */
  readCache: () => Promise<boolean>;
  /** Performs the network request and applies the result. */
  fetchAndApply: (req: OwnedRequest) => Promise<void>;
}

function run(spec: RunSpec): Promise<void> {
  const { kind, ctx, force } = spec;
  const state = useStore.getState();
  // Defense in depth: the UI routes users through the data notice first.
  if (!state.consentAccepted) return Promise.resolve();

  const target = targetOf(kind, ctx);
  if (!target || target !== currentTarget(kind)) return Promise.resolve();

  const existing = inFlight.get(kind);
  if (existing && existing.target === target && !force) return existing.promise; // no duplicate requests
  existing?.controller.abort();
  inFlight.delete(kind);

  if (detectRepoVisibility(ctx.repoOwner, ctx.repoName) === 'private') {
    setLoading(kind, false);
    setError(kind, PUBLIC_ONLY_ERROR);
    return Promise.resolve();
  }

  const req: OwnedRequest = { id: ++nextRequestId, target, controller: new AbortController(), promise: Promise.resolve() };
  inFlight.set(kind, req);
  setLoading(kind, true);
  setError(kind, null);

  req.promise = (async () => {
    try {
      if (!force) {
        const hit = await spec.readCache();
        if (hit) return;
        if (!owns(kind, req)) return;
      }
      await spec.fetchAndApply(req);
    } catch (err) {
      if (req.controller.signal.aborted || !owns(kind, req)) return;
      setError(kind, toUiError(err));
    } finally {
      // Only the owning request may clear the loading flag; an obsolete one was already
      // removed (and its flag reset) by abortObsoleteRequests or a newer run.
      if (inFlight.get(kind) === req) {
        inFlight.delete(kind);
        setLoading(kind, false);
      }
    }
  })();
  return req.promise;
}

function openResult(kind: Kind) {
  useStore.setState({ activeAction: kind, view: 'result' });
}

// ---------------------------------------------------------------------------------------

export function runExplainRepo(ctx: PageContext, options: { force?: boolean } = {}): Promise<void> {
  openResult('repo');
  const s = useStore.getState();
  const target = targetOf('repo', ctx);
  if (!options.force && s.repoResult && s.repoResultTarget === target) return Promise.resolve();
  const key = cacheKeys.repo(ctx.repoOwner, ctx.repoName);

  return run({
    kind: 'repo',
    ctx,
    force: !!options.force,
    readCache: async () => {
      const cached = await loadCached(key, normalizeRepoResult);
      if (cached && currentTarget('repo') === target && inFlight.get('repo')?.target === target) {
        useStore.setState({ repoResult: cached, repoResultTarget: target });
        return true;
      }
      return false;
    },
    fetchAndApply: async (req) => {
      const raw = await postJson('/v1/explain-repo', { repoOwner: ctx.repoOwner, repoName: ctx.repoName }, req.controller.signal);
      const data = normalizeRepoResult(raw);
      if (!data) throw badResponse();
      if (!owns('repo', req)) return;
      useStore.setState({ repoResult: data, repoResultTarget: req.target });
      await saveCached(key, data, REPO_CACHE_TTL_MS);
    },
  });
}

function fileFingerprint(ctx: PageContext): string | null {
  return ctx.fileContent ? fingerprint(ctx.fileContent) : null;
}

export function runExplainFile(ctx: PageContext, options: { force?: boolean } = {}): Promise<void> {
  openResult('file');
  const s = useStore.getState();
  const target = targetOf('file', ctx);
  if (!options.force && s.fileResult && s.fileResultTarget === target) return Promise.resolve();
  // Not on a file page, or the file hasn't finished loading: ResultPage shows guidance
  // and re-invokes this once the page is ready.
  if (!target || !ctx.fileContent || ctx.fileContent.trim().length < 20) return Promise.resolve();

  const navStart = s.fileNavStartedAt;
  if (navStart != null) devLog(`explanation request started at ${Math.round(performance.now() - navStart)}ms`);

  const ref = ctx.fileRef as string;
  const path = ctx.filePath as string;
  const key = cacheKeys.file(ctx.repoOwner, ctx.repoName, ref, path);
  const contentHash = fileFingerprint(ctx);
  const body = { repoOwner: ctx.repoOwner, repoName: ctx.repoName, ref, filePath: path };

  return run({
    kind: 'file',
    ctx,
    force: !!options.force,
    readCache: async () => {
      useStore.setState({ fileQuickResult: null, fileStage: 'request_started' });
      const cached = await loadCached(key, normalizeFileResult, contentHash);
      if (cached && currentTarget('file') === target && inFlight.get('file')?.target === target) {
        useStore.setState({ fileResult: cached, fileResultTarget: target, fileStage: 'complete' });
        return true;
      }
      return false;
    },
    fetchAndApply: async (req) => {
      useStore.setState({ fileQuickResult: null, fileStage: 'request_started' });
      // Fast, low-detail pass in parallel so there is something to read within a second
      // or two. Same ownership rule: it never lands on another file, ref, or repository,
      // and never replaces a full result.
      postJson('/v1/explain-file/quick', body, req.controller.signal)
        .then((raw) => {
          const quick = normalizeFileQuickResult(raw);
          if (quick && owns('file', req) && !useStore.getState().fileResult) useStore.setState({ fileQuickResult: quick });
        })
        .catch(() => {
          // The quick pass is optional; the full request reports errors.
        });

      const raw = await postJson('/v1/explain-file', body, req.controller.signal);
      const data = normalizeFileResult(raw);
      if (!data) throw badResponse();
      if (!owns('file', req)) return;
      useStore.setState({ fileResult: data, fileResultTarget: req.target, fileQuickResult: null, fileStage: 'complete' });
      await saveCached(key, data, TARGET_CACHE_TTL_MS, contentHash);
    },
  });
}

function issueFingerprint(ctx: PageContext): string | null {
  if (!ctx.issueTitle) return null;
  return fingerprint(`${ctx.issueTitle}\n${ctx.issueBody ?? ''}\n${ctx.issueComments ?? ''}`);
}

export function runSummarizeIssue(ctx: PageContext, options: { force?: boolean } = {}): Promise<void> {
  openResult('issue');
  const s = useStore.getState();
  const target = targetOf('issue', ctx);
  if (!options.force && s.issueResult && s.issueResultTarget === target) return Promise.resolve();
  if (!target || !ctx.issueNumber || !ctx.issueTitle) return Promise.resolve();

  const issueNumber = ctx.issueNumber;
  const key = cacheKeys.issue(ctx.repoOwner, ctx.repoName, issueNumber);
  const contentHash = issueFingerprint(ctx);

  return run({
    kind: 'issue',
    ctx,
    force: !!options.force,
    readCache: async () => {
      const cached = await loadCached(key, normalizeAnalysis, contentHash);
      if (cached && currentTarget('issue') === target && inFlight.get('issue')?.target === target) {
        useStore.setState({ issueResult: cached, issueResultTarget: target });
        return true;
      }
      return false;
    },
    fetchAndApply: async (req) => {
      // Only identifiers are sent; the server reads the issue and comments from GitHub.
      const raw = await postJson('/v1/analyze', { repoOwner: ctx.repoOwner, repoName: ctx.repoName, issueNumber }, req.controller.signal);
      const data = normalizeAnalysis(raw);
      if (!data) throw badResponse();
      if (!owns('issue', req)) return;
      useStore.setState({ issueResult: data, issueResultTarget: req.target });
      await saveCached(key, data, TARGET_CACHE_TTL_MS, contentHash);
    },
  });
}

export function runGoodFirstIssues(ctx: PageContext, options: { force?: boolean } = {}): Promise<void> {
  openResult('good-first-issues');
  const s = useStore.getState();
  const target = targetOf('good-first-issues', ctx);
  if (!options.force && s.goodFirstIssuesResult && s.goodFirstIssuesResultTarget === target) return Promise.resolve();
  const key = cacheKeys.goodFirstIssues(ctx.repoOwner, ctx.repoName);

  return run({
    kind: 'good-first-issues',
    ctx,
    force: !!options.force,
    readCache: async () => {
      const cached = await loadCached(key, normalizeGoodFirstIssues);
      if (cached && currentTarget('good-first-issues') === target && inFlight.get('good-first-issues')?.target === target) {
        useStore.setState({ goodFirstIssuesResult: cached, goodFirstIssuesResultTarget: target });
        return true;
      }
      return false;
    },
    fetchAndApply: async (req) => {
      const raw = await postJson('/v1/good-first-issues', { repoOwner: ctx.repoOwner, repoName: ctx.repoName }, req.controller.signal);
      const data = isObject(raw) ? normalizeGoodFirstIssues(raw.goodFirstIssues) : null;
      if (!data) throw badResponse();
      if (!owns('good-first-issues', req)) return;
      useStore.setState({ goodFirstIssuesResult: data, goodFirstIssuesResultTarget: req.target });
      await saveCached(key, data, REPO_CACHE_TTL_MS);
    },
  });
}

function badResponse() {
  return new ApiClientError('BAD_RESPONSE', 'Unexpected response shape');
}

export const runAction: Record<CardType, (ctx: PageContext, options?: { force?: boolean }) => Promise<void>> = {
  repo: runExplainRepo,
  file: runExplainFile,
  issue: runSummarizeIssue,
  'good-first-issues': runGoodFirstIssues,
};
