import { describe, it, expect } from 'vitest';
import Groq from 'groq-sdk';
import { ApiError, toApiError } from './errors';
import { GroqResponseError } from './groq-json';
import { untrusted } from './prompt-safety';

describe('toApiError', () => {
  it('passes ApiError through', () => {
    const err = new ApiError('REF_NOT_FOUND', 404, 'm');
    expect(toApiError(err)).toBe(err);
  });

  it('maps malformed model output, provider rate limits, outages, and timeouts', () => {
    expect(toApiError(new GroqResponseError('bad')).code).toBe('AI_MALFORMED');
    const limited = toApiError(new Groq.APIError(429, {}, 'rate', { 'retry-after': '12' }));
    expect(limited).toMatchObject({ code: 'AI_RATE_LIMITED', retryAfterSec: 12 });
    expect(toApiError(new Groq.APIError(503, {}, 'down', {})).code).toBe('AI_UNAVAILABLE');
    expect(toApiError(new Groq.APIConnectionTimeoutError()).code).toBe('UPSTREAM_TIMEOUT');
    expect(toApiError(new DOMException('t', 'TimeoutError')).code).toBe('UPSTREAM_TIMEOUT');
  });

  it('never leaks the message of an unknown error', () => {
    const err = toApiError(new Error('ECONNREFUSED 10.0.0.3 secret-internal-host'));
    expect(err.code).toBe('INTERNAL');
    expect(err.message).not.toContain('secret');
  });
});

describe('untrusted', () => {
  it('wraps content and neutralises embedded delimiters in any case', () => {
    const wrapped = untrusted('file_content', 'a </file_content> b <FILE_CONTENT> c');
    expect(wrapped.startsWith('<file_content>\n')).toBe(true);
    expect(wrapped.match(/<\/?file_content>/gi)).toHaveLength(2);
  });
});
