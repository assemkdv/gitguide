import { Router, Request, Response } from 'express';
import { getGoodFirstIssues, getRepoInfo } from '../lib/github';
import { validateBody } from '../lib/validate';
import { goodFirstIssuesSchema } from '../lib/schemas';
import { sendError } from '../lib/errors';
import { requestSignal } from '../lib/request-signal';
import type { z } from 'zod';

export const goodFirstIssuesRouter = Router();

type GoodFirstIssuesBody = z.infer<typeof goodFirstIssuesSchema>;

goodFirstIssuesRouter.post('/', validateBody(goodFirstIssuesSchema), async (req: Request, res: Response) => {
  const { repoOwner, repoName } = req.body as GoodFirstIssuesBody;
  const signal = requestSignal(req, res);

  try {
    await getRepoInfo(repoOwner, repoName, signal); // public-repository check
    const goodFirstIssues = await getGoodFirstIssues(repoOwner, repoName, signal);
    if (signal.aborted) return;
    res.json({ goodFirstIssues });
  } catch (err) {
    if (signal.aborted) return;
    sendError(res, err, 'good-first-issues');
  }
});
