import { getGroqClient } from './groq-client';
import { getConfig } from './config';

// Model-specific request options. GPT-OSS models on Groq reason before answering; the
// reasoning is returned separately from `content` (so JSON parsing and streaming are
// unaffected) but counts toward max_tokens, so callers budget for it and keep the
// effort low for these short, structured tasks.
export function modelOptions(model: string): Record<string, unknown> {
  return model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {};
}

export type ModelCheck = { status: 'ok' } | { status: 'missing'; missing: string[] } | { status: 'unknown' };

let lastCheck: ModelCheck = { status: 'unknown' };

/** Verifies at startup that the configured models exist for this API key. A provider
 * retiring a model otherwise shows up only as every AI request failing. */
export async function checkConfiguredModels(): Promise<ModelCheck> {
  const { large, small } = getConfig().models;
  try {
    const list = await getGroqClient().models.list({ timeout: 10_000 });
    const available = new Set((list.data ?? []).map((m: { id: string }) => m.id));
    const missing = [large, small].filter((m) => !available.has(m));
    lastCheck = missing.length ? { status: 'missing', missing } : { status: 'ok' };
  } catch {
    lastCheck = { status: 'unknown' };
  }
  return lastCheck;
}

export function lastModelCheck(): ModelCheck {
  return lastCheck;
}
