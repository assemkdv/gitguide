import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../lib/github', () => ({
  getRepoInfo: vi.fn(),
  getReadme: vi.fn(),
  getRepoTree: vi.fn(),
  getGoodFirstIssues: vi.fn(),
  getFileContent: vi.fn(),
}));
vi.mock('../lib/groq-client', () => ({
  getGroqClient: vi.fn(),
}));

import { getRepoInfo, getReadme, getRepoTree, getGoodFirstIssues, getFileContent } from '../lib/github';
import { getGroqClient } from '../lib/groq-client';
import { app } from '../server';

function mockGroqCompletion(content: unknown) {
  vi.mocked(getGroqClient).mockReturnValue({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      },
    },
  } as any);
}

// Regression suite: proves /v1/explain-repo's output is unchanged after extracting its
// prompt/parsing core into lib/repo-summary.ts for reuse by the RAG indexer.
describe('POST /v1/explain-repo', () => {
  beforeEach(() => {
    vi.mocked(getRepoInfo).mockResolvedValue({ description: 'A test repo', defaultBranch: 'main', language: 'TypeScript', topics: [] });
    vi.mocked(getReadme).mockResolvedValue('# Test repo\nSome readme content.');
    vi.mocked(getRepoTree).mockResolvedValue(['src/index.ts', 'src/server.ts', 'README.md']);
    vi.mocked(getGoodFirstIssues).mockResolvedValue([
      { number: 1, title: 'Fix bug', labels: ['good first issue'], category: 'good first issue', comments: 2 },
    ]);
    vi.mocked(getFileContent).mockResolvedValue('line1\nline2\nline3');
    mockGroqCompletion({
      purpose: 'A test repo for testing.',
      techStack: ['TypeScript', 'Node.js'],
      folderStructure: [{ path: 'src', description: 'Source code' }],
      architecture: [{ title: 'Server', description: 'Express server' }],
      entrypoints: [{ path: 'src/server.ts', label: 'Server entry' }],
      dataFlow: 'Requests flow through the server.',
      authPersistence: '',
      howToRun: ['npm install', 'npm start'],
      beginnerStart: 'Start with src/server.ts.',
    });
  });

  it('returns the expected response shape', async () => {
    const res = await request(app)
      .post('/v1/explain-repo')
      .set('Origin', 'https://github.com')
      .send({ repoOwner: 'owner', repoName: 'repo' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      purpose: 'A test repo for testing.',
      techStack: ['TypeScript', 'Node.js'],
      folderStructure: [{ path: 'src', description: 'Source code' }],
      architecture: [{ title: 'Server', description: 'Express server' }],
      keyEntrypoints: [{ path: 'src/server.ts', label: 'Server entry', loc: 3 }],
      dataFlow: 'Requests flow through the server.',
      authPersistence: '',
      howToRun: ['npm install', 'npm start'],
      beginnerStart: 'Start with src/server.ts.',
      goodFirstIssues: [{ number: 1, title: 'Fix bug', labels: ['good first issue'], category: 'good first issue', comments: 2 }],
    });
  });

  it('discards a model-suggested entrypoint path that is not in the real file tree', async () => {
    mockGroqCompletion({
      purpose: 'x',
      techStack: [],
      folderStructure: [],
      architecture: [],
      entrypoints: [
        { path: 'src/server.ts', label: 'Real' },
        { path: 'src/hallucinated.ts', label: 'Fake' },
      ],
      dataFlow: '',
      authPersistence: '',
      howToRun: [],
      beginnerStart: '',
    });

    const res = await request(app)
      .post('/v1/explain-repo')
      .set('Origin', 'https://github.com')
      .send({ repoOwner: 'owner', repoName: 'repo' });

    expect(res.body.keyEntrypoints).toEqual([{ path: 'src/server.ts', label: 'Real', loc: 3 }]);
  });

  it('resolves the tree and entrypoint content against the repo default branch', async () => {
    await request(app).post('/v1/explain-repo').set('Origin', 'https://github.com').send({ repoOwner: 'owner', repoName: 'repo' });

    expect(getRepoTree).toHaveBeenCalledWith('owner', 'repo', 'main', expect.anything());
    expect(getFileContent).toHaveBeenCalledWith('owner', 'repo', 'main', 'src/server.ts', expect.anything());
  });

  it('rejects a request missing required fields', async () => {
    const res = await request(app).post('/v1/explain-repo').set('Origin', 'https://github.com').send({ repoOwner: 'owner' });
    expect(res.status).toBe(400);
  });
});
