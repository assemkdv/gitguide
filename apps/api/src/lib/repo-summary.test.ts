import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./github', () => ({
  getRepoInfo: vi.fn(),
  getReadme: vi.fn(),
  getRepoTree: vi.fn(),
}));
vi.mock('./groq-client', () => ({
  getGroqClient: vi.fn(),
}));

import { getRepoInfo, getReadme, getRepoTree } from './github';
import { getGroqClient } from './groq-client';
import { generateRepoSummary, formatRepoSummaryForPrompt, RepoSummaryFields } from './repo-summary';

const VALID_SUMMARY = {
  purpose: 'A test repo for testing.',
  techStack: ['TypeScript', 'Node.js'],
  folderStructure: [{ path: 'src', description: 'Source code' }],
  architecture: [{ title: 'Server', description: 'Express server' }],
  entrypoints: [{ path: 'src/server.ts', label: 'Server entry' }],
  dataFlow: 'Requests flow through the server.',
  authPersistence: '',
  howToRun: ['npm install', 'npm start'],
  beginnerStart: 'Start with src/server.ts.',
};

function mockGroqCompletion(content: unknown) {
  vi.mocked(getGroqClient).mockReturnValue({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      },
    },
  } as any);
}

describe('generateRepoSummary', () => {
  beforeEach(() => {
    vi.mocked(getRepoInfo).mockResolvedValue({ description: 'desc', defaultBranch: 'main', language: 'TypeScript', topics: [] });
    vi.mocked(getReadme).mockResolvedValue('# Readme');
    vi.mocked(getRepoTree).mockResolvedValue(['src/index.ts', 'src/server.ts']);
    mockGroqCompletion(VALID_SUMMARY);
  });

  it('fetches the tree against repoInfo.defaultBranch when no ref override is given', async () => {
    await generateRepoSummary('owner', 'repo');
    expect(getRepoTree).toHaveBeenCalledWith('owner', 'repo', 'main', undefined);
  });

  it('fetches the tree against the provided ref override instead of defaultBranch', async () => {
    await generateRepoSummary('owner', 'repo', 'feature/new-auth');
    expect(getRepoTree).toHaveBeenCalledWith('owner', 'repo', 'feature/new-auth', undefined);
  });

  it('returns the parsed summary alongside repoInfo, the resolved ref, and the tree', async () => {
    const result = await generateRepoSummary('owner', 'repo');
    expect(result.ref).toBe('main');
    expect(result.tree).toEqual(['src/index.ts', 'src/server.ts']);
    expect(result.repoInfo.description).toBe('desc');
    expect(result.summary).toEqual(VALID_SUMMARY);
  });

  it('threads the abort signal through to the GitHub and Groq calls', async () => {
    const controller = new AbortController();
    await generateRepoSummary('owner', 'repo', undefined, controller.signal);
    expect(getRepoInfo).toHaveBeenCalledWith('owner', 'repo', controller.signal);
    expect(getRepoTree).toHaveBeenCalledWith('owner', 'repo', 'main', controller.signal);
  });
});

describe('formatRepoSummaryForPrompt', () => {
  it('labels each present section', () => {
    const text = formatRepoSummaryForPrompt(VALID_SUMMARY as RepoSummaryFields);
    expect(text).toContain('Purpose: A test repo for testing.');
    expect(text).toContain('Tech stack: TypeScript, Node.js');
    expect(text).toContain('Architecture:');
    expect(text).toContain('Major folders:');
  });

  it('omits empty/falsy sections rather than printing empty labels', () => {
    const sparse: RepoSummaryFields = {
      ...VALID_SUMMARY,
      techStack: [],
      folderStructure: [],
      architecture: [],
      authPersistence: '',
      dataFlow: '',
    };
    const text = formatRepoSummaryForPrompt(sparse);
    expect(text).not.toContain('Tech stack:');
    expect(text).not.toContain('Major folders:');
    expect(text).not.toContain('Auth/persistence:');
    expect(text).not.toContain('Data flow:');
  });

  it('truncates to the given character budget', () => {
    const long: RepoSummaryFields = { ...VALID_SUMMARY, purpose: 'x'.repeat(5000) };
    const text = formatRepoSummaryForPrompt(long, 200);
    expect(text.length).toBeLessThanOrEqual(200);
  });
});
