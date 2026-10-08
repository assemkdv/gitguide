import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock, ChromeMock } from '../test/chrome-mock';
import {
  cacheKeys,
  clearAllHistoryAndCaches,
  fingerprint,
  loadCached,
  loadConsent,
  loadPanelWidth,
  loadRepoChatMessages,
  pruneExpiredCache,
  sanitizePanelWidth,
  saveCached,
  saveConsent,
  saveRepoChatMessages,
  MAX_STORED_MESSAGES,
  DEFAULT_PANEL_WIDTH,
} from './storage';
import { normalizeFileResult } from './validate';

let chrome: ChromeMock;
beforeEach(() => {
  chrome = installChromeMock();
});

const result = (purpose: string) => ({ purpose, relatedFiles: [] });

describe('cache scoping and lifecycle', () => {
  it('scopes file entries by repo + ref + path', async () => {
    await saveCached(cacheKeys.file('o', 'r', 'main', 'a.ts'), result('main'), 60_000);
    expect(await loadCached(cacheKeys.file('o', 'r', 'dev', 'a.ts'), normalizeFileResult)).toBeNull();
    expect(await loadCached(cacheKeys.file('o', 'other', 'main', 'a.ts'), normalizeFileResult)).toBeNull();
    expect((await loadCached(cacheKeys.file('o', 'r', 'main', 'a.ts'), normalizeFileResult))?.purpose).toBe('main');
  });

  it('treats owner/repo case-insensitively (GitHub does)', () => {
    expect(cacheKeys.repo('Owner', 'Repo')).toBe(cacheKeys.repo('owner', 'repo'));
  });

  it('treats an expired entry as a miss', async () => {
    chrome.store[cacheKeys.repo('o', 'r')] = { data: { purpose: 'x' }, savedAt: 0, expiresAt: Date.now() - 1 };
    expect(await loadCached(cacheKeys.repo('o', 'r'), normalizeFileResult)).toBeNull();
  });

  it('treats malformed entries and malformed data as a miss', async () => {
    chrome.store['cache:v2:a'] = 'garbage';
    chrome.store['cache:v2:b'] = { data: { purpose: 42 }, expiresAt: Date.now() + 1000 };
    expect(await loadCached('cache:v2:a', normalizeFileResult)).toBeNull();
    expect(await loadCached('cache:v2:b', normalizeFileResult)).toBeNull();
  });

  it('invalidates when the content fingerprint differs', async () => {
    await saveCached('cache:v2:f', result('old'), 60_000, fingerprint('v1'));
    expect(await loadCached('cache:v2:f', normalizeFileResult, fingerprint('v2'))).toBeNull();
    expect(await loadCached('cache:v2:f', normalizeFileResult, fingerprint('v1'))).not.toBeNull();
  });

  it('prunes expired and pre-v2 cache entries, leaving chats, settings, and fresh entries', async () => {
    chrome.store['cache:v2:fresh'] = { data: 1, savedAt: 1, expiresAt: Date.now() + 60_000 };
    chrome.store['cache:v2:old'] = { data: 1, savedAt: 1, expiresAt: Date.now() - 1 };
    chrome.store['cache:repo:o/r'] = { data: 1, expiresAt: Date.now() + 60_000 };
    chrome.store['chat:v2:o/r'] = { messages: [] };
    chrome.store['settings:panelWidth'] = 400;
    await pruneExpiredCache();
    expect(Object.keys(chrome.store).sort()).toEqual(['cache:v2:fresh', 'chat:v2:o/r', 'settings:panelWidth']);
  });

  it('frees space and retries once on a quota error; never throws', async () => {
    chrome.store['cache:v2:oldest'] = { data: 1, savedAt: 1, expiresAt: Date.now() + 60_000 };
    let failures = 1;
    const realSet = (globalThis as any).chrome.storage.local.set;
    (globalThis as any).chrome.storage.local.set = async (items: Record<string, unknown>) => {
      if (failures-- > 0) throw new Error('QUOTA_BYTES quota exceeded');
      return realSet(items);
    };
    expect(await saveCached('cache:v2:new', result('n'), 60_000)).toBe(true);
    expect(chrome.store['cache:v2:oldest']).toBeUndefined();

    chrome.failSetWith = new Error('QUOTA_BYTES quota exceeded');
    (globalThis as any).chrome.storage.local.set = realSet;
    await expect(saveCached('cache:v2:x', result('x'), 60_000)).resolves.toBe(false);
  });
});

describe('chat history storage', () => {
  it('round-trips messages and caps how many are stored', async () => {
    const messages = Array.from({ length: MAX_STORED_MESSAGES + 5 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, content: `m${i}` }));
    expect(await saveRepoChatMessages('o/r', messages)).toBe(true);
    const loaded = await loadRepoChatMessages('o/r');
    expect(loaded.ok).toBe(true);
    expect(loaded.messages).toHaveLength(MAX_STORED_MESSAGES);
    expect(loaded.messages[0].content).toBe('m5');
  });

  it('migrates the pre-v2 array format and marks a mid-stream message as interrupted', async () => {
    chrome.store['chat:o/r'] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'half', status: 'streaming' },
    ];
    const { messages } = await loadRepoChatMessages('o/r');
    expect(messages.map((m) => m.status)).toEqual([undefined, 'interrupted']);
    expect(messages.every((m) => m.id)).toBe(true);
  });

  it('returns no messages for a non-array value', async () => {
    chrome.store['chat:v2:o/r'] = { messages: 'nope' };
    expect((await loadRepoChatMessages('o/r')).messages).toEqual([]);
  });

  it('clearAllHistoryAndCaches removes chats and caches but keeps settings', async () => {
    chrome.store['chat:v2:o/r'] = { messages: [] };
    chrome.store['chat:o/legacy'] = [];
    chrome.store['cache:v2:x'] = {};
    chrome.store['settings:dataNotice'] = { version: 1 };
    expect(await clearAllHistoryAndCaches()).toBe(true);
    expect(Object.keys(chrome.store)).toEqual(['settings:dataNotice']);
  });
});

describe('settings', () => {
  it('stores data-notice acknowledgement by version', async () => {
    expect(await loadConsent()).toBe(false);
    await saveConsent();
    expect(await loadConsent()).toBe(true);
    chrome.store['settings:dataNotice'] = { version: 0 };
    expect(await loadConsent()).toBe(false);
  });

  it.each([
    ['abc', DEFAULT_PANEL_WIDTH],
    [NaN, DEFAULT_PANEL_WIDTH],
    [{}, DEFAULT_PANEL_WIDTH],
    ['500', 500],
    [9999, 650],
    [-5, 320],
    [410.6, 411],
  ])('sanitizes a stored width of %s to %s', (raw, expected) => {
    expect(sanitizePanelWidth(raw)).toBe(expected);
  });

  it('never makes the panel wider than the viewport allows', () => {
    expect(sanitizePanelWidth(600, 500)).toBe(452);
    expect(sanitizePanelWidth(600, 200)).toBe(240);
  });

  it('loads a corrupted stored width as the default instead of NaN', async () => {
    chrome.store['settings:panelWidth'] = 'not a number';
    expect(await loadPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
  });
});
