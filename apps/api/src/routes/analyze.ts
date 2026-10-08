import { Router, Request, Response } from 'express';
import { parseJsonCompletion } from '../lib/groq-json';
import { validateBody } from '../lib/validate';
import { analyzeSchema } from '../lib/schemas';
import { analyzeOutputSchema } from '../lib/output-schemas';
import { getIssue, getTree, resolveSnapshot } from '../lib/github';
import { getGroqClient } from '../lib/groq-client';
import { withAiSlot } from '../lib/ai-guard';
import { getConfig } from '../lib/config';
import { modelOptions } from '../lib/ai-models';
import { sendError } from '../lib/errors';
import { requestSignal } from '../lib/request-signal';
import { resolveRepoPath } from '../lib/path-evidence';
import { untrusted, UNTRUSTED_DATA_RULES } from '../lib/prompt-safety';
import { tokenize } from '../lib/bm25';
import { sampleTree } from '../lib/repo-summary';
import { isIndexableFile } from '../lib/ignore-list';
import type { z } from 'zod';

export const analyzeRouter = Router();

type AnalyzeBody = z.infer<typeof analyzeSchema>;

const CANDIDATE_PATHS = 200;

/** Paths whose names share words with the issue first, then a shallow sample — gives the
 * model real paths to choose from instead of inventing plausible-sounding ones. */
export function candidatePathsForIssue(paths: string[], issueText: string, limit = CANDIDATE_PATHS): string[] {
  const words = new Set(tokenize(issueText).filter((w) => w.length >= 4));
  const scored = paths
    .map((path) => ({ path, score: tokenize(path).filter((w) => words.has(w)).length }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((p) => p.path);
  const picked = new Set(scored.slice(0, Math.floor(limit / 2)));
  for (const path of sampleTree(paths, limit)) {
    if (picked.size >= limit) break;
    picked.add(path);
  }
  return [...picked];
}

analyzeRouter.post('/', validateBody(analyzeSchema), async (req: Request, res: Response) => {
  const { repoOwner, repoName, issueNumber } = req.body as AnalyzeBody;
  const signal = requestSignal(req, res);

  try {
    const snapshot = await resolveSnapshot(repoOwner, repoName, undefined, signal);
    const [issue, tree] = await Promise.all([
      getIssue(repoOwner, repoName, issueNumber, signal),
      getTree(repoOwner, repoName, snapshot.commitSha, signal),
    ]);

    const sourcePaths = tree.files.map((f) => f.path).filter(isIndexableFile);
    const candidates = candidatePathsForIssue(sourcePaths, `${issue.title}\n${issue.body}`);
    const discussion = issue.comments.map((c) => untrusted('comment', `@${c.author}: ${c.body}`)).join('\n');

    const system = `You are a senior software engineer helping a contributor understand a GitHub issue before starting work.

${UNTRUSTED_DATA_RULES}
- The candidate file list is real (from the repository at commit ${snapshot.commitSha.slice(0, 7)}), but you have NOT seen the contents of those files. Treat file choices and implementation steps as suggestions, and prefer the issue's own wording over speculation.

Respond with ONLY valid JSON. No markdown, no code fences, no extra text.`;

    const user = `Repository: ${repoOwner}/${repoName}
Issue #${issue.number} (${issue.state})${issue.isPullRequest ? ' — this is a pull request' : ''}

${untrusted('issue', `Title: ${issue.title}\n\n${issue.body || 'No description provided.'}`)}

Discussion (${issue.comments.length} of ${issue.commentsTotal} comments shown):
${discussion || 'No discussion.'}

Candidate repository files (${candidates.length} of ${sourcePaths.length}${tree.truncated ? '; listing truncated by GitHub' : ''}):
${untrusted('file_tree', candidates.join('\n'))}

Return this JSON shape:
{
  "whatItAsks": ["short verb-first task using names from the issue"],
  "whyItMatters": "1-2 sentences on impact, or empty string if the issue doesn't say",
  "currentBehavior": "1-2 sentences on what happens today, or \\"Not described in the issue.\\"",
  "expectedBehavior": "1-2 sentences on the expected result, or \\"Not described in the issue.\\"",
  "discussionContext": "1-2 sentences on what the discussion adds, or empty string",
  "relevantFiles": [{ "path": "path copied from the candidate list", "reason": "under 10 words" }],
  "implementationSteps": ["verb-first step, under 12 words"],
  "risks": "1-2 sentences on risks specific to this change, or empty string",
  "testingConsiderations": "1-2 sentences on how to verify the change",
  "difficulty": "beginner | intermediate | advanced",
  "timeEstimate": "short range like 2-4 hours"
}

Rules:
- whatItAsks: 1-3 items using specific names (functions, components, error messages) from the issue.
- relevantFiles: 0-5 paths copied exactly from the candidate list. If none clearly relate, return an empty array.
- implementationSteps: 2-6 concrete steps. Do not invent APIs or files that the issue and candidate list don't mention.`;

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
    const parsed = parseJsonCompletion(completion.choices[0]?.message?.content ?? '', analyzeOutputSchema, {
      required: ['whatItAsks'],
    });

    const treePaths = new Set(tree.files.map((f) => f.path));
    const relevantFiles = parsed.relevantFiles
      .filter((file) => file.path.trim().length > 0)
      .map((file) => {
        const resolved = resolveRepoPath(file.path, treePaths);
        return { path: resolved ?? file.path.trim(), reason: file.reason, verified: resolved != null };
      });

    if (signal.aborted) return;
    res.json({
      ...parsed,
      relevantFiles,
      meta: {
        issueNumber: issue.number,
        title: issue.title,
        state: issue.state,
        updatedAt: issue.updatedAt,
        commentsTotal: issue.commentsTotal,
        commentsIncluded: issue.comments.length,
        ref: snapshot.ref,
        commitSha: snapshot.commitSha,
        treeTruncated: tree.truncated,
      },
    });
  } catch (err) {
    if (signal.aborted) return;
    sendError(res, err, 'analyze');
  }
});
