import Groq from 'groq-sdk';

let client: Groq | null = null;

/**
 * Lazy singleton so tests can mock this one small module (`vi.mock('./groq-client')`)
 * instead of the whole groq-sdk package. Existing routes (chat.ts, explain-file.ts,
 * analyze.ts, and the pre-extraction explain-repo.ts) each construct their own
 * `new Groq(...)` inline and are left exactly as they are — this factory is only used
 * by the new RAG code (repo-summary.ts, the indexer, and the ask-repo route).
 */
export function getGroqClient(): Groq {
  if (!client) {
    client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return client;
}
