import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearGitHubCachesForTests,
  getFileAtCommit,
  getGoodFirstIssues,
  getIssue,
  getReadme,
  getRepoInfo,
  getTree,
  rateLimitRetryAfter,
  resolveCommitSha,
  resolveSnapshot,
} from './github';
import { ApiError } from './errors';

const SHA = 'a'.repeat(40);

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

async function expectApiError(promise: Promise<unknown>, code: string): Promise<ApiError> {
  const err = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
  return err as ApiError;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  clearGitHubCachesForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('resolveCommitSha — every supported ref kind resolves to an immutable commit', () => {
  it('uses the commits endpoint with the SHA media type (peels annotated tags to their commit)', async () => {
    fetchMock.mockResolvedValue(textResponse(`${SHA}\n`));
    await expect(resolveCommitSha('git', 'git', 'v2.0.0')).resolves.toBe(SHA);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/git/git/commits/v2.0.0');
    expect((init?.headers as Record<string, string>).Accept).toBe('application/vnd.github.sha');
  });

  it('encodes slash-containing branch names as a single path parameter', async () => {
    fetchMock.mockResolvedValue(textResponse(SHA));
    await resolveCommitSha('owner', 'repo', 'release/v2');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/commits/release%2Fv2');
  });

  it('accepts short SHAs and returns the full lower-case SHA', async () => {
    fetchMock.mockResolvedValue(textResponse('ABCDEF' + 'a'.repeat(34)));
    await expect(resolveCommitSha('owner', 'repo', 'abcdef1')).resolves.toBe('abcdef' + 'a'.repeat(34));
  });

  it.each([404, 422])('maps a missing ref (HTTP %s) to REF_NOT_FOUND', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'No commit found for SHA: nope' }, { status }));
    await expectApiError(resolveCommitSha('owner', 'repo', 'nope'), 'REF_NOT_FOUND');
  });

  it('reports a GitHub rate limit with the reset time instead of a generic failure', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    fetchMock.mockResolvedValue(
      jsonResponse({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }),
    );
    const err = await expectApiError(resolveCommitSha('owner', 'repo', 'main'), 'GITHUB_RATE_LIMITED');
    expect(err.retryAfterSec).toBeGreaterThan(100);
    expect(err.retryAfterSec).toBeLessThanOrEqual(121);
  });

  it('rejects a response that is not a commit SHA', async () => {
    fetchMock.mockResolvedValue(textResponse('<html>oops</html>'));
    await expectApiError(resolveCommitSha('owner', 'repo', 'main'), 'GITHUB_UNAVAILABLE');
  });

  it('re-resolves a branch name after the cache window (a branch can move), but caches within it', async () => {
    fetchMock.mockResolvedValue(textResponse(SHA));
    await resolveCommitSha('owner', 'repo', 'main');
    await resolveCommitSha('owner', 'repo', 'main');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getRepoInfo — public repositories only', () => {
  it('returns metadata for a public repository', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ private: false, visibility: 'public', default_branch: 'trunk', description: 'd', language: 'Go', topics: ['x'] }));
    await expect(getRepoInfo('o', 'r')).resolves.toEqual({ description: 'd', defaultBranch: 'trunk', language: 'Go', topics: ['x'] });
  });

  it('refuses a private repository even if the server token can read it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ private: true, visibility: 'private', default_branch: 'main' }));
    await expectApiError(getRepoInfo('o', 'r'), 'PRIVATE_REPO_UNSUPPORTED');
  });

  it('refuses an internal (enterprise) repository', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ private: false, visibility: 'internal', default_branch: 'main' }));
    await expectApiError(getRepoInfo('o', 'r'), 'PRIVATE_REPO_UNSUPPORTED');
  });

  it('maps 404 to REPO_NOT_FOUND (private repositories look like 404s without access)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }));
    await expectApiError(getRepoInfo('o', 'r'), 'REPO_NOT_FOUND');
  });
});

describe('resolveSnapshot', () => {
  it('uses the default branch when no ref is given and pins the commit', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ private: false, default_branch: 'develop' }))
      .mockResolvedValueOnce(textResponse(SHA));
    const snapshot = await resolveSnapshot('o', 'r', undefined);
    expect(snapshot).toMatchObject({ ref: 'develop', commitSha: SHA });
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/repos/o/r/commits/develop');
  });
});

describe('getTree', () => {
  it('reads the tree at the commit, keeps blobs outside ignored dirs, and reports truncation', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        truncated: true,
        tree: [
          { type: 'blob', path: 'src/index.ts', size: 10 },
          { type: 'tree', path: 'src' },
          { type: 'blob', path: 'node_modules/x/index.js', size: 5 },
          { type: 'blob', path: 'dist/out.js', size: 5 },
          { type: 'blob', path: 'docs/a b.md', size: 7 },
        ],
      }),
    );
    const tree = await getTree('o', 'r', SHA);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.github.com/repos/o/r/git/trees/${SHA}?recursive=1`);
    expect(tree).toEqual({
      truncated: true,
      files: [
        { path: 'src/index.ts', size: 10 },
        { path: 'docs/a b.md', size: 7 },
      ],
    });
  });

  it('throws instead of returning an empty tree when GitHub fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'retry-after': '30' } }));
    const err = await expectApiError(getTree('o', 'r', SHA), 'GITHUB_RATE_LIMITED');
    expect(err.retryAfterSec).toBe(30);
  });
});

describe('getReadme', () => {
  it('reads the README at the same commit as everything else', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ content: Buffer.from('# Hello').toString('base64') }));
    await expect(getReadme('o', 'r', SHA)).resolves.toEqual({ text: '# Hello', truncated: false });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.github.com/repos/o/r/readme?ref=${SHA}`);
  });

  it('treats a missing README as empty, but other failures as errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 404 }));
    await expect(getReadme('o', 'r', SHA)).resolves.toEqual({ text: '', truncated: false });

    fetchMock.mockResolvedValue(jsonResponse({}, { status: 503 }));
    await expectApiError(getReadme('o', 'r', SHA), 'GITHUB_UNAVAILABLE');
  });

  it('marks a long README as truncated', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ content: Buffer.from('x'.repeat(5000)).toString('base64') }));
    const readme = await getReadme('o', 'r', SHA);
    expect(readme.truncated).toBe(true);
    expect(readme.text.length).toBe(3000);
  });
});

