import { IGNORED_DIR_SEGMENTS } from './ignore-list';
import { ApiError } from './errors';
import { getConfig } from './config';
import { TtlLruCache } from './ttl-cache';

const GITHUB_API = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';
const MAX_ATTEMPTS = 2; // one retry, only for network errors and 5xx responses
const RETRY_DELAY_MS = 400;
export const README_MAX_CHARS = 3000;
export const DEFAULT_FILE_MAX_BYTES = 200_000;

// ---------------------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------------------

function apiHeaders(accept = 'application/vnd.github+json'): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitGuide-API',
  };
  const token = getConfig().githubToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** The caller's signal (client disconnect) combined with a per-request deadline. */
function withDeadline(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(getConfig().limits.githubTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rate-limit details from GitHub's headers, or null when the response isn't a limit. */
export function rateLimitRetryAfter(res: Response, nowMs = Date.now()): number | null {
  const retryAfter = Number(res.headers.get('retry-after'));
  const remaining = res.headers.get('x-ratelimit-remaining');
  const hasRetryAfter = Number.isFinite(retryAfter) && retryAfter > 0;
  const isLimited = res.status === 429 || (res.status === 403 && (remaining === '0' || hasRetryAfter));
  if (!isLimited) return null;
  if (hasRetryAfter) return Math.ceil(retryAfter);
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - nowMs / 1000));
  return 60;
}

/** Turns a non-OK GitHub response into a structured error. `notFound` is what a 404
 * means for this particular lookup (repo, ref, file, issue). */
function failureFor(res: Response, notFound: ApiError): ApiError {
  const retryAfter = rateLimitRetryAfter(res);
  if (retryAfter != null) {
    return new ApiError('GITHUB_RATE_LIMITED', 503, 'GitHub is rate-limiting GitGuide right now. Please try again later.', retryAfter);
  }
  if (res.status === 404 || res.status === 410 || res.status === 451) return notFound;
  if (res.status === 401) {
    console.error(JSON.stringify({ level: 'error', msg: 'github_auth_failed', hint: 'GITHUB_TOKEN is invalid or expired' }));
    return new ApiError('GITHUB_UNAVAILABLE', 502, 'GitGuide could not authenticate with GitHub. Please try again later.');
  }
  if (res.status === 403) {
    return new ApiError('REPO_NOT_FOUND', 404, 'GitHub denied access to this repository. GitGuide supports public repositories only.');
  }
  return new ApiError('GITHUB_UNAVAILABLE', 502, 'GitHub returned an unexpected error. Please try again shortly.');
}

/** fetch with a deadline and one retry for transient failures (network errors and 5xx).
 * Never retries 4xx (including rate limits — their reset time is surfaced instead) and
 * never retries once the caller has gone away. */
async function githubFetch(url: string, init: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    try {
      const res = await fetch(url, { headers: init.headers, signal: withDeadline(init.signal) });
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        await res.body?.cancel();
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (init.signal?.aborted) throw err;
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      if (isTimeout || attempt >= MAX_ATTEMPTS) break;
      await sleep(RETRY_DELAY_MS);
    }
  }
  if (lastError instanceof Error && lastError.name === 'TimeoutError') {
    throw new ApiError('UPSTREAM_TIMEOUT', 504, 'GitHub took too long to respond. Please try again.');
  }
  throw new ApiError('GITHUB_UNAVAILABLE', 502, 'GitGuide could not reach GitHub. Please try again shortly.');
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function repoPath(owner: string, repo: string): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

const repoNotFound = () =>
  new ApiError('REPO_NOT_FOUND', 404, 'Repository not found. GitGuide supports public GitHub repositories only.');

// ---------------------------------------------------------------------------------------
// Repository + ref → immutable commit snapshot
// ---------------------------------------------------------------------------------------

export interface RepoInfo {
  description: string | null;
  defaultBranch: string;
  language: string | null;
  topics: string[];
}

const repoInfoCache = new TtlLruCache<RepoInfo>(200, 5 * 60_000);
const refShaCache = new TtlLruCache<string>(500, 60_000);

