import { getReadme, getTree, RepoSnapshot, RepoTree } from './github';
import { getGroqClient } from './groq-client';
import { parseJsonCompletion } from './groq-json';
import { explainRepoOutputSchema } from './output-schemas';
import { untrusted, UNTRUSTED_DATA_RULES } from './prompt-safety';
import { withAiSlot } from './ai-guard';
import { getConfig } from './config';
import { modelOptions } from './ai-models';
import type { z } from 'zod';

// The Groq prompt/parsing core shared by `/v1/explain-repo` and the RAG indexer's
// "repository architecture summary" (generated once per repo+commit, injected into every
// ask-repo prompt so the model has whole-repo orientation before reading retrieved
// chunks). Everything is read from one immutable commit (`snapshot.commitSha`).

export type RepoSummaryFields = z.infer<typeof explainRepoOutputSchema>;

export const TREE_SAMPLE_SIZE = 300;

export interface RepoSummaryCoverage {
  filesInTree: number;
  filesShownToModel: number;
  treeTruncated: boolean;
  readmeTruncated: boolean;
  hasReadme: boolean;
}

export interface RepoSummaryResult {
  tree: RepoTree;
  summary: RepoSummaryFields;
  coverage: RepoSummaryCoverage;
}

/** Shallow paths first, so a large repository's sample still shows its overall shape. */
export function sampleTree(paths: string[], size = TREE_SAMPLE_SIZE): string[] {
  return [...paths]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, size);
}

export async function generateRepoSummary(snapshot: RepoSnapshot, signal?: AbortSignal): Promise<RepoSummaryResult> {
  const { owner, repo, repoInfo, commitSha } = snapshot;
  const [readme, tree] = await Promise.all([
    getReadme(owner, repo, commitSha, signal),
    getTree(owner, repo, commitSha, signal),
  ]);

  const paths = tree.files.map((f) => f.path);
  const sample = sampleTree(paths);
  const topLevelDirs = Array.from(new Set(paths.filter((p) => p.includes('/')).map((p) => p.split('/')[0]))).slice(0, 25);

  const system = `You are a senior software engineer giving a new contributor a fast, accurate orientation to a codebase.

${UNTRUSTED_DATA_RULES}

Respond with ONLY valid JSON. No markdown, no code fences, no extra text.`;

  const user = `Repository: ${owner}/${repo} (commit ${commitSha.slice(0, 7)})
Description: ${repoInfo.description ?? 'None'}
Primary language: ${repoInfo.language ?? 'Unknown'}

README${readme.truncated ? ' (truncated)' : ''}:
${untrusted('readme', readme.text || 'No README found.')}

Top-level directories: ${topLevelDirs.join(', ') || 'none'}

File tree (${sample.length} of ${paths.length} files shown${tree.truncated ? '; GitHub truncated the listing, so the repository has more files' : ''}):
${untrusted('file_tree', sample.join('\n') || 'No files found.')}

Return this JSON shape:
{
  "purpose": "1-2 sentences: what this project is and who it's for",
  "techStack": ["language/framework/tool visible in the README or file tree"],
  "folderStructure": [{ "path": "top-level-dir", "description": "1 sentence on what lives here" }],
  "architecture": [{ "title": "short concept name", "description": "one sentence, specific to this repo" }],
  "entrypoints": [{ "path": "exact path copied from the file tree", "label": "2-3 word role" }],
  "dataFlow": "2-3 sentences on the main request/data flow, naming real modules, or empty string if the data does not show it",
  "authPersistence": "1-2 sentences on auth and/or persistence, or empty string if not shown",
  "howToRun": ["step taken from the README or a manifest in the tree"],
  "beginnerStart": "1-2 sentences pointing to a concrete first file or area to read"
}

Rules:
- Only list items supported by the README, description, or file tree above. Small repositories may have only one or two items in a list, or none; do not pad lists.
- techStack: up to 8 concrete items. folderStructure: up to 6 real directories from the list above. architecture: up to 4 items, ordered by how a new contributor should learn them.
- entrypoints: up to 4 paths copied verbatim from the file tree. Never invent a path.
- howToRun: only steps stated in the README or directly implied by a manifest that appears in the tree (e.g. package.json → npm install). If neither shows how to run the project, return an empty array.
- Be concrete; no filler like "well-structured".`;

  const completion = await withAiSlot(signal, () =>
    getGroqClient().chat.completions.create(
      {
        model: getConfig().models.large,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: 2600,
        ...modelOptions(getConfig().models.large),
      },
      { signal },
    ),
  );

  const raw = completion.choices[0]?.message?.content ?? '';
  const parsed = parseJsonCompletion(raw, explainRepoOutputSchema, { required: ['purpose'] });
  const validPaths = new Set(paths);
  const summary: RepoSummaryFields = {
    ...parsed,
    // Evidence check: an entrypoint the model named but that isn't in the tree is dropped.
    entrypoints: parsed.entrypoints.filter((e) => validPaths.has(e.path)),
  };

  return {
    tree,
    summary,
    coverage: {
      filesInTree: paths.length,
      filesShownToModel: sample.length,
      treeTruncated: tree.truncated,
      readmeTruncated: readme.truncated,
      hasReadme: readme.text.length > 0,
    },
  };
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
