import { Router, Request, Response } from 'express';
import { getGoodFirstIssues, getFileContent } from '../lib/github';
import { GroqResponseError } from '../lib/groq-json';
import { generateRepoSummary } from '../lib/repo-summary';
import { validateBody } from '../lib/validate';
import { explainRepoSchema } from '../lib/schemas';
import type { z } from 'zod';

export const explainRepoRouter = Router();

type ExplainRepoBody = z.infer<typeof explainRepoSchema>;

explainRepoRouter.post('/', validateBody(explainRepoSchema), async (req: Request, res: Response) => {
  const { repoOwner, repoName } = req.body as ExplainRepoBody;

  // The client disconnects (panel closed, user navigated to a different repo) well
  // before this multi-step pipeline would naturally finish — abort every in-flight
  // GitHub/Groq call as soon as that happens instead of paying for work no one is
  // waiting on anymore.
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const { signal } = controller;

  try {
    const [summaryResult, goodFirstIssues] = await Promise.all([
      generateRepoSummary(repoOwner, repoName, undefined, signal),
      getGoodFirstIssues(repoOwner, repoName, signal),
    ]);
    if (signal.aborted) return;

    const { repoInfo, tree, summary: parsed } = summaryResult;
    const validPaths = new Set(tree);
    const chosenEntrypoints = parsed.entrypoints.filter((e) => validPaths.has(e.path));

    const keyEntrypoints = await Promise.all(
      chosenEntrypoints.map(async (e) => {
        const content = await getFileContent(repoOwner, repoName, repoInfo.defaultBranch, e.path, signal);
        const loc = content ? content.split('\n').length : 0;
        return { path: e.path, label: e.label, loc };
      }),
    );
    if (signal.aborted) return;

    res.json({
      purpose: parsed.purpose,
      techStack: parsed.techStack,
      folderStructure: parsed.folderStructure,
      architecture: parsed.architecture,
      keyEntrypoints,
      dataFlow: parsed.dataFlow,
      authPersistence: parsed.authPersistence,
      howToRun: parsed.howToRun,
      beginnerStart: parsed.beginnerStart,
      goodFirstIssues,
    });
  } catch (err) {
    if (signal.aborted) return;
    if (err instanceof GroqResponseError) {
      console.error('Explain repo: unusable model response:', err.message);
      res.status(502).json({ error: 'The AI response was malformed. Please try again.' });
      return;
    }
    console.error('Explain repo error:', err);
    res.status(500).json({ error: 'Failed to explain repository' });
  }
});
