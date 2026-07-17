import { describe, it, expect } from 'vitest';
import { chunkFile, detectLanguage, MAX_CHUNK_LINES } from './chunking';

describe('detectLanguage', () => {
  it.each([
    ['src/auth.ts', 'typescript'],
    ['src/App.tsx', 'typescript'],
    ['main.py', 'python'],
    ['main.go', 'go'],
    ['Main.java', 'java'],
    ['app.rb', 'ruby'],
    ['index.php', 'php'],
    ['lib.rs', 'rust'],
    ['README.md', 'markdown'],
    ['Dockerfile', 'text'],
    ['notes.xyz', 'text'],
  ])('%s -> %s', (path, expected) => {
    expect(detectLanguage(path)).toBe(expected);
  });
});

describe('chunkFile — empty/small content', () => {
  it('returns [] for empty content', () => {
    expect(chunkFile('src/empty.ts', '')).toEqual([]);
  });

  it('returns [] for near-empty content below the minimum length', () => {
    expect(chunkFile('src/tiny.ts', '  \n ')).toEqual([]);
  });

  it('returns a single whole-file chunk when content is under the target size', () => {
    const content = 'export function hello() {\n  return "hi";\n}\n';
    const chunks = chunkFile('src/hello.ts', content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ filePath: 'src/hello.ts', language: 'typescript', startLine: 1 });
    expect(chunks[0].text).toBe(content);
  });
});

// Three same-shaped functions (30 lines each) separated by blank lines, big enough that
// the accumulation target (50 lines) lands mid-function-two — the cut should jump
// forward to right before function-three's declaration, not truncate function two.
function buildJsFixture() {
  const fn = (name: string) => [
    `function ${name}() {`,
    ...Array.from({ length: 28 }, (_, i) => `  console.log('${name}-${i}');`),
    '}',
  ];
  const fn1 = fn('one');
  const fn2 = fn('two');
  const fn3 = fn('three');
  const lines = [...fn1, '', ...fn2, '', ...fn3];
  return {
    content: lines.join('\n'),
    fn2StartLine0: fn1.length + 1,
    fn3StartLine0: fn1.length + 1 + fn2.length + 1,
    totalLines: lines.length,
  };
}

describe('chunkFile — semantic boundary preference (TypeScript/JavaScript)', () => {
  it('cuts right before the next function declaration instead of mid-function', () => {
    const { content, fn3StartLine0, totalLines } = buildJsFixture();
    const chunks = chunkFile('src/three-fns.ts', content);

    expect(chunks.length).toBeGreaterThan(1);
    // endLine is 1-indexed/inclusive, which equals the 0-indexed line number of the
    // first line of the *next* chunk — so this asserts the cut lands exactly on
    // function three's declaration line, not somewhere inside function two's body.
    expect(chunks[0].endLine).toBe(fn3StartLine0);
    expect(chunks[chunks.length - 1].endLine).toBe(totalLines);
  });
});

describe('chunkFile — semantic boundary preference (Python)', () => {
  it('cuts right before the next def/class instead of mid-function', () => {
    const fn = (name: string) => [
      `def ${name}():`,
      ...Array.from({ length: 28 }, (_, i) => `    print('${name}-${i}')`),
    ];
    const fn1 = fn('one');
    const fn2 = fn('two');
    const fn3 = fn('three');
    const lines = [...fn1, '', ...fn2, '', ...fn3];
    const fn3StartLine0 = fn1.length + 1 + fn2.length + 1;

    const chunks = chunkFile('src/three_fns.py', lines.join('\n'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].endLine).toBe(fn3StartLine0);
  });
});

describe('chunkFile — line-based fallback for languages with no boundary patterns', () => {
  it('falls back to the nearest blank line and ignores function-looking text', () => {
    const lines = Array.from({ length: 90 }, (_, i) => {
      if (i === 55) return '';
      // A boundary-pattern look-alike planted just past the target cut point — for an
      // unrecognized language this must be ignored (no BOUNDARY_PATTERNS entry for
      // 'text'), proving the fallback doesn't accidentally match on content shape alone.
      if (i === 52) return 'function trap() {';
      return `x${i}`;
    });

    const chunks = chunkFile('notes.log', lines.join('\n'));
    expect(detectLanguage('notes.log')).toBe('text');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].endLine).toBe(56); // cuts right after the blank line at index 55
  });
});

describe('chunkFile — oversized single semantic unit is sub-chunked', () => {
  it('splits one very large function into multiple chunks, each within MAX_CHUNK_LINES', () => {
    const body = Array.from({ length: 300 }, (_, i) => `  doWork(${i});`);
    const content = ['function huge() {', ...body, '}'].join('\n');
    const totalLines = body.length + 2;

    const chunks = chunkFile('src/huge.ts', content);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(MAX_CHUNK_LINES);
    }
    // Full coverage, no gaps: each chunk starts at or before the previous chunk's end + 1.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine + 1);
    }
    expect(chunks[chunks.length - 1].endLine).toBe(totalLines);
  });
});
