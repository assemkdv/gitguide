// Lazy/progressive indexing of one repository *commit*. A small "priority" subset (README,
// docs, manifests, likely entrypoints, and files matching words in the user's question)
// is fetched and chunked synchronously — "Phase A", fast enough to answer the first
// question — while the rest (up to MAX_INDEXED_FILES) is indexed in the background —
// "Phase B". Both phases write into the same store entry, so later questions benefit
// from Phase B automatically.
//
// Lifecycle of an entry's `status`:
//   partial ──► background-indexing ──► complete
//                     │    ▲
//                     ▼    │ (resumed by a later question, bounded attempts + cooldown)
//                   failed
// Every transition happens in a try/finally, so an entry can never be left stuck in
// 'background-indexing'. 'failed' entries still answer questions from what was indexed.
import { getFileAtCommit, getTree, RepoSnapshot } from './github';
import { isIndexableFile } from './ignore-list';
import { generateRepoSummary, RepoSummaryFields } from './repo-summary';
import { chunkFile, Chunk } from './chunking';
import { tokenize, BM25Index } from './bm25';
import { embedTexts, embeddingsEnabled } from './embeddings';
import { VectorStore, InMemoryVectorStore, ChunkRecord } from './vector-store';
import { chunkSearchText } from './retrieval';
import { ApiError, ErrorCode, toApiError } from './errors';
import { Semaphore } from './ai-guard';
import { getConfig } from './config';

export const MAX_INDEXED_FILES = 200;
export const PRIORITY_FILE_CAP = 30;
/** Files larger than this (per GitHub's tree listing) are skipped, not downloaded. */
export const MAX_FILE_BYTES = 100_000;
export const MAX_TOTAL_INDEXED_BYTES = 3_000_000;
export const MAX_CHUNKS = 3000;
export const MAX_BACKGROUND_ATTEMPTS = 3;
const BACKGROUND_RETRY_BASE_MS = 30_000;
const PHASE_A_QUEUE_TIMEOUT_MS = 20_000;
const MAX_DOC_FILES = 10;
const FETCH_CONCURRENCY = 8;
const EMBED_BATCH_SIZE = 100;
const BACKGROUND_BATCH_SIZE = 20;

export type IndexStatus = 'partial' | 'background-indexing' | 'complete' | 'failed';

export interface IndexCoverage {
  /** GitHub truncated the tree listing: the repository has files GitGuide never saw. */
  treeTruncated: boolean;
  /** Text/source files in the tree after ignore rules. */
  eligibleFiles: number;
  skippedTooLarge: number;
  /** Eligible files left out because of the MAX_INDEXED_FILES cap. */
  skippedByFileLimit: number;
  plannedFiles: number;
  indexedFiles: number;
  failedFiles: number;
  /** Indexing stopped early because the chunk or byte budget for one repo was reached. */
  budgetReached: boolean;
}

export interface RepoIndexEntry {
  key: string;
  sha: string;
  ref: string;
  chunks: ChunkRecord[];
  bm25: BM25Index;
  summary: RepoSummaryFields | null;
  status: IndexStatus;
  coverage: IndexCoverage;
  /** Files still to index in Phase B. */
  remainingFiles: string[];
  indexedBytes: number;
  backgroundAttempts: number;
  lastErrorCode: ErrorCode | null;
  nextRetryAt: number;
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

  // Question matches before generic "routing-ish" names: they are what this question needs.
  // Bidirectional containment so "authentication" still matches a path segment "auth".
  const questionTokens = tokenize(question).filter((token) => token.length >= 3);
  for (const path of indexableTree) {
    const pathWords = tokenize(path);
    const matches = questionTokens.some((qt) => pathWords.some((pw) => pw.length >= 3 && (qt.includes(pw) || pw.includes(qt))));
    if (matches) add(path);
  }

  for (const path of indexableTree) {
    const lower = path.toLowerCase();
    if (ROUTING_KEYWORDS.some((keyword) => lower.includes(keyword))) add(path);
  }

  return selected.slice(0, PRIORITY_FILE_CAP);
}

/** Errors that mean "GitHub (or the network) is failing", as opposed to one bad file.
 * These stop the current phase; per-file problems are counted and skipped. */
