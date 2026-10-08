import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { installChromeMock } from '../test/chrome-mock';
import { ApiClientError, postJson, toUiError } from './api-client';

beforeEach(() => {
  installChromeMock();
});
afterEach(() => vi.unstubAllGlobals());

describe('postJson', () => {
  it('returns parsed JSON and never sends credentials', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postJson('/v1/explain-repo', { a: 1 })).resolves.toEqual({ ok: true });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].credentials).toBe('omit');
  });

  it('maps structured errors, network failures, and non-JSON bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope', code: 'REF_NOT_FOUND' }), { status: 404 })));
    await expect(postJson('/v1/explain-repo', {})).rejects.toMatchObject({ code: 'REF_NOT_FOUND', message: 'nope', status: 404 });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })));
    await expect(postJson('/v1/explain-repo', {})).rejects.toMatchObject({ code: 'SERVER_ERROR' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json')));
    await expect(postJson('/v1/explain-repo', {})).rejects.toMatchObject({ code: 'BAD_RESPONSE' });

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(postJson('/v1/explain-repo', {})).rejects.toMatchObject({ code: 'API_UNREACHABLE' });
  });

  it('cancels the relayed request when the caller aborts', async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }),
    );
    const controller = new AbortController();
    const pending = postJson('/v1/explain-repo', {}, controller.signal);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort(new DOMException('navigated away', 'AbortError'));
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSignal?.aborted).toBe(true);
  });

  it('only relays known API paths', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(postJson('/v1/ask-repo', {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a reloaded extension (orphaned content script) clearly', async () => {
    (globalThis as any).chrome.runtime.connect = () => {
      throw new Error('Extension context invalidated.');
    };
    await expect(postJson('/v1/explain-repo', {})).rejects.toMatchObject({ code: 'EXTENSION_RELOADED' });
  });
});

describe('toUiError', () => {
  it('explains the public-only policy without offering a pointless retry', () => {
    expect(toUiError(new ApiClientError('PRIVATE_REPO_UNSUPPORTED', 'x'))).toMatchObject({ retryable: false, message: expect.stringMatching(/public/) });
  });

  it('adds wait times for rate limits', () => {
    expect(toUiError(new ApiClientError('RATE_LIMITED', "You've hit GitGuide's request limit. Please wait a few minutes and try again.", 429, 120)).message).toMatch(
      /about 2 minutes/,
    );
  });

  it('mentions cold starts when the API is unreachable', () => {
    expect(toUiError(new ApiClientError('API_UNREACHABLE', '')).message).toMatch(/start/);
  });
});
