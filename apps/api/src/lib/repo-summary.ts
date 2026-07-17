import { getRepoInfo, getReadme, getRepoTree, RepoInfo } from './github';
import { getGroqClient } from './groq-client';
import { parseJsonCompletion } from './groq-json';
import { explainRepoOutputSchema } from './output-schemas';
import type { z } from 'zod';

// The Groq prompt/parsing core shared by `/v1/explain-repo` and the RAG indexer's
// "repository architecture summary" (generated once per repo+sha, injected into every
// ask-repo prompt so the model has whole-repo orientation before reading retrieved
// chunks). One generator, two call sites — explain-repo.ts layers its own additional
// entrypoint-LOC enrichment and good-first-issues fetch on top of this.

export type RepoSummaryFields = z.infer<typeof explainRepoOutputSchema>;

export interface RepoSummaryResult {
  repoInfo: RepoInfo;
  ref: string; // the ref actually used for the tree fetch (defaultBranch, unless overridden)
  tree: string[];
  summary: RepoSummaryFields;
}

export async function generateRepoSummary(
  owner: string,
  repo: string,
  refOverride?: string,
  signal?: AbortSignal,
): Promise<RepoSummaryResult> {
  const [repoInfo, readme] = await Promise.all([
    getRepoInfo(owner, repo, signal),
    getReadme(owner, repo, signal),
  ]);
  const ref = refOverride ?? repoInfo.defaultBranch;
  const tree = await getRepoTree(owner, repo, ref, signal);

  const treeSample = tree.slice(0, 300).join('\n');
  const topLevelDirs = Array.from(
    new Set(tree.map((p) => p.split('/')[0]).filter((seg) => !seg.includes('.'))),
  ).slice(0, 25);

  const groq = getGroqClient();

  const prompt = `You are a senior software engineer giving a new contributor a thorough, fast orientation to a codebase.

Repository: ${owner}/${repo}
Description: ${repoInfo.description ?? 'None'}
Primary language: ${repoInfo.language ?? 'Unknown'}

README (truncated):
${readme || 'No README found.'}

Top-level directories: ${topLevelDirs.join(', ') || 'none detected'}

File tree (truncated, ${tree.length} files total):
${treeSample || 'No files found.'}

Respond with ONLY valid JSON. No markdown, no code blocks, no extra text.

{
  "purpose": "1-2 sentences: what this project is and who it's for",
  "techStack": ["language/framework one", "language/framework two"],
  "folderStructure": [
    { "path": "top-level-dir", "description": "1 sentence on what lives here" }
  ],
  "architecture": [
    { "title": "short concept name", "description": "one sentence, specific to this repo" }
  ],
  "entrypoints": [
    { "path": "exact path copied from the file tree above", "label": "2-3 word role, e.g. Server entry" }
  ],
  "dataFlow": "2-3 sentences describing the main request/data flow through the system, naming real modules",
  "authPersistence": "1-2 sentences on how auth and/or data persistence work, or empty string if not applicable to this project",
  "howToRun": ["step one", "step two", "step three"],
  "beginnerStart": "1-2 sentences pointing a beginner to a concrete first file or area to read"
}

RULES:
- techStack: 3-8 concrete items (languages, frameworks, build tools, key libraries actually visible in the README/tree). No vague terms.
- folderStructure: 3-6 items, only real top-level directories from the list above.
- architecture: exactly 3 items, ordered by how a new contributor should learn them.
- entrypoints: exactly 4 items, paths MUST be copied verbatim from the file tree list above — never invent a path.
- howToRun: 3-6 concrete steps (install, configure env, run dev command) inferred from the README/package manifest conventions for this stack. If genuinely unknown, give the most likely convention for this stack rather than a vague placeholder.
- Be concrete throughout: name real directories, real files, real frameworks found in the tree/README. No filler like "well-structured" or "modern codebase".`;

  const completion = await groq.chat.completions.create(
    {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 1800,
    },
    { signal },
  );

  const raw = completion.choices[0]?.message?.content ?? '';
  const summary = parseJsonCompletion(raw, explainRepoOutputSchema);

  return { repoInfo, ref, tree, summary };
}

/** Truncated, prompt-ready form of a repo summary — injected into every /v1/ask-repo
 * system prompt so the model has whole-repo context before reading retrieved chunks. */
export function formatRepoSummaryForPrompt(summary: RepoSummaryFields, maxChars = 1500): string {
  const parts = [
    summary.purpose && `Purpose: ${summary.purpose}`,
    summary.techStack.length > 0 && `Tech stack: ${summary.techStack.join(', ')}`,
    summary.architecture.length > 0 &&
      `Architecture:\n${summary.architecture.map((a) => `- ${a.title}: ${a.description}`).join('\n')}`,
    summary.folderStructure.length > 0 &&
      `Major folders:\n${summary.folderStructure.map((f) => `- ${f.path}: ${f.description}`).join('\n')}`,
    summary.authPersistence && `Auth/persistence: ${summary.authPersistence}`,
    summary.dataFlow && `Data flow: ${summary.dataFlow}`,
  ].filter(Boolean);

  return parts.join('\n\n').slice(0, maxChars);
}
