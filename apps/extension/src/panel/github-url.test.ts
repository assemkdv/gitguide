import { describe, it, expect } from 'vitest';
import { buildBlobUrl } from './github-url';

describe('buildBlobUrl', () => {
  it('builds a multi-line range fragment when start and end differ', () => {
    expect(buildBlobUrl('owner', 'repo', 'main', 'src/auth.ts', 12, 48)).toBe(
      'https://github.com/owner/repo/blob/main/src/auth.ts#L12-L48',
    );
  });

  it('builds a single-line fragment when start equals end', () => {
    expect(buildBlobUrl('owner', 'repo', 'main', 'src/auth.ts', 12, 12)).toBe(
      'https://github.com/owner/repo/blob/main/src/auth.ts#L12',
    );
  });

  it('preserves a slash-containing branch ref verbatim', () => {
    expect(buildBlobUrl('owner', 'repo', 'feature/new-auth', 'src/auth.ts', 1, 5)).toBe(
      'https://github.com/owner/repo/blob/feature/new-auth/src/auth.ts#L1-L5',
    );
  });
});