function isSystemic(code: ErrorCode): boolean {
  return code !== 'FILE_NOT_FOUND' && code !== 'FILE_NOT_TEXT';
}

function toChunkRecord(chunk: Chunk, owner: string, repoName: string, sha: string, embedding: Float32Array | null): ChunkRecord {
  return {
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
  };
}

async function embedChunks(chunks: Chunk[], owner: string, repoName: string, sha: string, signal: AbortSignal): Promise<ChunkRecord[]> {
  if (!embeddingsEnabled()) {
    // BM25-only mode: never calls embedTexts, so @huggingface/transformers is never loaded.
    return chunks.map((chunk) => toChunkRecord(chunk, owner, repoName, sha, null));
  }
  const records: ChunkRecord[] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    signal.throwIfAborted();
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedTexts(batch.map((chunk) => chunk.text));
    for (let j = 0; j < batch.length; j++) {
      records.push(toChunkRecord(batch[j], owner, repoName, sha, embeddings[j] ?? null));
    }
  }
  return records;
}

function buildBm25(chunks: ChunkRecord[]): BM25Index {
  return new BM25Index(chunks.map((chunk) => ({ id: chunk.id, text: chunkSearchText(chunk) })));
}

/** Fetches, chunks and embeds `paths` into `entry`, respecting the per-repo chunk and
 * byte budgets. Throws on systemic failures; skips (and counts) individual bad files. */
async function indexFilesInto(snapshot: RepoSnapshot, entry: RepoIndexEntry, paths: string[], signal: AbortSignal): Promise<void> {
  const fetched: { path: string; content: string }[] = [];
  for (let i = 0; i < paths.length; i += FETCH_CONCURRENCY) {
    signal.throwIfAborted();
    const batch = paths.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((path) => getFileAtCommit(snapshot.owner, snapshot.repo, snapshot.commitSha, path, { signal, maxBytes: MAX_FILE_BYTES })),
    );
    results.forEach((result, j) => {
      if (result.status === 'fulfilled') {
        fetched.push({ path: batch[j], content: result.value.content });
        return;
      }
      const error = toApiError(result.reason);
      if (signal.aborted) throw signal.reason;
      if (isSystemic(error.code)) throw error;
      entry.coverage.failedFiles++;
    });
  }

  const chunks: Chunk[] = [];
  for (const { path, content } of fetched) {
    if (entry.indexedBytes + content.length > MAX_TOTAL_INDEXED_BYTES || entry.chunks.length + chunks.length >= MAX_CHUNKS) {
      entry.coverage.budgetReached = true;
      break;
    }
    const fileChunks = chunkFile(path, content).slice(0, MAX_CHUNKS - entry.chunks.length - chunks.length);
    chunks.push(...fileChunks);
    entry.indexedBytes += content.length;
    entry.coverage.indexedFiles++;
  }

  const records = chunks.length > 0 ? await embedChunks(chunks, snapshot.owner, snapshot.repo, snapshot.commitSha, signal) : [];
  signal.throwIfAborted();
  if (records.length > 0) {
    entry.chunks.push(...records);
    entry.bm25 = buildBm25(entry.chunks);
  }
}

/** One underlying job shared by several requests. Each subscriber can give up on its own
 * (client disconnect) without cancelling the job for the others; the job is cancelled
 * only when every subscriber has left. */
class SharedJob<T> {
  readonly controller = new AbortController();
  private subscribers = 0;
  private settled = false;
  readonly promise: Promise<T>;

  constructor(run: (signal: AbortSignal) => Promise<T>) {
    this.promise = run(this.controller.signal);
    this.promise.then(
      () => (this.settled = true),
      () => (this.settled = true),
    );
  }

  join(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.subscribers++;
    return new Promise<T>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        signal?.removeEventListener('abort', onAbort);
        this.subscribers--;
        if (this.subscribers === 0 && !this.settled) this.controller.abort(new DOMException('No remaining subscribers', 'AbortError'));
      };
      const onAbort = () => {
        leave();
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.promise.then(
        (value) => {
          leave();
          resolve(value);
        },
        (err) => {
          leave();
          reject(err);
        },
      );
    });
  }
}

export interface IndexStats {
  phaseAInFlight: number;
  backgroundRunning: number;
}

