import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../lib/github', () => ({ resolveSnapshot: vi.fn(), getFileAtCommit: vi.fn(), getTree: vi.fn() }));
vi.mock('../lib/groq-client', () => ({ getGroqClient: vi.fn() }));

import { resolveSnapshot, getFileAtCommit, getTree } from '../lib/github';
import { getGroqClient } from '../lib/groq-client';
import { ApiError } from '../lib/errors';
import { app } from '../server';
import { FULL_ANALYSIS_CHARS } from './explain-file';
import { OUTPUT_STYLE_RULES } from '../lib/prompt-safety';

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const SHA = '2'.repeat(40);
const create = vi.fn();
const reply = (obj: unknown) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });
const post = (path: string, body: unknown) => request(app).post(path).set('Origin', EXTENSION_ORIGIN).send(body);
const body = { repoOwner: 'owner', repoName: 'repo', ref: 'feature/x', filePath: 'src/auth/login.ts' };

beforeEach(() => {
  vi.mocked(resolveSnapshot).mockReset().mockImplementation(async (owner, repo, ref) => ({
    owner, repo, repoInfo: { description: null, defaultBranch: 'main', language: null, topics: [] }, ref: ref ?? 'main', commitSha: SHA,
  }));
  vi.mocked(getFileAtCommit).mockReset().mockResolvedValue({ content: 'export function login() {}\n', truncated: false, bytesRead: 30 });
  vi.mocked(getTree).mockReset().mockResolvedValue({ files: [{ path: 'src/auth/session.ts', size: 1 }, { path: 'src/auth/login.ts', size: 1 }], truncated: false });
  create.mockReset().mockResolvedValue(
    reply({ purpose: 'Logs users in', summary: 's', mainComponents: ['login'], relatedFiles: ['./session', 'src/made-up.ts'] }),
  );
  vi.mocked(getGroqClient).mockReturnValue({ chat: { completions: { create } } } as any);
});

describe('POST /v1/explain-file', () => {
  it('reads the file itself from the resolved commit (no browser content accepted)', async () => {
    const res = await post('/v1/explain-file', { ...body, fileContent: 'IGNORED DOM TEXT' });
    expect(res.status).toBe(200);
    expect(resolveSnapshot).toHaveBeenCalledWith('owner', 'repo', 'feature/x', expect.anything());
    expect(getFileAtCommit).toHaveBeenCalledWith('owner', 'repo', SHA, 'src/auth/login.ts', expect.anything());
    expect(JSON.stringify(create.mock.calls[0][0])).not.toContain('IGNORED DOM TEXT');
  });

  it('marks related files as verified only when they exist at that commit', async () => {
    const res = await post('/v1/explain-file', body);
    expect(res.body.relatedFiles).toEqual([
      { path: 'src/auth/session.ts', verified: true },
      { path: 'src/made-up.ts', verified: false },
    ]);
  });

  it('reports truncation when the model only saw the beginning of the file', async () => {
    vi.mocked(getFileAtCommit).mockResolvedValue({ content: 'x'.repeat(FULL_ANALYSIS_CHARS + 500), truncated: false, bytesRead: 1 });
    const res = await post('/v1/explain-file', body);
    expect(res.body.meta).toMatchObject({
      ref: 'feature/x',
      commitSha: SHA,
      truncated: true,
      analyzedChars: FULL_ANALYSIS_CHARS,
      totalChars: FULL_ANALYSIS_CHARS + 500,
      url: `https://github.com/owner/repo/blob/${SHA}/src/auth/login.ts`,
    });
    expect(create.mock.calls[0][0].messages[1].content).toContain('only the first');
  });

  it('allows a short file to have few components (no forced counts, no forced guessing)', async () => {
    await post('/v1/explain-file', body);
    const prompt = create.mock.calls[0][0].messages.map((m: { content: string }) => m.content).join('\n');
    expect(prompt).not.toMatch(/3-5 items/);
    expect(prompt).not.toContain('rather than hedging');
    expect(prompt).toContain('do not pad');
  });

  it.each(['/v1/explain-file', '/v1/explain-file/quick'])('%s asks the model not to use em dashes', async (path) => {
    await post(path, body);
    const prompt = create.mock.calls[0][0].messages.map((m: { content: string }) => m.content).join('\n');
    expect(prompt).toContain(OUTPUT_STYLE_RULES);
    // The style rule itself names the character; nothing else in the template uses it.
    expect(prompt.replace(OUTPUT_STYLE_RULES, '')).not.toContain('\u2014');
  });

  it.each([
    ['FILE_NOT_FOUND', 404],
    ['FILE_NOT_TEXT', 422],
    ['REF_NOT_FOUND', 404],
    ['UPSTREAM_TIMEOUT', 504],
  ] as const)('maps %s to a structured response', async (code, status) => {
    vi.mocked(getFileAtCommit).mockRejectedValue(new ApiError(code, status, 'm'));
    const res = await post('/v1/explain-file', body);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  it('turns an unusable model reply into AI_MALFORMED instead of an empty result', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: 'Sure! Here is the explanation…' } }] });
    const res = await post('/v1/explain-file', body);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_MALFORMED');
  });

  it('quick pass returns purpose/summary plus the same metadata', async () => {
    create.mockResolvedValue(reply({ purpose: 'p', summary: 's' }));
    const res = await post('/v1/explain-file/quick', body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ purpose: 'p', summary: 's', meta: { commitSha: SHA } });
  });
});
