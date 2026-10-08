import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../lib/github', () => ({ resolveSnapshot: vi.fn(), getGoodFirstIssues: vi.fn(), getFileAtCommit: vi.fn() }));
vi.mock('../lib/repo-summary', () => ({ generateRepoSummary: vi.fn() }));

import { resolveSnapshot, getGoodFirstIssues, getFileAtCommit } from '../lib/github';
import { generateRepoSummary } from '../lib/repo-summary';
import { ApiError } from '../lib/errors';
import { app } from '../server';

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const SHA = '1'.repeat(40);
const SUMMARY = {
  purpose: 'p', techStack: ['TS'], folderStructure: [], architecture: [],
  entrypoints: [{ path: 'src/index.ts', label: 'Entry' }],
  dataFlow: '', authPersistence: '', howToRun: [], beginnerStart: 'b',
};

const post = (body: unknown) => request(app).post('/v1/explain-repo').set('Origin', EXTENSION_ORIGIN).send(body);

beforeEach(() => {
  vi.mocked(resolveSnapshot).mockReset().mockImplementation(async (owner, repo, ref) => ({
    owner, repo, repoInfo: { description: null, defaultBranch: 'main', language: null, topics: [] }, ref: ref ?? 'main', commitSha: SHA,
  }));
  vi.mocked(getGoodFirstIssues).mockReset().mockResolvedValue([{ number: 1, title: 't', labels: [], category: 'help wanted', comments: 0 }]);
  vi.mocked(getFileAtCommit).mockReset().mockResolvedValue({ content: 'a\nb\nc', truncated: false, bytesRead: 5 });
  vi.mocked(generateRepoSummary).mockReset().mockResolvedValue({
    summary: SUMMARY,
    tree: { files: [{ path: 'src/index.ts', size: 5 }], truncated: true },
    coverage: { filesInTree: 1, filesShownToModel: 1, treeTruncated: true, readmeTruncated: false, hasReadme: true },
  });
});

describe('POST /v1/explain-repo', () => {
  it('returns the explanation pinned to a commit, with coverage metadata and commit links', async () => {
    const res = await post({ repoOwner: 'owner', repoName: 'repo' });
    expect(res.status).toBe(200);
    expect(res.body.keyEntrypoints).toEqual([{ path: 'src/index.ts', label: 'Entry', loc: 3, url: `https://github.com/owner/repo/blob/${SHA}/src/index.ts` }]);
    expect(res.body.meta).toMatchObject({ ref: 'main', commitSha: SHA, treeTruncated: true });
    expect(getFileAtCommit).toHaveBeenCalledWith('owner', 'repo', SHA, 'src/index.ts', expect.anything());
  });

  it('explains a specific ref when one is given', async () => {
    await post({ repoOwner: 'owner', repoName: 'repo', ref: 'v2.0.0' });
    expect(resolveSnapshot).toHaveBeenCalledWith('owner', 'repo', 'v2.0.0', expect.anything());
  });

  it('marks good-first-issues as unavailable (not empty) when that lookup fails', async () => {
    vi.mocked(getGoodFirstIssues).mockRejectedValue(new ApiError('GITHUB_RATE_LIMITED', 503, 'limited', 60));
    const res = await post({ repoOwner: 'owner', repoName: 'repo' });
    expect(res.status).toBe(200);
    expect(res.body.goodFirstIssues).toBeNull();
    expect(res.body.goodFirstIssuesError).toBe('GITHUB_RATE_LIMITED');
  });

  it.each([
    ['REPO_NOT_FOUND', 404],
    ['PRIVATE_REPO_UNSUPPORTED', 403],
    ['GITHUB_RATE_LIMITED', 503],
  ] as const)('returns a structured %s error', async (code, status) => {
    vi.mocked(resolveSnapshot).mockRejectedValue(new ApiError(code, status, 'msg', code === 'GITHUB_RATE_LIMITED' ? 30 : undefined));
    const res = await post({ repoOwner: 'owner', repoName: 'repo' });
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ code, error: 'msg' });
    if (code === 'GITHUB_RATE_LIMITED') expect(res.headers['retry-after']).toBe('30');
  });

  it('rejects a request missing required fields', async () => {
    const res = await post({ repoOwner: 'owner' });
    expect(res.status).toBe(400);
  });
});
