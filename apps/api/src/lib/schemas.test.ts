import { describe, it, expect } from 'vitest';
import { repoIdentitySchema, explainFileSchema, askRepoSchema } from './schemas';

describe('repoIdentitySchema — repoOwner/repoName', () => {
  it.each([
    ['octocat', 'Hello-World'],
    ['torvalds', 'linux'],
    ['my-org-123', 'my_repo.name'],
    ['a', 'b'], // single-character segments are valid GitHub identifiers
    ['x'.repeat(39), 'y'.repeat(100)], // exactly at GitHub's own length caps
  ])('accepts a normal GitHub owner/repo pair (%s, %s)', (repoOwner, repoName) => {
    expect(repoIdentitySchema.safeParse({ repoOwner, repoName }).success).toBe(true);
  });

  it.each([
    ['../etc', 'repo'],
    ['owner', '../../etc/passwd'],
    ['owner', 'repo/with/slash'],
    ['-leading-hyphen', 'repo'],
    ['trailing-hyphen-', 'repo'],
    ['double--hyphen', 'repo'],
    ['owner name', 'repo'], // space
    ['owner?', 'repo'],
    ['owner', 'repo#fragment'],
    ['owner', '.'],
    ['owner', '..'],
    ['x'.repeat(40), 'repo'], // one over GitHub's 39-char username cap
    ['owner', 'y'.repeat(101)], // one over GitHub's 100-char repo name cap
    ['', 'repo'],
    ['owner', ''],
  ])('rejects a malicious or malformed owner/repo pair (%s, %s)', (repoOwner, repoName) => {
    expect(repoIdentitySchema.safeParse({ repoOwner, repoName }).success).toBe(false);
  });
});

describe('explainFileSchema — filePath', () => {
  const base = { repoOwner: 'owner', repoName: 'repo', ref: 'main' };

  it.each([
    'src/index.ts',
    'a.ts',
    'src/components/[id].tsx', // brackets are valid in real file paths
    'docs/my notes.md', // spaces are valid in real file paths
    'README',
  ])('accepts a normal repository-relative path (%s)', (filePath) => {
    expect(explainFileSchema.safeParse({ ...base, filePath }).success).toBe(true);
  });

  it.each([
    '../../../etc/passwd',
    'src/../../../etc/passwd',
    '/etc/passwd', // absolute path
    'src//index.ts', // empty segment
    'src\\index.ts', // backslash
    'src/index.ts\0.png', // embedded null byte
    '.',
    '..',
    '',
  ])('rejects a traversal-style or malformed path (%s)', (filePath) => {
    expect(explainFileSchema.safeParse({ ...base, filePath }).success).toBe(false);
  });
});

describe('askRepoSchema — context.ref', () => {
  const base = { question: 'where is auth?', context: { repoOwner: 'owner', repoName: 'repo' } };

  it.each([
    'main',
    'release/v2', // slash-containing branch name
    'feature/foo-bar_123',
    'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', // commit SHA
  ])('accepts a normal git ref (%s)', (ref) => {
    const result = askRepoSchema.safeParse({ ...base, context: { ...base.context, ref } });
    expect(result.success).toBe(true);
  });

  it.each([
    '../../../etc/passwd',
    'foo/../bar',
    'foo//bar',
    '/leading-slash',
    'trailing-slash/',
    '.hidden',
    'foo/.git',
    'refs.lock',
    'a ref with spaces',
    'ref?query=1',
    'ref#fragment',
  ])('rejects a traversal-style or malformed ref (%s)', (ref) => {
    const result = askRepoSchema.safeParse({ ...base, context: { ...base.context, ref } });
    expect(result.success).toBe(false);
  });

  it('still accepts a request with no ref at all (falls back to the default branch)', () => {
    expect(askRepoSchema.safeParse(base).success).toBe(true);
  });
});
