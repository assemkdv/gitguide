// Lazy/progressive indexing: a small "priority" subset of the repo (README, docs,
// manifests, likely routing/entrypoint files, and files matching keywords from the
// user's question) is fetched, chunked, and embedded synchronously — fast enough to
// answer the first question in a few seconds — while the rest of the repo (up to
// MAX_INDEXED_FILES) continues indexing in the background afterward. Both phases write
// into the same store entry, so retrieval automatically benefits from Phase B's results
// on the next question without any client action.
import { getBranchHeadSha, getFileContent } from './github';
import { isIndexableFile } from './ignore-list';
import { generateRepoSummary, RepoSummaryFields } from './repo-summary';
import { chunkFile, Chunk } from './chunking';
import { tokenize, BM25Index } from './bm25';
import { embedTexts } from './embeddings';
import { VectorStore, InMemoryVectorStore, ChunkRecord } from './vector-store';

export const MAX_INDEXED_FILES = 200;
export const PRIORITY_FILE_CAP = 30;
const MAX_DOC_FILES = 10;
const FETCH_CONCURRENCY = 10;
const EMBED_BATCH_SIZE = 100;
const BACKGROUND_BATCH_SIZE = 20;

export type IndexStatus = 'partial' | 'background-indexing' | 'complete';

export interface RepoIndexEntry {
  sha: string;
  chunks: ChunkRecord[];
  bm25: BM25Index;
  summary: RepoSummaryFields | null;
  status: IndexStatus;
  /** Internal bookkeeping for Phase B — files not yet indexed, computed once after
   * Phase A so the background continuation doesn't need to re-fetch/re-filter the tree. */
  remainingFiles: string[];
}

const MANIFEST_FILENAMES = new Set([
  'package.json', 'go.mod', 'cargo.toml', 'pyproject.toml', 'requirements.txt',
  'gemfile', 'composer.json', 'pipfile', 'dockerfile',
]);
const ROUTING_KEYWORDS = ['route', 'router', 'api', 'server', 'main', 'index', 'app', 'controller', 'handler'];

/** Pure — picks a small, high-value subset of an already-filtered file list to index
 * first. Not exhaustive by design; Phase B covers the rest. */
export function selectPriorityFiles(indexableTree: string[], question: string): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (seen.has(path) || selected.length >= PRIORITY_FILE_CAP) return;
    seen.add(path);
    selected.push(path);
  };

  for (const path of indexableTree) {
    if (/^readme(\.|$)/i.test(path.split('/').pop() ?? '')) add(path);
  }

  let docCount = 0;
  for (const path of indexableTree) {
    if (docCount >= MAX_DOC_FILES) break;
    if (/^docs\//i.test(path)) {
      add(path);
      docCount++;
    }
  }

  for (const path of indexableTree) {
    const filename = (path.split('/').pop() ?? '').toLowerCase();
    if (MANIFEST_FILENAMES.has(filename) || /\.config\.(js|ts)$/i.test(filename)) add(path);
  }

  for (const path of indexableTree) {
    const lower = path.toLowerCase();
    if (ROUTING_KEYWORDS.some((keyword) => lower.includes(keyword))) add(path);
  }

  // Bidirectional containment (not just "path contains the full question word") so a
  // question token like "authentication" still matches a path segment like "auth".
  const questionTokens = tokenize(question).filter((token) => token.length >= 3);
  for (const path of indexableTree) {
    const pathWords = tokenize(path);
    const matches = questionTokens.some((qt) => pathWords.some((pw) => qt.includes(pw) || pw.includes(qt)));
    if (matches) add(path);
  }

  return selected.slice(0, PRIORITY_FILE_CAP);
}

async function fetchFilesBounded(
  owner: string,
  repoName: string,
  ref: string,
  filePaths: string[],
  signal?: AbortSignal,
): Promise<{ path: string; content: string }[]> {
  const results: { path: string; content: string }[] = [];
  for (let i = 0; i < filePaths.length; i += FETCH_CONCURRENCY) {
    if (signal?.aborted) break;
    const batch = filePaths.slice(i, i + FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (path) => ({ path, content: await getFileContent(owner, repoName, ref, path, signal) })),
    );
    results.push(...batchResults);
  }
  return results;
}

async function embedChunks(
  chunks: Chunk[],
  owner: string,
  repoName: string,
  sha: string,
  signal?: AbortSignal,
): Promise<ChunkRecord[]> {
  const records: ChunkRecord[] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedTexts(batch.map((chunk) => chunk.text));
    for (let j = 0; j < batch.length; j++) {
      const embedding = embeddings[j];
      if (!embedding) continue; // defensive — should always match batch length 1:1
      const chunk = batch[j];
      records.push({
        id: `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`,
        repoOwner: owner,
        repoName,
        sha,
        filePath: chunk.filePath,
        language: chunk.language,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        embedding,
      });
    }
  }
  return records;
}

