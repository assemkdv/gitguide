import Groq from 'groq-sdk';
import { getConfig } from './config';

let client: Groq | null = null;

/**
 * Lazy singleton shared by every route, so tests can mock this one small module
 * (`vi.mock('./groq-client')`) instead of the whole groq-sdk package. The SDK retries
 * once on 429/5xx (it honours the provider's retry-after header) and gives up after the
 * configured timeout instead of its 60s × 3 default.
 */
export function getGroqClient(): Groq {
  if (!client) {
    const config = getConfig();
    client = new Groq({ apiKey: config.groqApiKey, maxRetries: 1, timeout: config.limits.groqTimeoutMs });
  }
  return client;
}