/** Repository metadata. Throws unless the repository is public: GitGuide's release
 * policy is public-repositories-only, and a configured GITHUB_TOKEN might otherwise let
 * any caller read repositories that token can see privately. */
export async function getRepoInfo(owner: string, repo: string, signal?: AbortSignal): Promise<RepoInfo> {
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = repoInfoCache.get(key);
  if (cached) return cached;

  const res = await githubFetch(`${GITHUB_API}/repos/${repoPath(owner, repo)}`, { headers: apiHeaders(), signal });
  if (!res.ok) throw failureFor(res, repoNotFound());
  const data: any = await res.json();
  if (data?.private !== false || (data.visibility != null && data.visibility !== 'public')) {
    throw new ApiError('PRIVATE_REPO_UNSUPPORTED', 403, 'GitGuide supports public repositories only.');
  }
  const info: RepoInfo = {
    description: typeof data.description === 'string' ? data.description : null,
    defaultBranch: typeof data.default_branch === 'string' && data.default_branch ? data.default_branch : 'main',
    language: typeof data.language === 'string' ? data.language : null,
    topics: Array.isArray(data.topics) ? data.topics.filter((t: unknown) => typeof t === 'string') : [],
  };
  repoInfoCache.set(key, info);
  return info;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** Resolves a branch, tag (lightweight or annotated — peeled to its commit), or full/short
 * commit SHA to the immutable 40-character commit SHA it currently points to. */
export async function resolveCommitSha(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<string> {
  const key = `${owner}/${repo}@${ref}`.toLowerCase();
  const cached = refShaCache.get(key);
  if (cached) return cached;

  const res = await githubFetch(`${GITHUB_API}/repos/${repoPath(owner, repo)}/commits/${encodeURIComponent(ref)}`, {
    headers: apiHeaders('application/vnd.github.sha'),
    signal,
  });
  const refNotFound = new ApiError('REF_NOT_FOUND', 404, `The branch, tag, or commit "${ref}" was not found in this repository.`);
  // 422 is GitHub's answer for "No commit found for SHA: <ref>".
  if (res.status === 422) throw refNotFound;
  if (!res.ok) throw failureFor(res, refNotFound);
  const sha = (await res.text()).trim();
  if (!FULL_SHA_RE.test(sha)) {
    throw new ApiError('GITHUB_UNAVAILABLE', 502, 'GitHub returned an unexpected commit identifier.');
  }
  // A full SHA can never move; branch/tag names can, so they're re-resolved after a minute.
  refShaCache.set(key, sha.toLowerCase(), FULL_SHA_RE.test(ref) ? 24 * 60 * 60_000 : 60_000);
  return sha.toLowerCase();
}

export interface RepoSnapshot {
  owner: string;
  repo: string;
  repoInfo: RepoInfo;
  /** The ref the user asked about (or the default branch), for display. */
  ref: string;
  /** Immutable commit everything in this request is read from. */
  commitSha: string;
}

export async function resolveSnapshot(owner: string, repo: string, ref: string | undefined, signal?: AbortSignal): Promise<RepoSnapshot> {
  const repoInfo = await getRepoInfo(owner, repo, signal);
  const effectiveRef = ref ?? repoInfo.defaultBranch;
  const commitSha = await resolveCommitSha(owner, repo, effectiveRef, signal);
  return { owner, repo, repoInfo, ref: effectiveRef, commitSha };
}

// ---------------------------------------------------------------------------------------
// Content at a commit
// ---------------------------------------------------------------------------------------

export interface TreeFile {
  path: string;
  size: number;
}

export interface RepoTree {
  /** Blobs outside ignored directories (node_modules, dist, …), in GitHub's order. */
  files: TreeFile[];
  /** GitHub stopped listing entries (very large repositories): `files` is incomplete. */
  truncated: boolean;
}

const treeCache = new TtlLruCache<RepoTree>(20, 30 * 60_000);

export async function getTree(owner: string, repo: string, commitSha: string, signal?: AbortSignal): Promise<RepoTree> {
  const key = `${owner}/${repo}@${commitSha}`.toLowerCase();
  const cached = treeCache.get(key);
  if (cached) return cached;

  const res = await githubFetch(`${GITHUB_API}/repos/${repoPath(owner, repo)}/git/trees/${commitSha}?recursive=1`, {
    headers: apiHeaders(),
    signal,
  });
  if (!res.ok) throw failureFor(res, new ApiError('REF_NOT_FOUND', 404, 'The requested commit was not found.'));
  const data: any = await res.json();
  if (!Array.isArray(data?.tree)) throw new ApiError('GITHUB_UNAVAILABLE', 502, 'GitHub returned an unexpected file tree.');

  const files: TreeFile[] = data.tree
    .filter((entry: any) => entry?.type === 'blob' && typeof entry.path === 'string')
    .filter((entry: any) => !entry.path.split('/').some((seg: string) => IGNORED_DIR_SEGMENTS.has(seg)))
    .map((entry: any) => ({ path: entry.path as string, size: typeof entry.size === 'number' ? entry.size : 0 }));
  const tree: RepoTree = { files, truncated: data.truncated === true };
  treeCache.set(key, tree);
  return tree;
}

export interface ReadmeResult {
  text: string;
  truncated: boolean;
}

/** README at an exact commit. A repository without a README is a normal, empty result;
 * any other failure (rate limit, outage) is an error rather than a silent empty string. */
export async function getReadme(owner: string, repo: string, commitSha: string, signal?: AbortSignal): Promise<ReadmeResult> {
  const res = await githubFetch(`${GITHUB_API}/repos/${repoPath(owner, repo)}/readme?ref=${encodeURIComponent(commitSha)}`, {
    headers: apiHeaders(),
    signal,
  });
  if (res.status === 404) return { text: '', truncated: false };
  if (!res.ok) throw failureFor(res, repoNotFound());
  const data: any = await res.json();
  if (typeof data?.content !== 'string') return { text: '', truncated: false };
  const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
  return { text: decoded.slice(0, README_MAX_CHARS), truncated: decoded.length > README_MAX_CHARS };
}

export interface FileContent {
  content: string;
  /** Download stopped at maxBytes; `content` is only the beginning of the file. */
  truncated: boolean;
  /** Bytes actually read. */
  bytesRead: number;
}

const fileCache = new TtlLruCache<FileContent>(100, 30 * 60_000);

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8000);
  return sample.includes(0);
}

