import { API_PORT_NAME, type ApiRelayResponse } from '../background/api-relay';

/** A failed API call, with the server's structured error code when there was one, or a
 * client-side code (API_UNREACHABLE, CLIENT_TIMEOUT, BAD_RESPONSE) when there wasn't. */
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface UiError {
  message: string;
  /** Whether a Retry button makes sense (false for e.g. private repositories). */
  retryable: boolean;
  code: string;
}

const NOT_RETRYABLE = new Set([
  'PRIVATE_REPO_UNSUPPORTED',
  'REPO_NOT_FOUND',
  'REF_NOT_FOUND',
  'FILE_NOT_FOUND',
  'FILE_NOT_TEXT',
  'ISSUE_NOT_FOUND',
  'NOT_INDEXABLE',
  'INVALID_REQUEST',
  'FORBIDDEN_ORIGIN',
  'DAILY_BUDGET_EXHAUSTED',
]);

function waitHint(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return '';
  if (seconds < 90) return ` Try again in about ${Math.ceil(seconds)} seconds.`;
  if (seconds < 2 * 3600) return ` Try again in about ${Math.ceil(seconds / 60)} minutes.`;
  return ` Try again in about ${Math.round(seconds / 3600)} hours.`;
}

/** A clear, user-facing message for any failure. */
export function toUiError(err: unknown): UiError {
  if (!(err instanceof ApiClientError)) {
    return { code: 'UNKNOWN', message: 'Something went wrong. Please try again.', retryable: true };
  }
  const retryable = !NOT_RETRYABLE.has(err.code);
  switch (err.code) {
    case 'PRIVATE_REPO_UNSUPPORTED':
    case 'REPO_NOT_FOUND':
      return {
        code: err.code,
        retryable,
        message: 'GitGuide works with public GitHub repositories only. This repository is private, or GitHub could not find it.',
      };
    case 'API_UNREACHABLE':
      return {
        code: err.code,
        retryable,
        message: "Couldn't reach the GitGuide server. Check your connection. If the server was idle, it can take up to a minute to start.",
      };
    case 'EXTENSION_RELOADED':
      return { code: err.code, retryable: false, message: err.message };
    case 'CLIENT_TIMEOUT':
      return { code: err.code, retryable, message: 'The GitGuide server took too long to respond. Please try again.' };
    case 'BAD_RESPONSE':
      return { code: err.code, retryable, message: 'The GitGuide server sent a response this version of the extension could not read.' };
    case 'RATE_LIMITED':
    case 'GITHUB_RATE_LIMITED':
    case 'AI_RATE_LIMITED':
    case 'SERVER_BUSY':
    case 'DAILY_BUDGET_EXHAUSTED':
      return { code: err.code, retryable, message: err.message.replace(/ Please try again.*$/, '') + waitHint(err.retryAfterSec) };
    default:
      return { code: err.code, retryable, message: err.message || 'Something went wrong. Please try again.' };
  }
}

/** Builds an ApiClientError from a non-OK response, using the server's JSON error body. */
export async function errorFromResponse(res: Response): Promise<ApiClientError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON (e.g. a proxy error page) — fall through to a generic error.
  }
  const b = (body ?? {}) as { code?: unknown; error?: unknown; retryAfterSec?: unknown };
  const headerRetry = Number(res.headers.get('retry-after'));
  const retryAfter = typeof b.retryAfterSec === 'number' ? b.retryAfterSec : Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : null;
  const code = typeof b.code === 'string' ? b.code : res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
  const message = typeof b.error === 'string' ? b.error : `The GitGuide server returned an error (HTTP ${res.status}).`;
  return new ApiClientError(code, message, res.status, retryAfter);
}

/** POSTs JSON to the GitGuide API through the service worker (see
 * background/api-relay.ts). Aborting `signal` disconnects the port, which aborts the
 * request. Throws ApiClientError on every failure; rethrows the abort reason if the
 * caller aborted, so callers can ignore it. */
export function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: API_PORT_NAME });
    } catch {
      // The extension was updated or reloaded underneath this page.
      reject(new ApiClientError('EXTENSION_RELOADED', 'GitGuide was updated. Reload this page to keep using it.'));
      return;
    }
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
      fn();
    };
    const onAbort = () => settle(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')));
    signal?.addEventListener('abort', onAbort, { once: true });

    port.onMessage.addListener((msg: ApiRelayResponse) => {
      settle(() => {
        handleRelayResponse(msg).then(resolve, reject);
      });
    });
    // The worker went away without answering (crash, extension update).
    port.onDisconnect.addListener(() => settle(() => reject(new ApiClientError('API_UNREACHABLE', 'Relay disconnected'))));
    port.postMessage({ path, body });
  });
}

async function handleRelayResponse(msg: ApiRelayResponse): Promise<unknown> {
  if (!msg || typeof msg !== 'object') throw new ApiClientError('BAD_RESPONSE', 'Malformed relay message');
  if (msg.kind === 'network-error') throw new ApiClientError('API_UNREACHABLE', 'Network error');
  if (msg.kind === 'timeout') throw new ApiClientError('CLIENT_TIMEOUT', 'Timed out');
  if (msg.kind === 'refused') throw new ApiClientError('INVALID_REQUEST', 'This request is not allowed.');
  const headers = msg.retryAfter ? { 'retry-after': msg.retryAfter } : undefined;
  const res = new Response(msg.body, { status: msg.status, headers });
  if (!res.ok) throw await errorFromResponse(res);
  try {
    return JSON.parse(msg.body);
  } catch {
    throw new ApiClientError('BAD_RESPONSE', 'Response was not JSON', msg.status);
  }
}
