/**
 * Groq's structured-output prompts ask for raw JSON but models occasionally wrap the
 * response in a markdown code fence anyway — strip that before parsing. Shared by
 * every route that requests JSON from the model (explain-repo, explain-file, analyze)
 * so the cleanup logic can't drift between call sites.
 */
export function parseJsonCompletion<T>(raw: string): T {
  const json = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();
  return JSON.parse(json) as T;
}
