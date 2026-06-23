import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseFileRouteFromUrl, isFileContentReady, resolveFileRoute, resolveRefFromKnownNames } from './page-parser';

function setPath(path: string) {
  window.history.pushState({}, '', path);
}

/** Mirrors the real `script[data-target="react-app.embeddedData"]` payload GitHub
 * renders into blob pages (verified against a live github.com page), so the resolver
 * is tested against the actual shape it has to parse, not a guess at it. */
function injectEmbeddedData(ref: string, path: string) {
  const script = document.createElement('script');
  script.type = 'application/json';
  script.setAttribute('data-target', 'react-app.embeddedData');
  script.textContent = JSON.stringify({ payload: { refInfo: { name: ref }, path } });
  document.body.appendChild(script);
  return script;
}

describe('parseFileRouteFromUrl', () => {
  beforeEach(() => setPath('/'));

  it('parses owner, repo, ref, and file path from a blob URL', () => {
    setPath('/freeCodeCamp/freeCodeCamp/blob/main/tools/challenge-helper-scripts/build-curriculum.ts');
    expect(parseFileRouteFromUrl()).toEqual({
      repoOwner: 'freeCodeCamp',
      repoName: 'freeCodeCamp',
      ref: 'main',
      filePath: 'tools/challenge-helper-scripts/build-curriculum.ts',
    });
  });

  it('decodes URL-encoded characters in the file path', () => {
    setPath('/owner/repo/blob/main/src/my%20file.ts');
    expect(parseFileRouteFromUrl()?.filePath).toBe('src/my file.ts');
  });

  it('treats a branch name with slashes as only the first segment (known limitation)', () => {
    // GitHub itself resolves ambiguous branch-vs-path segments server-side; parsing the
    // URL alone can't disambiguate "feature/branch" from a nested file path.
    setPath('/owner/repo/blob/feature/branch/src/index.ts');
    expect(parseFileRouteFromUrl()).toEqual({
      repoOwner: 'owner',
      repoName: 'repo',
      ref: 'feature',
      filePath: 'branch/src/index.ts',
    });
  });

  it('returns null for a repo root page (no /blob/)', () => {
    setPath('/owner/repo');
    expect(parseFileRouteFromUrl()).toBeNull();
  });

  it('returns null for an issue page', () => {
    setPath('/owner/repo/issues/42');
    expect(parseFileRouteFromUrl()).toBeNull();
  });

  it('returns null for non-repo top-level GitHub routes', () => {
    setPath('/settings/profile');
    expect(parseFileRouteFromUrl()).toBeNull();
  });
});