async function indexFiles(
  owner: string,
  repoName: string,
  ref: string,
  sha: string,
  filePaths: string[],
  signal?: AbortSignal,
): Promise<ChunkRecord[]> {
  if (filePaths.length === 0) return [];
  const fetched = await fetchFilesBounded(owner, repoName, ref, filePaths, signal);
  const chunks = fetched.flatMap(({ path, content }) => chunkFile(path, content));
  if (chunks.length === 0) return [];
  return embedChunks(chunks, owner, repoName, sha, signal);
}

function buildBm25(chunks: ChunkRecord[]): BM25Index {
  return new BM25Index(chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })));
}

async function buildPriorityIndex(
  owner: string,
  repoName: string,
  ref: string,
  sha: string,
  question: string,
  signal?: AbortSignal,
): Promise<RepoIndexEntry> {
  const { tree, summary } = await generateRepoSummary(owner, repoName, ref, signal);
  const indexableTree = tree.filter(isIndexableFile);
  const priorityFiles = selectPriorityFiles(indexableTree, question);

  const chunks = await indexFiles(owner, repoName, ref, sha, priorityFiles, signal);

  const prioritySet = new Set(priorityFiles);
  const remainingFiles = indexableTree
    .filter((path) => !prioritySet.has(path))
    .slice(0, Math.max(0, MAX_INDEXED_FILES - priorityFiles.length));

  // A repo with nothing indexable at all (empty/fully-filtered tree) has no Phase B to
  // run — mark it 'complete' immediately so the route can distinguish "genuinely empty"
  // from "still indexing" and respond accordingly, rather than answering ungrounded.
  const status: IndexStatus = indexableTree.length === 0 || remainingFiles.length === 0 ? 'complete' : 'partial';

  return { sha, chunks, bm25: buildBm25(chunks), summary, status, remainingFiles };
}

async function continueBackgroundIndexing(
  owner: string,
  repoName: string,
  ref: string,
  key: string,
  store: VectorStore<RepoIndexEntry>,
  backgroundRunning: Set<string>,
): Promise<void> {
  if (backgroundRunning.has(key)) return;
  backgroundRunning.add(key);
  try {
    const entry = store.get(key);
    if (!entry || entry.status !== 'partial') return;
    entry.status = 'background-indexing';

    const remaining = entry.remainingFiles;
    for (let i = 0; i < remaining.length; i += BACKGROUND_BATCH_SIZE) {
      const batch = remaining.slice(i, i + BACKGROUND_BATCH_SIZE);
      // No AbortSignal here deliberately: Phase B is detached background work that
      // outlives the single HTTP request that triggered it (the request's own
      // AbortController fires on res.close, which happens the moment that request's SSE
      // stream ends — using the same signal would abort Phase B before it even starts).
      const newChunks = await indexFiles(owner, repoName, ref, entry.sha, batch, undefined);
      if (newChunks.length > 0) {
        entry.chunks.push(...newChunks);
        entry.bm25 = buildBm25(entry.chunks);
      }
      store.set(key, entry); // refresh LRU recency while background work is active
    }

    entry.status = 'complete';
    entry.remainingFiles = [];
    store.set(key, entry);
  } finally {
    backgroundRunning.delete(key);
  }
}

export interface Indexer {
  ensureIndexed(owner: string, repoName: string, ref: string, question: string, signal?: AbortSignal): Promise<RepoIndexEntry>;
}

export function createIndexer(store: VectorStore<RepoIndexEntry> = new InMemoryVectorStore()): Indexer {
  const inFlightPhaseA = new Map<string, Promise<RepoIndexEntry>>();
  const backgroundRunning = new Set<string>();

  async function ensureIndexed(
    owner: string,
    repoName: string,
    ref: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<RepoIndexEntry> {
    const sha = await getBranchHeadSha(owner, repoName, ref, signal);
    const key = `${owner}/${repoName}@${sha}`;

    const existing = store.get(key);
    if (existing) return existing;

    const inFlight = inFlightPhaseA.get(key);
    if (inFlight) return inFlight;

    const buildPromise = buildPriorityIndex(owner, repoName, ref, sha, question, signal)
      .then((entry) => {
        store.set(key, entry);
        inFlightPhaseA.delete(key);
        if (entry.status === 'partial') {
          continueBackgroundIndexing(owner, repoName, ref, key, store, backgroundRunning).catch((err) => {
            console.error(`Background indexing failed for ${key}:`, err);
          });
        }
        return entry;
      })
      .catch((err) => {
        inFlightPhaseA.delete(key);
        throw err;
      });

    inFlightPhaseA.set(key, buildPromise);
    return buildPromise;
  }

  return { ensureIndexed };
}

const defaultIndexer = createIndexer();
export const ensureIndexed = defaultIndexer.ensureIndexed;
