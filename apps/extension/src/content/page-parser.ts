const NON_REPO_SEGMENTS = new Set([
  'settings',
  'notifications',
  'marketplace',
  'sponsors',
  'issues',
  'pulls',
  'orgs',
  'topics',
  'trending',
  'codespaces',
  'about',
  'features',
  'new',
  'login',
]);

export interface IssuePageInfo {
  isIssuePage: boolean;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueComments: string;

  isRepoPage: boolean;
  isFilePage: boolean;
  filePath: string;
  fileRef: string;
  fileContent: string;
}

export interface FileRouteInfo {
  repoOwner: string;
  repoName: string;
  ref: string;
  filePath: string;
}

/**
 * Resolves a file's identity from the URL alone — no DOM access, so it's available
 * the instant navigation happens, independent of how long GitHub takes to render the
 * page. This is the primary source of truth for "is this a file page and which file."
 */
export function parseFileRouteFromUrl(): FileRouteInfo | null {
  const repoMatch = window.location.pathname.match(/^\/([^/]+)\/([^/]+)(\/|$)/);
  if (!repoMatch || NON_REPO_SEGMENTS.has(repoMatch[1])) return null;
  const [, repoOwner, repoName] = repoMatch;

  const blobMatch = window.location.pathname.match(
    new RegExp(`^/${repoOwner}/${repoName}/blob/([^/]+)/(.+)$`),
  );
  if (!blobMatch) return null;

  return {
    repoOwner,
    repoName,
    ref: blobMatch[1],
    filePath: decodeURIComponent(blobMatch[2]),
  };
}

export interface EmbeddedRefInfo {
  ref: string;
  filePath: string;
}

/**
 * The naive URL split above assumes the ref is exactly one path segment, which is
 * wrong for a branch name containing a slash (e.g. "feature/auth" or "release/v2") —
 * the URL alone is genuinely ambiguous between a multi-segment ref and a nested file
 * path. GitHub itself resolves this server-side and embeds the exact result into the
 * page as JSON (the same data its own React app hydrates from), so that's the only
 * fully reliable source of truth. Validated by reconstructing the blob URL from the
 * embedded ref+path and requiring it to exactly reproduce the current address bar URL
 * — this rejects a stale script tag left over from a previous page during a Turbo
 * transition, and any embedded payload that isn't actually for this route.
 */
export function extractRefAndPathFromEmbeddedData(route: FileRouteInfo): EmbeddedRefInfo | null {
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[data-target="react-app.embeddedData"]');

  let currentPath: string;
  try {
    currentPath = decodeURIComponent(window.location.pathname);
  } catch {
    currentPath = window.location.pathname;
  }

  for (const script of Array.from(scripts)) {
    const text = script.textContent;
    if (!text) continue;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }

    const payload = (json as { payload?: unknown })?.payload as
      | { refInfo?: { name?: unknown }; path?: unknown }
      | undefined;
    const ref = payload?.refInfo?.name;
    const filePath = payload?.path;
    if (typeof ref !== 'string' || typeof filePath !== 'string') continue;

    const reconstructed = `/${route.repoOwner}/${route.repoName}/blob/${ref}/${filePath}`;
    if (currentPath === reconstructed) {
      return { ref, filePath };
    }
  }

  return null;
}

/**
 * Best-available resolution of the current file route: the naive URL-only guess,
 * corrected against GitHub's own embedded page data when it's present. For the
 * overwhelming majority of repos (single-segment branch/tag/SHA refs) the two already
 * agree and this is a no-op; it only changes anything for slash-containing refs.
 */
export function resolveFileRoute(route: FileRouteInfo): FileRouteInfo {
  const embedded = extractRefAndPathFromEmbeddedData(route);
  if (!embedded) return route;
  return { ...route, ref: embedded.ref, filePath: embedded.filePath };
}

/**
 * Last-resort ref resolution for when embedded page data isn't available (GitHub
 * changed its markup, or the payload hasn't rendered yet) and the naive single-segment
 * guess turns out to be wrong. Checks the URL's path segments against the repo's real
 * branch/tag names — fetched via `getRefNames` — preferring the longest match so
 * "release/v2" isn't mistaken for a branch called "release". Returns null if nothing
 * in `knownRefs` matches any prefix of the path, meaning this repo genuinely doesn't
 * have a slash-containing ref here and the naive guess was right all along.
 */
export function resolveRefFromKnownNames(route: FileRouteInfo, knownRefs: string[]): FileRouteInfo | null {
  if (knownRefs.length === 0) return null;
  const refSet = new Set(knownRefs);
  const segments = `${route.ref}/${route.filePath}`.split('/');

  for (let i = segments.length - 1; i >= 1; i--) {
    const candidateRef = segments.slice(0, i).join('/');
    if (refSet.has(candidateRef)) {
      return { ...route, ref: candidateRef, filePath: segments.slice(i).join('/') };
    }
  }
  return null;
}

