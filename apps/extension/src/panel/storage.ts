import type { AnalysisResult, ChatMessage, ExplainFileResult, ExplainRepoResult, GoodFirstIssueItem } from './store';

const REPO_CACHE_TTL_MS = 30 * 60 * 1000;
const TARGET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY_PREFIX = 'cache:';

interface CacheEntry<T> {
  data: T;
  savedAt: number;
  expiresAt: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadCache<T>(key: string): Promise<T | null> {
  try {
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    // Defend against a corrupted/partial write (e.g. interrupted by an extension
    // update) — treat anything that doesn't look like a real cache entry as a miss
    // rather than handing malformed data to a component that expects a full schema.
    if (!isPlainObject(entry) || typeof entry.expiresAt !== 'number' || entry.data == null) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry.data as T;
  } catch {
    return null;
  }
}

async function saveCache<T>(key: string, data: T, ttlMs: number): Promise<void> {
  const now = Date.now();
  const entry: CacheEntry<T> = { data, savedAt: now, expiresAt: now + ttlMs };
  await chrome.storage.local.set({ [key]: entry });
}

export function loadRepoCache(repoKey: string): Promise<ExplainRepoResult | null> {
  return loadCache(`${CACHE_KEY_PREFIX}repo:${repoKey}`);
}

export function saveRepoCache(repoKey: string, data: ExplainRepoResult): Promise<void> {
  return saveCache(`${CACHE_KEY_PREFIX}repo:${repoKey}`, data, REPO_CACHE_TTL_MS);
}

// Scoped by repo + ref + path (not just repo + path) — the same file path can hold
// different content on different branches/commits, so the ref has to be part of the
// key or a cached explanation from one branch could be served for another.
export function loadFileCache(repoKey: string, ref: string, filePath: string): Promise<ExplainFileResult | null> {
  return loadCache(`${CACHE_KEY_PREFIX}file:${repoKey}:${ref}:${filePath}`);
}

export function saveFileCache(repoKey: string, ref: string, filePath: string, data: ExplainFileResult): Promise<void> {
  return saveCache(`${CACHE_KEY_PREFIX}file:${repoKey}:${ref}:${filePath}`, data, TARGET_CACHE_TTL_MS);
}

export function loadIssueCache(repoKey: string, issueNumber: number): Promise<AnalysisResult | null> {
  return loadCache(`${CACHE_KEY_PREFIX}issue:${repoKey}:${issueNumber}`);
}

export function saveIssueCache(repoKey: string, issueNumber: number, data: AnalysisResult): Promise<void> {
  return saveCache(`${CACHE_KEY_PREFIX}issue:${repoKey}:${issueNumber}`, data, TARGET_CACHE_TTL_MS);
}

export function loadGoodFirstIssuesCache(repoKey: string): Promise<GoodFirstIssueItem[] | null> {
  return loadCache(`${CACHE_KEY_PREFIX}good-first-issues:${repoKey}`);
}

export function saveGoodFirstIssuesCache(repoKey: string, data: GoodFirstIssueItem[]): Promise<void> {
  return saveCache(`${CACHE_KEY_PREFIX}good-first-issues:${repoKey}`, data, REPO_CACHE_TTL_MS);
}

// Sweeps expired cache:* entries (not chat:* — chat history has no TTL, it persists
// until the user explicitly clears it) so storage.local doesn't grow unbounded as
// someone browses more files/issues/repos over time. Cheap to call opportunistically;
// old-format entries from before the expiresAt field existed are swept too since they
// fail the isPlainObject/expiresAt shape check on next read and are simply never
// re-written — this call just reclaims their space proactively.
export async function pruneExpiredCache(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const stale = Object.entries(all)
      .filter(([key, value]) => {
        if (!key.startsWith(CACHE_KEY_PREFIX)) return false;
        if (!isPlainObject(value)) return true; // unrecognized shape — safe to drop
        return typeof value.expiresAt !== 'number' || now > value.expiresAt;
      })
      .map(([key]) => key);
    if (stale.length > 0) await chrome.storage.local.remove(stale);
  } catch {
    // Best-effort cleanup — a failure here shouldn't affect the rest of the extension.
  }
}

// No TTL — chat history persists until the user explicitly clears it, under its own
// key prefix so it doesn't get swept by pruneExpiredCache (which only touches cache:*).
export async function loadRepoChatMessages(repoKey: string): Promise<ChatMessage[]> {
  const key = `chat:${repoKey}`;
  const result = await chrome.storage.local.get(key);
  const messages = result[key];
  return Array.isArray(messages) ? (messages as ChatMessage[]) : [];
}

export async function saveRepoChatMessages(repoKey: string, messages: ChatMessage[]): Promise<void> {
  const key = `chat:${repoKey}`;
  await chrome.storage.local.set({ [key]: messages });
}

export async function clearRepoChatMessages(repoKey: string): Promise<void> {
  const key = `chat:${repoKey}`;
  await chrome.storage.local.remove(key);
}
