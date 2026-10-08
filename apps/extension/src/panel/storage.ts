import type { ChatMessage } from './store';
import { isObject, normalizeChatMessage } from './validate';

// Everything GitGuide keeps lives in chrome.storage.local on this device:
//   cache:v2:*   cached explanations (expire; refreshable)
//   chat:v2:*    Ask GitGuide conversations, per repository (until the user clears them)
//   settings:*   panel width
// Reads are validated (data may be from an older version or a partial write) and writes
// never throw: a full storage quota must not lose an answer the user is looking at.

export const REPO_CACHE_TTL_MS = 30 * 60 * 1000;
export const TARGET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'cache:v2:';
const LEGACY_CACHE_PREFIX = 'cache:';
const CHAT_PREFIX = 'chat:v2:';
const LEGACY_CHAT_PREFIX = 'chat:';
/** Acknowledgement of the old blocking data notice; no longer used, removed on prune. */
const LEGACY_SETTINGS_CONSENT = 'settings:dataNotice';
const SETTINGS_WIDTH = 'settings:panelWidth';
export const MAX_STORED_MESSAGES = 60;

interface CacheEntry<T> {
  data: T;
  savedAt: number;
  expiresAt: number;
  /** Hash of the page content the result was produced for (file text / issue text). */
  fingerprint?: string;
}

/** Small, fast, non-cryptographic hash (FNV-1a) used only to notice changed content. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length.toString(36)}-${(hash >>> 0).toString(16)}`;
}

const lower = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

export const cacheKeys = {
  repo: (owner: string, repo: string) => `${CACHE_PREFIX}repo:${lower(owner, repo)}`,
  // Scoped by ref: the same path can hold different content on different branches.
  file: (owner: string, repo: string, ref: string, path: string) => `${CACHE_PREFIX}file:${lower(owner, repo)}@${ref}:${path}`,
  issue: (owner: string, repo: string, issueNumber: number) => `${CACHE_PREFIX}issue:${lower(owner, repo)}#${issueNumber}`,
  goodFirstIssues: (owner: string, repo: string) => `${CACHE_PREFIX}gfi:${lower(owner, repo)}`,
};

async function storageGet(keys: string | string[] | null): Promise<Record<string, unknown>> {
  try {
    return (await chrome.storage.local.get(keys)) ?? {};
  } catch {
    return {};
  }
}

function isQuotaError(err: unknown): boolean {
  return /quota/i.test(String((err as Error)?.message ?? err));
}

/** Writes, and on a quota error frees space (expired, then oldest cache entries) and
 * retries once. Returns false instead of throwing when the write still fails. */
async function storageSet(items: Record<string, unknown>): Promise<boolean> {
  try {
    await chrome.storage.local.set(items);
    return true;
  } catch (err) {
    if (!isQuotaError(err)) return false;
    await pruneExpiredCache();
    await evictOldestCache(0.5);
    try {
      await chrome.storage.local.set(items);
      return true;
    } catch {
      return false;
    }
  }
}

async function storageRemove(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await chrome.storage.local.remove(keys);
  } catch {
    // Best effort.
  }
}

/** A cached result, or null when missing, expired, malformed, or produced for different
 * content than `currentFingerprint` (when both are known). */
export async function loadCached<T>(
  key: string,
  normalize: (raw: unknown) => T | null,
  currentFingerprint?: string | null,
): Promise<T | null> {
  const entry = (await storageGet(key))[key];
  if (!isObject(entry) || typeof entry.expiresAt !== 'number' || Date.now() > entry.expiresAt) return null;
  if (currentFingerprint && typeof entry.fingerprint === 'string' && entry.fingerprint !== currentFingerprint) return null;
  return normalize(entry.data);
}

export function saveCached<T>(key: string, data: T, ttlMs: number, contentFingerprint?: string | null): Promise<boolean> {
  const now = Date.now();
  const entry: CacheEntry<T> = { data, savedAt: now, expiresAt: now + ttlMs };
  if (contentFingerprint) entry.fingerprint = contentFingerprint;
  return storageSet({ [key]: entry });
}