/** DOM-only extraction of the currently rendered file's content — used as the fallback
 * path when a direct raw-content fetch isn't available/fails. */
export function extractFileContentFromDom(): string {
  const codeEl =
    document.querySelector<HTMLElement>('[data-testid="ai-code-viewer"]') ??
    document.querySelector<HTMLElement>('table.highlight') ??
    document.querySelector<HTMLElement>('.react-code-text') ??
    document.querySelector<HTMLElement>('[itemprop="text"]');
  return codeEl?.textContent?.slice(0, 8000) ?? '';
}

function parseIssueComments(): string {
  const commentEls = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="comment-body"] .markdown-body, .js-comment-container .markdown-body, .timeline-comment .comment-body .markdown-body',
    ),
  );

  // The first matched element is usually the issue body itself (rendered as the
  // opening "comment"); skip it since it's already captured separately.
  const replies = commentEls.slice(1, 6);
  const texts = replies
    .map((el) => el.textContent?.trim())
    .filter((t): t is string => !!t && t.length > 0);

  return texts.join('\n---\n').slice(0, 3000);
}

export function parseGitHubPage(): IssuePageInfo {
  const empty: IssuePageInfo = {
    isIssuePage: false,
    repoOwner: '',
    repoName: '',
    issueNumber: 0,
    issueTitle: '',
    issueBody: '',
    issueComments: '',
    isRepoPage: false,
    isFilePage: false,
    filePath: '',
    fileRef: '',
    fileContent: '',
  };

  const issueMatch = window.location.pathname.match(
    /^\/([^/]+)\/([^/]+)\/issues\/(\d+)/,
  );
  if (issueMatch) {
    const [, repoOwner, repoName, issueNumberStr] = issueMatch;
    const issueNumber = parseInt(issueNumberStr, 10);

    const titleEl =
      document.querySelector<HTMLElement>('[data-testid="issue-title"]') ??
      document.querySelector<HTMLElement>('.js-issue-title') ??
      document.querySelector<HTMLElement>('h1 bdi');
    const issueTitle = titleEl?.textContent?.trim() ?? '';

    const bodyEl =
      document.querySelector<HTMLElement>(
        '[data-testid="issue-body"] .markdown-body',
      ) ??
      document.querySelector<HTMLElement>('.js-issue-body .markdown-body') ??
      document.querySelector<HTMLElement>('#issue-body .markdown-body');
    const issueBody = bodyEl?.textContent?.trim().slice(0, 4000) ?? '';
    const issueComments = parseIssueComments();

    return {
      ...empty,
      isIssuePage: true,
      isRepoPage: true,
      repoOwner,
      repoName,
      issueNumber,
      issueTitle,
      issueBody,
      issueComments,
    };
  }

  const repoMatch = window.location.pathname.match(/^\/([^/]+)\/([^/]+)(\/|$)/);
  if (!repoMatch || NON_REPO_SEGMENTS.has(repoMatch[1])) return empty;

  const [, repoOwner, repoName] = repoMatch;

  const route = parseFileRouteFromUrl();
  if (!route) {
    return { ...empty, isRepoPage: true, repoOwner, repoName };
  }

  return {
    ...empty,
    isRepoPage: true,
    isFilePage: true,
    repoOwner,
    repoName,
    filePath: route.filePath,
    fileRef: route.ref,
    fileContent: extractFileContentFromDom(),
  };
}

export function isFileContentReady(fileContent?: string): boolean {
  return !!fileContent && fileContent.trim().length >= 20;
}

export type RepoVisibility = 'public' | 'private' | 'unknown';

/**
 * Best-effort, local-only check of whether the repository on this page is private, so
 * GitGuide can refuse *before* sending anything (even identifiers) to its server. The
 * server independently verifies every repository is public, so 'unknown' is safe to
 * treat as "ask the server".
 *
 * Signals, in order: GitHub's analytics meta tags (only trusted when they name this
 * exact repository, since GitHub's SPA can leave a previous page's tags behind), then
 * the "Private"/"Internal" label in the repository header.
 */
export function detectRepoVisibility(repoOwner: string, repoName: string): RepoVisibility {
  const nwo = document.querySelector<HTMLMetaElement>('meta[name="octolytics-dimension-repository_nwo"]')?.content;
  const isPublic = document.querySelector<HTMLMetaElement>('meta[name="octolytics-dimension-repository_public"]')?.content;
  if (nwo && nwo.toLowerCase() === `${repoOwner}/${repoName}`.toLowerCase()) {
    if (isPublic === 'false') return 'private';
    if (isPublic === 'true') return 'public';
  }

  const header = document.querySelector('#repository-container-header') ?? document.querySelector('[data-testid="repository-container-header"]');
  if (header) {
    const labels = Array.from(header.querySelectorAll<HTMLElement>('.Label, [class*="Label"]'));
    if (labels.some((label) => /^(private|internal)$/i.test(label.textContent?.trim() ?? ''))) return 'private';
  }
  return 'unknown';
}
