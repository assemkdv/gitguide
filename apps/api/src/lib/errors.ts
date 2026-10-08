import type { Response } from 'express';
import Groq from 'groq-sdk';
import { GroqResponseError } from './groq-json';

// One error vocabulary for every route, so the extension can show a specific, useful
// message (and know whether retrying makes sense) instead of a generic "server error".
// Response shape: { error: <human message>, code: <ErrorCode>, retryAfterSec?: number }.
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'FORBIDDEN_ORIGIN'
  | 'RATE_LIMITED'
  | 'REPO_NOT_FOUND'
  | 'PRIVATE_REPO_UNSUPPORTED'
  | 'REF_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'FILE_NOT_TEXT'
  | 'ISSUE_NOT_FOUND'
  | 'NOT_INDEXABLE'
  | 'GITHUB_RATE_LIMITED'
  | 'GITHUB_UNAVAILABLE'
  | 'AI_RATE_LIMITED'
  | 'AI_MALFORMED'
  | 'AI_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'SERVER_BUSY'
  | 'DAILY_BUDGET_EXHAUSTED'
  | 'SHUTTING_DOWN'
  | 'INTERNAL';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorBody {
  error: string;
  code: ErrorCode;
  retryAfterSec?: number;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Maps anything thrown inside a route to a structured ApiError. Unknown errors become
 * INTERNAL without leaking their message (it may contain upstream URLs or internals). */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof GroqResponseError) {
    return new ApiError('AI_MALFORMED', 502, 'The AI returned a response GitGuide could not read. Please try again.');
  }
  // Subclass checks must come before the generic APIError branch below: both of these
  // extend APIError. A user-abort here means our own deadline signal fired.
  if (err instanceof Groq.APIConnectionTimeoutError || err instanceof Groq.APIUserAbortError) {
    return new ApiError('UPSTREAM_TIMEOUT', 504, 'The AI provider took too long to respond. Please try again.');
  }
  if (err instanceof Groq.APIError) {
    if (err.status === 429) {
      const retryAfter = Number(err.headers?.['retry-after']);
      return new ApiError(
        'AI_RATE_LIMITED',
        429,
        'The AI provider is rate-limiting GitGuide right now. Please wait a moment and try again.',
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 30,
      );
    }
    return new ApiError('AI_UNAVAILABLE', 502, 'The AI provider is unavailable right now. Please try again shortly.');
  }
  if (isAbortError(err)) {
    return new ApiError('UPSTREAM_TIMEOUT', 504, 'An upstream service took too long to respond. Please try again.');
  }
  return new ApiError('INTERNAL', 500, 'Something went wrong on the GitGuide server.');
}

export function errorBody(err: ApiError): ErrorBody {
  return {
    error: err.message,
    code: err.code,
    ...(err.retryAfterSec != null ? { retryAfterSec: err.retryAfterSec } : {}),
  };
}

/** Logs (without user content) and sends a structured JSON error, unless the client is
 * already gone. `route` is a short static label for logs. */
export function sendError(res: Response, err: unknown, route: string): void {
  const apiError = toApiError(err);
  logRouteError(route, err, apiError);
  if (res.headersSent || res.writableEnded) return;
  if (apiError.retryAfterSec != null) res.setHeader('Retry-After', String(apiError.retryAfterSec));
  res.status(apiError.status).json(errorBody(apiError));
}

/** Non-sensitive diagnostics for an upstream failure: the provider's HTTP status and
 * machine-readable error type/code (e.g. "invalid_api_key", "model_decommissioned"). */
function upstreamDetail(err: unknown): Record<string, unknown> {
  if (err instanceof Groq.APIError) {
    const body = (err.error ?? {}) as { error?: { type?: unknown; code?: unknown }; type?: unknown; code?: unknown };
    const inner = body.error ?? body;
    return {
      upstream: 'groq',
      upstreamStatus: err.status,
      upstreamType: typeof inner.type === 'string' ? inner.type : undefined,
      upstreamCode: typeof inner.code === 'string' ? inner.code : undefined,
    };
  }
  return {};
}

export function logRouteError(route: string, original: unknown, apiError: ApiError): void {
  // Only error classes, codes and statuses are logged — never request bodies, questions,
  // file contents, or upstream response messages.
  const cause = original instanceof ApiError ? undefined : original instanceof Error ? original.name : typeof original;
  const level = apiError.status >= 500 ? 'error' : 'warn';
  console[level](JSON.stringify({ level, msg: 'route_error', route, code: apiError.code, status: apiError.status, cause, ...upstreamDetail(original) }));
}