/** Removes expired cache entries and entries in formats from older versions. */
export async function pruneExpiredCache(): Promise<void> {
  const all = await storageGet(null);
  const now = Date.now();
  const stale = Object.entries(all)
    .filter(([key, value]) => {
      if (!key.startsWith(LEGACY_CACHE_PREFIX)) return false;
      if (!key.startsWith(CACHE_PREFIX)) return true; // pre-v2 format
      return !isObject(value) || typeof value.expiresAt !== 'number' || now > value.expiresAt;
    })
    .map(([key]) => key);
  if (LEGACY_SETTINGS_CONSENT in all) stale.push(LEGACY_SETTINGS_CONSENT);
  await storageRemove(stale);
}

/** Drops the oldest `fraction` of cached explanations (never chats or settings). */
export async function evictOldestCache(fraction: number): Promise<void> {
  const all = await storageGet(null);
  const entries = Object.entries(all)
    .filter(([key]) => key.startsWith(CACHE_PREFIX))
    .map(([key, value]) => ({ key, savedAt: isObject(value) && typeof value.savedAt === 'number' ? value.savedAt : 0 }))
    .sort((a, b) => a.savedAt - b.savedAt);
  await storageRemove(entries.slice(0, Math.ceil(entries.length * fraction)).map((e) => e.key));
}

// ---------------------------------------------------------------------------------------
// Chat history
// ---------------------------------------------------------------------------------------

const chatKey = (repoKey: string) => `${CHAT_PREFIX}${repoKey.toLowerCase()}`;
const legacyChatKey = (repoKey: string) => `${LEGACY_CHAT_PREFIX}${repoKey}`;

export async function loadRepoChatMessages(repoKey: string): Promise<{ messages: ChatMessage[]; ok: boolean }> {
  try {
    const result = await chrome.storage.local.get([chatKey(repoKey), legacyChatKey(repoKey)]);
    const stored = result[chatKey(repoKey)];
    const raw = isObject(stored) && Array.isArray(stored.messages) ? stored.messages : result[legacyChatKey(repoKey)];
    if (!Array.isArray(raw)) return { messages: [], ok: true };
    const messages = raw
      .map((m, i) => normalizeChatMessage(m, `restored-${i}`))
      .filter((m): m is ChatMessage => m !== null);
    return { messages, ok: true };
  } catch {
    return { messages: [], ok: false };
  }
}

/** Persists the most recent messages. Returns false (without throwing) if storage is
 * unavailable or full; the in-memory conversation is unaffected. */
export async function saveRepoChatMessages(repoKey: string, messages: ChatMessage[]): Promise<boolean> {
  const trimmed = messages.slice(-MAX_STORED_MESSAGES);
  const ok = await storageSet({ [chatKey(repoKey)]: { updatedAt: Date.now(), messages: trimmed } });
  if (ok) await storageRemove([legacyChatKey(repoKey)]);
  return ok;
}

export async function clearRepoChatMessages(repoKey: string): Promise<void> {
  await storageRemove([chatKey(repoKey), legacyChatKey(repoKey)]);
}

/** Deletes every conversation and cached explanation (keeps settings). */
export async function clearAllHistoryAndCaches(): Promise<boolean> {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => key.startsWith(LEGACY_CACHE_PREFIX) || key.startsWith(LEGACY_CHAT_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

export const MIN_PANEL_WIDTH = 320;
export const MAX_PANEL_WIDTH = 650;
export const DEFAULT_PANEL_WIDTH = 400;

/** Clamps a stored or dragged width into the allowed range and the current viewport.
 * Corrupted values (NaN, strings, objects) fall back to the default. */
export function sanitizePanelWidth(raw: unknown, viewportWidth = Infinity): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  const width = Number.isFinite(value) ? Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(value))) : DEFAULT_PANEL_WIDTH;
  // Never wider than the window minus room for the page edge and the launcher button.
  const viewportCap = Number.isFinite(viewportWidth) ? Math.max(240, viewportWidth - 48) : Infinity;
  return Math.min(width, viewportCap);
}

export async function loadPanelWidth(): Promise<number | null> {
  const value = (await storageGet(SETTINGS_WIDTH))[SETTINGS_WIDTH];
  return value == null ? null : sanitizePanelWidth(value);
}

export function savePanelWidth(width: number): Promise<boolean> {
  return storageSet({ [SETTINGS_WIDTH]: sanitizePanelWidth(width) });
}
