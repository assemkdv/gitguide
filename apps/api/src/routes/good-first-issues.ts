import { Router, Request, Response } from 'express';
import { getGoodFirstIssues } from '../lib/github';
import { validateBody } from '../lib/validate';
import { goodFirstIssuesSchema } from '../lib/schemas';
import type { z } from 'zod';

export const goodFirstIssuesRouter = Router();

type GoodFirstIssuesBody = z.infer<typeof goodFirstIssuesSchema>;

goodFirstIssuesRouter.post('/', validateBody(goodFirstIssuesSchema), async (req: Request, res: Response) => {
  const { repoOwner, repoName } = req.body as GoodFirstIssuesBody;

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const { signal } = controller;

  try {
    const goodFirstIssues = await getGoodFirstIssues(repoOwner, repoName, signal);
    if (signal.aborted) return;
    res.json({ goodFirstIssues });
  } catch (err) {
    if (signal.aborted) return;
    console.error('Good first issues error:', err);
    res.status(500).json({ error: 'Failed to fetch good first issues' });
  }
});
