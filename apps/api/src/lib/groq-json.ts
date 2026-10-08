import type { ZodType } from 'zod';

/** Thrown when a Groq completion can't be turned into a usable response at all —
 * distinct from a generic route failure so callers can respond with a 502 instead of
 * a 500, and so it's obvious in logs that the model (not our code) is at fault. */
export class GroqResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroqResponseError';
  }
}

/**
 * Groq's structured-output prompts ask for raw JSON but models occasionally wrap the
 * response in a markdown code fence anyway — strip that before parsing. Shared by
 * every route that requests JSON from the model (explain-repo, explain-file, analyze)
 * so the cleanup logic can't drift between call sites.
 *
 * When a `schema` is passed, the parsed JSON is validated against it before being
 * returned. Every output schema in `output-schemas.ts` gives each field a `.catch()`
 * fallback, so an individual missing/malformed field degrades to a safe default
 * instead of failing the request — `GroqResponseError` is only thrown when the
 * response isn't usable at all (not valid JSON, or not even an object).
 */
export function parseJsonCompletion<T>(raw: string, schema?: ZodType<T>, options: { required?: (keyof T)[] } = {}): T {
  const json = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new GroqResponseError('Model response was not valid JSON');
  }

  if (!schema) return parsed as T;

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new GroqResponseError('Model response did not match the expected shape');
  }
  // Field-level .catch() fallbacks would otherwise turn a reply like `{}` into an
  // all-empty "successful" result. The core fields must carry real content.
  for (const key of options.required ?? []) {
    const value = (result.data as Record<string, unknown>)[key as string];
    const isEmpty = value == null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
    if (isEmpty) throw new GroqResponseError(`Model response was missing "${String(key)}"`);
  }
  return result.data;
}