describe('getFileAtCommit', () => {
  it.each([
    ['src/a b.ts', 'src/a%20b.ts'],
    ['docs/what#is?this.md', 'docs/what%23is%3Fthis.md'],
    ['app/[id]/page.tsx', 'app/%5Bid%5D/page.tsx'],
    ['i18n/café.json', 'i18n/caf%C3%A9.json'],
    ['50%/file.txt', '50%25/file.txt'],
  ])('encodes unusual file names (%s) and reads from the pinned commit', async (path, encoded) => {
    fetchMock.mockResolvedValue(textResponse('content'));
    await getFileAtCommit('o', 'r', SHA, path);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://raw.githubusercontent.com/o/r/${SHA}/${encoded}`);
  });

  it('maps 404 to FILE_NOT_FOUND rather than returning empty content', async () => {
    fetchMock.mockResolvedValue(textResponse('404: Not Found', { status: 404 }));
    await expectApiError(getFileAtCommit('o', 'r', SHA, 'missing.ts'), 'FILE_NOT_FOUND');
  });

  it('rejects binary content', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([0x89, 0x50, 0x00, 0x01])));
    await expectApiError(getFileAtCommit('o', 'r', SHA, 'img.dat'), 'FILE_NOT_TEXT');
  });

  it('stops downloading at maxBytes and reports truncation', async () => {
    fetchMock.mockResolvedValue(textResponse('x'.repeat(10_000)));
    const file = await getFileAtCommit('o', 'r', SHA, 'big.txt', { maxBytes: 1000 });
    expect(file).toMatchObject({ truncated: true, bytesRead: 1000 });
    expect(file.content.length).toBe(1000);
  });
});

describe('retries and timeouts', () => {
  it('retries once after a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(textResponse(SHA));
    await expect(resolveCommitSha('o', 'r', 'main')).resolves.toBe(SHA);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx once, then reports GitHub as unavailable', async () => {
    fetchMock.mockResolvedValue(textResponse('bad gateway', { status: 502 }));
    await expectApiError(resolveCommitSha('o', 'r', 'main'), 'GITHUB_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries a 4xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 404 }));
    await expectApiError(getRepoInfo('o', 'r'), 'REPO_NOT_FOUND');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a deadline to UPSTREAM_TIMEOUT', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));
    await expectApiError(resolveCommitSha('o', 'r', 'main'), 'UPSTREAM_TIMEOUT');
  });

  it('does not retry once the caller has aborted', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(resolveCommitSha('o', 'r', 'main', controller.signal)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('rateLimitRetryAfter', () => {
  it('ignores ordinary 403s (e.g. blocked repositories)', () => {
    expect(rateLimitRetryAfter(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '42' } }))).toBeNull();
  });
  it('honours retry-after for secondary rate limits', () => {
    expect(rateLimitRetryAfter(new Response('', { status: 403, headers: { 'retry-after': '7' } }))).toBe(7);
  });
});

describe('getGoodFirstIssues', () => {
  it('surfaces a rate limit as an error instead of "no issues"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    await expectApiError(getGoodFirstIssues('o', 'r'), 'GITHUB_RATE_LIMITED');
  });

  it('categorizes results by label', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [{ number: 3, title: 't', labels: [{ name: 'Good First Issue' }], comments: 2 }, { number: 4, title: 'u', labels: [{ name: 'help wanted' }] }] }),
    );
    const issues = await getGoodFirstIssues('o', 'r');
    expect(issues.map((i) => i.category)).toEqual(['good first issue', 'help wanted']);
  });
});

describe('getIssue', () => {
  it('reads the issue and a bounded selection of comments from GitHub', async () => {
    const comments = Array.from({ length: 30 }, (_, i) => ({ user: { login: `u${i}` }, body: `comment ${i}` }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ title: 'Bug', body: 'Body', state: 'open', updated_at: '2026-01-01T00:00:00Z', comments: 30 }))
      .mockResolvedValueOnce(jsonResponse(comments));
    const issue = await getIssue('o', 'r', 7);
    expect(issue.title).toBe('Bug');
    expect(issue.commentsTotal).toBe(30);
    expect(issue.comments).toHaveLength(12);
    expect(issue.comments[0].body).toBe('comment 0');
    expect(issue.comments.at(-1)?.body).toBe('comment 29');
  });

  it('maps a missing issue to ISSUE_NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 404 }));
    await expectApiError(getIssue('o', 'r', 99), 'ISSUE_NOT_FOUND');
  });
});
