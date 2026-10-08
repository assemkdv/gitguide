import { describe, it, expect } from 'vitest';
import { isGitHubUrl, normalizeAnalysis, normalizeCitation, normalizeFileResult, normalizeGoodFirstIssues, normalizeRepoResult } from './validate';

describe('response validation', () => {
  it('rejects results missing their core content', () => {
    expect(normalizeRepoResult({})).toBeNull();
    expect(normalizeFileResult({ purpose: '' })).toBeNull();
    expect(normalizeAnalysis({ whatItAsks: [] })).toBeNull();
    expect(normalizeRepoResult([])).toBeNull();
  });

  it('fills missing optional fields with safe defaults and drops wrong types', () => {
    const r = normalizeRepoResult({ purpose: 'p', techStack: ['a', 3, null], keyEntrypoints: [{ path: 'x', loc: 'nope' }] });
    expect(r).toMatchObject({ techStack: ['a'], keyEntrypoints: [{ path: 'x', label: '', loc: null }], goodFirstIssues: null });
  });

  it('keeps "lookup failed" (null) distinct from "no issues" ([])', () => {
    expect(normalizeRepoResult({ purpose: 'p', goodFirstIssues: [] })?.goodFirstIssues).toEqual([]);
    expect(normalizeRepoResult({ purpose: 'p', goodFirstIssues: null, goodFirstIssuesError: 'GITHUB_RATE_LIMITED' })).toMatchObject({
      goodFirstIssues: null,
      goodFirstIssuesError: 'GITHUB_RATE_LIMITED',
    });
  });

  it('upgrades old string related files to unverified entries', () => {
    expect(normalizeFileResult({ purpose: 'p', relatedFiles: ['a.ts', { path: 'b.ts', verified: true }, 5] })?.relatedFiles).toEqual([
      { path: 'a.ts', verified: false },
      { path: 'b.ts', verified: true },
    ]);
  });

  it('coerces an unknown difficulty', () => {
    expect(normalizeAnalysis({ whatItAsks: ['x'], difficulty: 'impossible' })?.difficulty).toBe('intermediate');
  });

  it('only accepts https github.com citation links', () => {
    expect(isGitHubUrl('https://github.com/o/r/blob/x/a.ts#L1')).toBe(true);
    expect(isGitHubUrl('javascript:alert(1)')).toBe(false);
    expect(isGitHubUrl('https://github.com.evil.example/x')).toBe(false);
    expect(isGitHubUrl('http://github.com/x')).toBe(false);
    expect(normalizeCitation({ path: 'a', startLine: 1, endLine: 2, url: 'https://evil.example' })).toBeNull();
  });

  it('drops malformed good-first-issue entries', () => {
    expect(normalizeGoodFirstIssues([{ number: 1, title: 't' }, { title: 'no number' }, 'x'])).toHaveLength(1);
    expect(normalizeGoodFirstIssues('nope')).toBeNull();
  });
});