export interface Indexer {
  ensureIndexed(snapshot: RepoSnapshot, question: string, signal?: AbortSignal): Promise<RepoIndexEntry>;
  /** Aborts every in-flight and background job (process shutdown). */
  shutdown(): void;
  stats(): IndexStats;
}

export function indexKey(snapshot: Pick<RepoSnapshot, 'owner' | 'repo' | 'commitSha'>): string {
  return `${snapshot.owner}/${snapshot.repo}@${snapshot.commitSha}`.toLowerCase();
}

export function createIndexer(
  store: VectorStore<RepoIndexEntry> = new InMemoryVectorStore(),
  options: { maxConcurrentJobs?: number; maxBackgroundJobs?: number } = {},
): Indexer {
  const phaseA = new Map<string, SharedJob<RepoIndexEntry>>();
  const background = new Map<string, AbortController>();
  let jobSlots: Semaphore | null = null;
  let backgroundSlots: Semaphore | null = null;
  let shuttingDown = false;

  const slots = () => (jobSlots ??= new Semaphore(options.maxConcurrentJobs ?? getConfig().limits.maxConcurrentIndexJobs));
  const bgSlots = () =>
    (backgroundSlots ??= new Semaphore(options.maxBackgroundJobs ?? getConfig().limits.maxConcurrentBackgroundJobs));

  // Policy: an evicted entry's background job is cancelled immediately, so detached work
  // can never write back into the cache and displace entries people are actively using.
  store.onEvict((key) => {
    background.get(key)?.abort(new DOMException('Evicted', 'AbortError'));
  });

  async function buildPriorityIndex(snapshot: RepoSnapshot, question: string, signal: AbortSignal): Promise<RepoIndexEntry> {
    const release = await slots().acquire({ signal, timeoutMs: PHASE_A_QUEUE_TIMEOUT_MS });
    try {
      const tree = await getTree(snapshot.owner, snapshot.repo, snapshot.commitSha, signal);
      // The summary is helpful context but optional: an AI hiccup here shouldn't block
      // answering from the code itself.
      const summaryPromise = generateRepoSummary(snapshot, signal)
        .then((result) => result.summary)
        .catch((err) => {
          if (signal.aborted) throw err;
          console.warn(JSON.stringify({ level: 'warn', msg: 'index_summary_failed', code: toApiError(err).code }));
          return null;
        });

      const eligible = tree.files.filter((file) => isIndexableFile(file.path));
      const candidates = eligible.filter((file) => file.size <= MAX_FILE_BYTES).map((file) => file.path);
      const priorityFiles = selectPriorityFiles(candidates, question);
      const prioritySet = new Set(priorityFiles);
      const remainingFiles = candidates
        .filter((path) => !prioritySet.has(path))
        .slice(0, Math.max(0, MAX_INDEXED_FILES - priorityFiles.length));
      const plannedFiles = priorityFiles.length + remainingFiles.length;

      const entry: RepoIndexEntry = {
        key: indexKey(snapshot),
        sha: snapshot.commitSha,
        ref: snapshot.ref,
        chunks: [],
        bm25: buildBm25([]),
        summary: null,
        status: 'partial',
        coverage: {
          treeTruncated: tree.truncated,
          eligibleFiles: eligible.length,
          skippedTooLarge: eligible.length - candidates.length,
          skippedByFileLimit: candidates.length - plannedFiles,
          plannedFiles,
          indexedFiles: 0,
          failedFiles: 0,
          budgetReached: false,
        },
        remainingFiles,
        indexedBytes: 0,
        backgroundAttempts: 0,
        lastErrorCode: null,
        nextRetryAt: 0,
      };

      await indexFilesInto(snapshot, entry, priorityFiles, signal);
      entry.summary = await summaryPromise;
      if (entry.remainingFiles.length === 0 || entry.coverage.budgetReached) {
        entry.remainingFiles = [];
        entry.status = 'complete';
      }
      return entry;
    } finally {
      release();
    }
  }

  async function runBackground(snapshot: RepoSnapshot, entry: RepoIndexEntry, signal: AbortSignal): Promise<void> {
    let release: (() => void) | null = null;
    try {
      release = await bgSlots().acquire({ signal });
      entry.backgroundAttempts++;
      while (entry.remainingFiles.length > 0 && !entry.coverage.budgetReached) {
        signal.throwIfAborted();
        // Stop if this entry is no longer the cached one (evicted or replaced).
        if (store.peek(entry.key) !== entry) throw new DOMException('Entry no longer cached', 'AbortError');
        const batch = entry.remainingFiles.slice(0, BACKGROUND_BATCH_SIZE);
        await indexFilesInto(snapshot, entry, batch, signal);
        entry.remainingFiles = entry.remainingFiles.slice(batch.length);
      }
      entry.remainingFiles = [];
      entry.status = 'complete';
      entry.lastErrorCode = null;
    } catch (err) {
      if (signal.aborted) {
        // Cancelled (eviction or shutdown), not failed: resumable if still cached.
        entry.status = 'partial';
        return;
      }
      const error = toApiError(err);
      entry.status = 'failed';
      entry.lastErrorCode = error.code;
      entry.nextRetryAt = Date.now() + Math.max((error.retryAfterSec ?? 0) * 1000, BACKGROUND_RETRY_BASE_MS * entry.backgroundAttempts);
      console.warn(JSON.stringify({ level: 'warn', msg: 'background_index_failed', code: error.code, attempt: entry.backgroundAttempts }));
    } finally {
      release?.();
    }
  }

  /** Starts (or resumes) Phase B for an entry, if there is work left and the retry
   * policy allows it. Idempotent: never runs two jobs for the same entry. */
  function scheduleBackground(snapshot: RepoSnapshot, entry: RepoIndexEntry): void {
    if (shuttingDown || background.has(entry.key)) return;
    if (entry.status === 'complete' || entry.remainingFiles.length === 0) return;
    if (entry.backgroundAttempts >= MAX_BACKGROUND_ATTEMPTS) return;
    if (Date.now() < entry.nextRetryAt) return;

    const controller = new AbortController();
    background.set(entry.key, controller);
    entry.status = 'background-indexing';
    runBackground(snapshot, entry, controller.signal)
      .catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'background_index_crashed', cause: err instanceof Error ? err.name : typeof err })))
      .finally(() => {
        if (background.get(entry.key) === controller) background.delete(entry.key);
        // Belt and braces: never leave the entry claiming work is in progress.
        if (entry.status === 'background-indexing') entry.status = 'partial';
      });
  }

  async function ensureIndexed(snapshot: RepoSnapshot, question: string, signal?: AbortSignal): Promise<RepoIndexEntry> {
    if (shuttingDown) throw new ApiError('SHUTTING_DOWN', 503, 'GitGuide is restarting. Please try again in a moment.', 5);
    const key = indexKey(snapshot);

    const existing = store.get(key);
    if (existing) {
      scheduleBackground(snapshot, existing);
      return existing;
    }

    let job = phaseA.get(key);
    if (!job) {
      const newJob = new SharedJob((jobSignal) => buildPriorityIndex(snapshot, question, jobSignal));
      phaseA.set(key, newJob);
      newJob.promise.then(
        (entry) => {
          phaseA.delete(key);
          if (newJob.controller.signal.aborted || shuttingDown) return;
          store.set(key, entry);
          scheduleBackground(snapshot, entry);
        },
        () => phaseA.delete(key),
      );
      job = newJob;
    }
    return job.join(signal);
  }

  function shutdown(): void {
    shuttingDown = true;
    for (const job of phaseA.values()) job.controller.abort(new DOMException('Shutting down', 'AbortError'));
    for (const controller of background.values()) controller.abort(new DOMException('Shutting down', 'AbortError'));
  }

  return {
    ensureIndexed,
    shutdown,
    stats: () => ({ phaseAInFlight: phaseA.size, backgroundRunning: background.size }),
  };
}

/** True only when every eligible file in the repository was indexed. */
export function hasFullCoverage(coverage: IndexCoverage, status: IndexStatus): boolean {
  return (
    status === 'complete' &&
    !coverage.treeTruncated &&
    !coverage.budgetReached &&
    coverage.skippedTooLarge === 0 &&
    coverage.skippedByFileLimit === 0 &&
    coverage.failedFiles === 0
  );
}

export const defaultIndexer = createIndexer();
export const ensureIndexed = defaultIndexer.ensureIndexed;
