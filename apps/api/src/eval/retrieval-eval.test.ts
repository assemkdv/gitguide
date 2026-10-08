// Offline retrieval-quality evaluation of the *production* configuration: keyword (BM25)
// retrieval only, because ENABLE_LOCAL_EMBEDDINGS is off on the deployed instance. The
// corpus is this repository's own source, read from disk (deterministic, no network),
// chunked exactly as the indexer does. Each question lists the files a correct answer
// must cite. Results are printed, and a floor guards against regressions.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chunkFile } from '../lib/chunking';
import { BM25Index } from '../lib/bm25';
import { chunkSearchText, hybridRetrieve, TOP_K } from '../lib/retrieval';
import type { ChunkRecord } from '../lib/vector-store';

const repoRoot = join(__dirname, '..', '..', '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' || name.startsWith('dist') ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const QUESTIONS: { question: string; expected: string[] }[] = [
  { question: 'where are per-IP rate limits configured?', expected: ['apps/api/src/lib/rate-limit.ts', 'apps/api/src/server.ts'] },
  { question: 'how are citation links to GitHub built?', expected: ['apps/api/src/lib/path-evidence.ts', 'apps/api/src/routes/ask-repo.ts'] },
  { question: 'how does the extension detect GitHub single-page navigation with pushState?', expected: ['apps/extension/src/content/nav-patch.ts'] },
  { question: 'where is the server-sent events stream parsed?', expected: ['apps/extension/src/background/sse.ts'] },
  { question: 'how are files split into chunks for indexing?', expected: ['apps/api/src/lib/chunking.ts'] },
  { question: 'how are private repositories rejected?', expected: ['apps/api/src/lib/github.ts'] },
  { question: 'where are cached explanations stored and expired?', expected: ['apps/extension/src/panel/storage.ts'] },
  { question: 'how does the panel ignore responses for a page the user navigated away from?', expected: ['apps/extension/src/panel/runActions.ts'] },
  { question: 'how is the BM25 score computed?', expected: ['apps/api/src/lib/bm25.ts'] },
  { question: 'where is the Groq client created and configured with timeouts?', expected: ['apps/api/src/lib/groq-client.ts'] },
  { question: 'how does background indexing retry after a failure?', expected: ['apps/api/src/lib/indexer.ts'] },
  { question: 'what limits the number of concurrent AI requests and the daily budget?', expected: ['apps/api/src/lib/ai-guard.ts'] },
  { question: 'how is a branch name or tag resolved to a commit sha?', expected: ['apps/api/src/lib/github.ts'] },
  { question: 'where does the chat Stop button cancel the answer?', expected: ['apps/extension/src/panel/chat.ts', 'apps/extension/src/panel/components/AskGitGuidePage.tsx'] },
  { question: 'how is untrusted repository text protected against prompt injection?', expected: ['apps/api/src/lib/prompt-safety.ts'] },
  { question: 'where is the panel width saved and validated?', expected: ['apps/extension/src/panel/storage.ts', 'apps/extension/src/panel/App.tsx'] },
];

describe('retrieval quality (BM25-only, production configuration)', () => {
  it('finds the right file for representative questions', () => {
    const files = [...sourceFiles(join(repoRoot, 'apps/api/src')), ...sourceFiles(join(repoRoot, 'apps/extension/src'))];
    const chunks: ChunkRecord[] = files.flatMap((full) => {
      const path = relative(repoRoot, full);
      return chunkFile(path, readFileSync(full, 'utf8')).map((c) => ({
        id: `${c.filePath}:${c.startLine}-${c.endLine}`,
        repoOwner: 'eval',
        repoName: 'gitguide',
        sha: 'eval',
        filePath: c.filePath,
        language: c.language,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        embedding: null,
      }));
    });
    const bm25 = new BM25Index(chunks.map((c) => ({ id: c.id, text: chunkSearchText(c) })));

    let hit1 = 0;
    let hit3 = 0;
    let hitK = 0;
    const rows: string[] = [];
    for (const { question, expected } of QUESTIONS) {
      const ranked = hybridRetrieve(null, question, chunks, bm25).map((r) => r.chunk.filePath);
      const rank = ranked.findIndex((p) => expected.includes(p));
      if (rank === 0) hit1++;
      if (rank >= 0 && rank < 3) hit3++;
      if (rank >= 0) hitK++;
      rows.push(`${rank >= 0 ? `#${rank + 1}` : 'miss'}\t${question}${rank < 0 ? `  (top: ${ranked[0] ?? 'none'})` : ''}`);
    }
    const n = QUESTIONS.length;
    console.log(
      `\nRetrieval eval — ${files.length} files, ${chunks.length} chunks, ${n} questions, k=${TOP_K}\n` +
        `hit@1 ${hit1}/${n}   hit@3 ${hit3}/${n}   hit@${TOP_K} ${hitK}/${n}\n` +
        rows.join('\n'),
    );
    // Regression floor, not a target: set just below the measured result.
    expect(hitK / n).toBeGreaterThanOrEqual(0.85);
  });
});