describe('resolveFileRoute', () => {
  beforeEach(() => setPath('/'));
  afterEach(() => {
    document.querySelectorAll('script[data-target="react-app.embeddedData"]').forEach((el) => el.remove());
  });

  it('leaves a simple single-segment branch ref unchanged (main)', () => {
    setPath('/owner/repo/blob/main/src/index.ts');
    const route = parseFileRouteFromUrl()!;
    injectEmbeddedData('main', 'src/index.ts');
    expect(resolveFileRoute(route)).toEqual({ repoOwner: 'owner', repoName: 'repo', ref: 'main', filePath: 'src/index.ts' });
  });

  it('leaves a simple single-segment branch ref unchanged (develop)', () => {
    setPath('/owner/repo/blob/develop/src/index.ts');
    const route = parseFileRouteFromUrl()!;
    injectEmbeddedData('develop', 'src/index.ts');
    expect(resolveFileRoute(route)).toEqual({ repoOwner: 'owner', repoName: 'repo', ref: 'develop', filePath: 'src/index.ts' });
  });

  it('leaves a tag ref unchanged (v1.2.3)', () => {
    setPath('/owner/repo/blob/v1.2.3/src/index.ts');
    const route = parseFileRouteFromUrl()!;
    injectEmbeddedData('v1.2.3', 'src/index.ts');
    expect(resolveFileRoute(route)).toEqual({ repoOwner: 'owner', repoName: 'repo', ref: 'v1.2.3', filePath: 'src/index.ts' });
  });

  it('corrects a two-segment branch ref using embedded page data (feature/auth)', () => {
    setPath('/owner/repo/blob/feature/auth/src/login.ts');
    const route = parseFileRouteFromUrl()!;
    // Naive parse takes only the first segment as ref — wrong for this branch.
    expect(route).toEqual({ repoOwner: 'owner', repoName: 'repo', ref: 'feature', filePath: 'auth/src/login.ts' });

    injectEmbeddedData('feature/auth', 'src/login.ts');
    expect(resolveFileRoute(route)).toEqual({
      repoOwner: 'owner',
      repoName: 'repo',
      ref: 'feature/auth',
      filePath: 'src/login.ts',
    });
  });

  it('corrects a two-segment branch ref using embedded page data (release/v2)', () => {
    setPath('/owner/repo/blob/release/v2/CHANGELOG.md');
    const route = parseFileRouteFromUrl()!;
    expect(route.ref).toBe('release');

    injectEmbeddedData('release/v2', 'CHANGELOG.md');
    expect(resolveFileRoute(route)).toEqual({
      repoOwner: 'owner',
      repoName: 'repo',
      ref: 'release/v2',
      filePath: 'CHANGELOG.md',
    });
  });

  it('falls back to the naive route when no embedded data is present', () => {
    setPath('/owner/repo/blob/feature/auth/src/login.ts');
    const route = parseFileRouteFromUrl()!;
    expect(resolveFileRoute(route)).toEqual(route);
  });

  it('ignores embedded data that does not reconstruct the current URL (stale/unrelated script tag)', () => {
    setPath('/owner/repo/blob/feature/auth/src/login.ts');
    const route = parseFileRouteFromUrl()!;
    // Looks plausible but doesn't match this URL — e.g. a stale tag from the previous
    // page during a Turbo transition.
    injectEmbeddedData('main', 'some/other/file.ts');
    expect(resolveFileRoute(route)).toEqual(route);
  });
});

describe('resolveRefFromKnownNames', () => {
  beforeEach(() => setPath('/'));

  it('corrects a two-segment branch ref using the known branch/tag list', () => {
    setPath('/owner/repo/blob/feature/auth/src/login.ts');
    const route = parseFileRouteFromUrl()!;
    expect(route).toEqual({ repoOwner: 'owner', repoName: 'repo', ref: 'feature', filePath: 'auth/src/login.ts' });

    const knownRefs = ['main', 'feature/auth'];
    expect(resolveRefFromKnownNames(route, knownRefs)).toEqual({
      repoOwner: 'owner',
      repoName: 'repo',
      ref: 'feature/auth',
      filePath: 'src/login.ts',
    });
  });

  it('prefers the longest matching ref when multiple prefixes could match', () => {
    setPath('/owner/repo/blob/release/v2/nested/CHANGELOG.md');
    const route = parseFileRouteFromUrl()!;

    // Both "release" and "release/v2" exist as branches — the longer one is correct.
    const knownRefs = ['release', 'release/v2'];
    expect(resolveRefFromKnownNames(route, knownRefs)).toEqual({
      repoOwner: 'owner',
      repoName: 'repo',
      ref: 'release/v2',
      filePath: 'nested/CHANGELOG.md',
    });
  });

  it('returns null when no known ref matches any prefix of the path', () => {
    setPath('/owner/repo/blob/main/src/index.ts');
    const route = parseFileRouteFromUrl()!;
    expect(resolveRefFromKnownNames(route, ['develop', 'release/v2'])).toBeNull();
  });

  it('returns null when the known ref list is empty', () => {
    setPath('/owner/repo/blob/feature/auth/src/login.ts');
    const route = parseFileRouteFromUrl()!;
    expect(resolveRefFromKnownNames(route, [])).toBeNull();
  });
});

describe('isFileContentReady', () => {
  it('is false for undefined or empty content', () => {
    expect(isFileContentReady(undefined)).toBe(false);
    expect(isFileContentReady('')).toBe(false);
  });

  it('is false for content under the minimum length once trimmed', () => {
    expect(isFileContentReady('   short   ')).toBe(false);
  });

  it('is true once trimmed content reaches the minimum length', () => {
    expect(isFileContentReady('x'.repeat(20))).toBe(true);
  });
});