/** Reads at most `maxBytes` of a response body, cancelling the rest of the download. */
async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      parts.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    parts.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, truncated };
}

/** A file's text at an immutable commit. Never returns '' for a failure: 404 is
 * FILE_NOT_FOUND, binary content is FILE_NOT_TEXT, and everything else is an error. */
export async function getFileAtCommit(
  owner: string,
  repo: string,
  commitSha: string,
  path: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<FileContent> {
  const maxBytes = options.maxBytes ?? DEFAULT_FILE_MAX_BYTES;
  const key = `${owner}/${repo}@${commitSha}:${path}:${maxBytes}`;
  const cached = fileCache.get(key);
  if (cached) return cached;

  // Raw content is served without API quota; authentication isn't needed (public only).
  const res = await githubFetch(`${RAW_HOST}/${repoPath(owner, repo)}/${commitSha}/${encodePath(path)}`, {
    headers: { 'User-Agent': 'GitGuide-API' },
    signal: options.signal,
  });
  if (!res.ok) {
    throw failureFor(res, new ApiError('FILE_NOT_FOUND', 404, `"${path}" was not found at this commit.`));
  }
  const { bytes, truncated } = await readCapped(res, maxBytes);
  if (looksBinary(bytes)) {
    throw new ApiError('FILE_NOT_TEXT', 422, `"${path}" looks like a binary file, which GitGuide can't explain.`);
  }
  // A cut in the middle of a multi-byte character decodes to U+FFFD; harmless here.
  const result: FileContent = { content: new TextDecoder().decode(bytes), truncated, bytesRead: bytes.byteLength };
  fileCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------

export interface GoodFirstIssue {
  number: number;
  title: string;
  labels: string[];
  category: 'good first issue' | 'help wanted';
  comments: number;
}

export async function getGoodFirstIssues(owner: string, repo: string, signal?: AbortSignal): Promise<GoodFirstIssue[]> {
  const query = `repo:${owner}/${repo} is:issue is:open label:"good first issue","help wanted"`;
  const res = await githubFetch(
    `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&sort=comments&order=desc&per_page=10`,
    { headers: apiHeaders(), signal },
  );
  // Search answers 422 when the repository doesn't exist or isn't searchable.
  if (res.status === 422) throw repoNotFound();
  if (!res.ok) throw failureFor(res, repoNotFound());
  const data: any = await res.json();
  if (!Array.isArray(data?.items)) throw new ApiError('GITHUB_UNAVAILABLE', 502, 'GitHub returned an unexpected search result.');

  return data.items.map((item: any) => {
    const labels: string[] = (item.labels ?? []).map((l: any) => String(l?.name ?? '')).filter(Boolean);
    const isGoodFirst = labels.some((l) => l.toLowerCase().includes('good first issue'));
    return {
      number: Number(item.number),
      title: String(item.title ?? ''),
      labels,
      category: isGoodFirst ? 'good first issue' : 'help wanted',
      comments: Number(item.comments ?? 0),
    };
  });
}

export interface IssueDetails {
  number: number;
  title: string;
  body: string;
  state: string;
  updatedAt: string;
  isPullRequest: boolean;
  commentsTotal: number;
  comments: { author: string; body: string }[];
}

const ISSUE_BODY_MAX_CHARS = 8000;
const COMMENT_MAX_CHARS = 1500;
const MAX_COMMENTS = 12;

/** The issue and a bounded selection of its discussion (the first few comments plus the
 * most recent ones), read from GitHub rather than from the user's page. */
export async function getIssue(owner: string, repo: string, issueNumber: number, signal?: AbortSignal): Promise<IssueDetails> {
  const notFound = new ApiError('ISSUE_NOT_FOUND', 404, `Issue #${issueNumber} was not found in this repository.`);
  const res = await githubFetch(`${GITHUB_API}/repos/${repoPath(owner, repo)}/issues/${issueNumber}`, { headers: apiHeaders(), signal });
  if (!res.ok) throw failureFor(res, notFound);
  const issue: any = await res.json();

  const commentsTotal = Number(issue.comments ?? 0);
  let comments: { author: string; body: string }[] = [];
  if (commentsTotal > 0) {
    const fetchPage = async (page: number): Promise<any[]> => {
      const commentsRes = await githubFetch(
        `${GITHUB_API}/repos/${repoPath(owner, repo)}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
        { headers: apiHeaders(), signal },
      );
      if (!commentsRes.ok) throw failureFor(commentsRes, notFound);
      const data: unknown = await commentsRes.json();
      return Array.isArray(data) ? data : [];
    };
    const lastPage = Math.ceil(commentsTotal / 100);
    // Long threads: the first page holds the opening discussion, the last page the latest.
    const all = lastPage > 1 ? [...(await fetchPage(1)), ...(await fetchPage(lastPage))] : await fetchPage(1);
    const picked = all.length > MAX_COMMENTS ? [...all.slice(0, 4), ...all.slice(-(MAX_COMMENTS - 4))] : all;
    comments = picked.map((c) => ({
      author: String(c?.user?.login ?? 'unknown'),
      body: String(c?.body ?? '').slice(0, COMMENT_MAX_CHARS),
    }));
  }

  return {
    number: issueNumber,
    title: String(issue.title ?? ''),
    body: String(issue.body ?? '').slice(0, ISSUE_BODY_MAX_CHARS),
    state: String(issue.state ?? 'unknown'),
    updatedAt: String(issue.updated_at ?? ''),
    isPullRequest: issue.pull_request != null,
    commentsTotal,
    comments,
  };
}

/** Clears module caches; tests only. */
export function clearGitHubCachesForTests(): void {
  repoInfoCache.clear();
  refShaCache.clear();
  treeCache.clear();
  fileCache.clear();
}
