import { describe, it, expect } from 'vitest';
import { IGNORED_DIR_SEGMENTS, isIndexableFile } from './ignore-list';

describe('IGNORED_DIR_SEGMENTS', () => {
  it('matches the exact set getRepoTree relied on before the extraction', () => {
    expect([...IGNORED_DIR_SEGMENTS].sort()).toEqual(
      ['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'vendor'].sort(),
    );
  });
});

describe('isIndexableFile', () => {
  it.each([
    ['src/auth/login.ts', true],
    ['README.md', true],
    ['Dockerfile', true],
    ['Makefile', true],
    ['src/components/App.tsx', true],
  ])('%s is indexable', (path, expected) => {
    expect(isIndexableFile(path)).toBe(expected);
  });

  it.each([
    ['package-lock.json', false],
    ['yarn.lock', false],
    ['pnpm-lock.yaml', false],
    ['Cargo.lock', false],
    ['Gemfile.lock', false],
    ['go.sum', false],
    ['assets/logo.png', false],
    ['assets/icon.svg', false],
    ['fonts/inter.woff2', false],
    ['dist/bundle.min.js', false],
    ['styles/app.min.css', false],
    ['build/output.wasm', false],
    ['docs/manual.pdf', false],
    ['assets/bundle.js.map', false],
  ])('%s is not indexable', (path, expected) => {
    expect(isIndexableFile(path)).toBe(expected);
  });

  it('is case-insensitive on extension matching', () => {
    expect(isIndexableFile('assets/Logo.PNG')).toBe(false);
  });

  it('returns false for a path with no filename segment', () => {
    expect(isIndexableFile('src/')).toBe(false);
  });
});
