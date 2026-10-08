import { describe, it, expect } from 'vitest';
import { blobUrl, checkPaths, resolveRepoPath } from './path-evidence';

const tree = new Set(['src/auth/session.ts', 'src/auth/index.ts', 'src/utils.py', 'docs/a b.md', 'lib/x/util.js', 'lib/y/util.js']);

describe('resolveRepoPath', () => {
  it.each([
    ['src/auth/session.ts', 'src/auth/session.ts'],
    ['`src/utils.py`', 'src/utils.py'],
    ['/src/auth/session.ts', 'src/auth/session.ts'],
    ['src/auth', 'src/auth/index.ts'],
    ['session.ts', 'src/auth/session.ts'],
  ])('resolves %s', (candidate, expected) => {
    expect(resolveRepoPath(candidate, tree)).toBe(expected);
  });

  it('resolves relative imports against the file directory', () => {
    expect(resolveRepoPath('./session', tree, 'src/auth')).toBe('src/auth/session.ts');
    expect(resolveRepoPath('../utils.py', tree, 'src/auth')).toBe('src/utils.py');
  });

  it('rejects ambiguous bare names, invented paths, and traversal above the root', () => {
    expect(resolveRepoPath('util.js', tree)).toBeNull();
    expect(resolveRepoPath('src/made-up.ts', tree)).toBeNull();
    expect(resolveRepoPath('../../etc/passwd', tree, 'src')).toBeNull();
  });
});

describe('checkPaths', () => {
  it('labels each candidate', () => {
    expect(checkPaths(['src/utils.py', 'nope.ts', ''], tree)).toEqual([
      { path: 'src/utils.py', verified: true },
      { path: 'nope.ts', verified: false },
    ]);
  });
});

describe('blobUrl', () => {
  it('pins to the commit and encodes each path segment', () => {
    expect(blobUrl('o', 'r', 'abc', 'docs/a b#1.md', 3, 9)).toBe('https://github.com/o/r/blob/abc/docs/a%20b%231.md#L3-L9');
    expect(blobUrl('o', 'r', 'abc', 'x.ts', 4, 4)).toBe('https://github.com/o/r/blob/abc/x.ts#L4');
  });
});
