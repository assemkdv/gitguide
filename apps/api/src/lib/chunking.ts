// Splits a file's content into retrieval-sized chunks, preferring to cut at a detected
// declaration boundary (function/class/interface/etc.) over an arbitrary line, and
// falling back to a nearby blank line, and finally a hard line cut, when no boundary is
// found nearby. Deliberately regex-based rather than a per-language AST parse: a real
// parser per language would be a large, fragile dependency footprint for what is
// fundamentally a chunking heuristic, where a boundary a few lines off from the "true"
// one costs nothing (retrieval works over the resulting text regardless).

export interface Chunk {
  filePath: string;
  language: string;
  startLine: number; // 1-indexed, inclusive
  endLine: number; // 1-indexed, inclusive
  text: string;
}

const MIN_CONTENT_LENGTH = 20;
const TARGET_CHUNK_LINES = 50;
const TARGET_CHUNK_CHARS = 1800;
const OVERLAP_LINES = 8;
export const MAX_CHUNK_LINES = 120;
const BOUNDARY_LOOKAHEAD = 15;
const BLANK_LINE_LOOKAHEAD = 10;

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  rs: 'rust',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  md: 'markdown', mdx: 'markdown',
  json: 'json',
  yml: 'yaml', yaml: 'yaml',
  html: 'html',
  css: 'css', scss: 'scss', less: 'less',
  sh: 'shell', bash: 'shell',
  sql: 'sql',
};

export function detectLanguage(path: string): string {
  const filename = path.split('/').pop() ?? path;
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'text';
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_LANGUAGE[ext] ?? 'text';
}

// Only defined for languages with a reasonably reliable top-level-declaration keyword.
// Any language not listed here (or a fixture with none of these patterns present) falls
// straight through to the blank-line/hard-line cut logic below.
const BOUNDARY_PATTERNS: Record<string, RegExp> = {
  typescript:
    /^\s*(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?function\b|^\s*(export\s+)?(default\s+)?(abstract\s+)?class\b|^\s*(export\s+)?(const|let|var)\s+\w+\s*(:[^=]+)?=\s*(async\s*)?\(|^\s*(export\s+)?interface\b|^\s*(export\s+)?type\s+\w+\s*=/,
  python: /^\s*(async\s+)?def\b|^\s*class\b/,
  go: /^\s*func\b|^\s*type\s+\w+\s+(struct|interface)\b/,
  java: /^\s*(public|private|protected|static|final|abstract|\s)*(class|interface|enum)\s+\w+/,
  ruby: /^\s*(class|module)\b|^\s*def\b/,
  php: /^\s*(abstract\s+)?(final\s+)?class\b|^\s*(public|private|protected|static|\s)*function\b/,
  rust: /^\s*(pub\s+)?(async\s+)?fn\b|^\s*(pub\s+)?(struct|enum|trait)\b|^\s*impl\b/,
};
BOUNDARY_PATTERNS.javascript = BOUNDARY_PATTERNS.typescript;
BOUNDARY_PATTERNS.csharp = BOUNDARY_PATTERNS.java;

function findCutPoint(
  lines: string[],
  start: number,
  targetEnd: number,
  hardCap: number,
  isBoundary: (i: number) => boolean,
): number {
  for (let i = targetEnd; i < Math.min(hardCap, targetEnd + BOUNDARY_LOOKAHEAD); i++) {
    if (isBoundary(i)) return i; // cut right before the next declaration
  }
  const isBlank = (i: number) => lines[i].trim() === '';
  for (let offset = 0; offset <= BLANK_LINE_LOOKAHEAD; offset++) {
    const forward = targetEnd + offset;
    if (forward < hardCap && isBlank(forward)) return forward + 1;
    const backward = targetEnd - offset;
    if (backward > start && isBlank(backward)) return backward + 1;
  }
  return Math.min(targetEnd, hardCap); // no good nearby cut — hard line cut
}

export function chunkFile(path: string, content: string): Chunk[] {
  if (content.trim().length < MIN_CONTENT_LENGTH) return [];

  const language = detectLanguage(path);
  const lines = content.split('\n');
  const boundaryPattern = BOUNDARY_PATTERNS[language];
  const isBoundary = (i: number) => (boundaryPattern ? boundaryPattern.test(lines[i]) : false);

  if (lines.length <= TARGET_CHUNK_LINES && content.length <= TARGET_CHUNK_CHARS) {
    return [{ filePath: path, language, startLine: 1, endLine: lines.length, text: content }];
  }

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && end - start < MAX_CHUNK_LINES) {
      chars += lines[end].length + 1;
      end++;
      if (end - start >= TARGET_CHUNK_LINES || chars >= TARGET_CHUNK_CHARS) break;
    }

    const hardCap = Math.min(lines.length, start + MAX_CHUNK_LINES);
    if (end < lines.length) {
      end = findCutPoint(lines, start, end, hardCap, isBoundary);
    }

    chunks.push({
      filePath: path,
      language,
      startLine: start + 1,
      endLine: end,
      text: lines.slice(start, end).join('\n'),
    });

    if (end >= lines.length) break;
    start = Math.max(start + 1, end - OVERLAP_LINES);
  }

  return chunks;
}
