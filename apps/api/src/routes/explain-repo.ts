import { Router, Request, Response } from 'express';
import { getGoodFirstIssues, getFileAtCommit, resolveSnapshot, GoodFirstIssue } from '../lib/github';
import { generateRepoSummary } from '../lib/repo-summary';
import { validateBody } from '../lib/validate';
import { explainRepoSchema } from '../lib/schemas';
import { sendError, toApiError, ErrorCode } from '../lib/errors';
import { requestSignal } from '../lib/request-signal';
import { blobUrl } from '../lib/path-evidence';
import type { z } from 'zod';

export const explainRepoRouter = Router();

type ExplainRepoBody = z.infer<typeof explainRepoSchema>;

explainRepoRouter.post('/', validateBody(explainRepoSchema), async (req: Request, res: Response) => {
  const { repoOwner, repoName, ref } = req.body as ExplainRepoBody;
  const signal = requestSignal(req, res);

  try {
    const snapshot = await resolveSnapshot(repoOwner, repoName, ref, signal);

    // Good-first-issues are a secondary section: if that lookup fails, the explanation
    // still succeeds, but the response says the list is unavailable (null + error code)
    // rather than pretending the repository has no such issues.
    const issuesPromise: Promise<{ items: GoodFirstIssue[] | null; error: ErrorCode | null }> = getGoodFirstIssues(
      repoOwner,
      repoName,
      signal,
    ).then(
      (items) => ({ items, error: null }),
      (err) => {
        if (signal.aborted) throw err;
        return { items: null, error: toApiError(err).code };
      },
    );

    const [{ summary, coverage, tree }, issues] = await Promise.all([generateRepoSummary(snapshot, signal), issuesPromise]);

    const sizes = new Map(tree.files.map((f) => [f.path, f.size]));
    const keyEntrypoints = await Promise.all(
      summary.entrypoints.map(async (e) => {
        // Line counts need the file; skip the download for very large files.
        let loc: number | null = null;
        if ((sizes.get(e.path) ?? 0) <= 200_000) {
          try {
            const file = await getFileAtCommit(repoOwner, repoName, snapshot.commitSha, e.path, { signal });
            loc = file.truncated ? null : file.content.split('\n').length;
          } catch (err) {
            if (signal.aborted) throw err;
          }
        }
        return { path: e.path, label: e.label, loc, url: blobUrl(repoOwner, repoName, snapshot.commitSha, e.path) };
      }),
    );
    if (signal.aborted) return;

    res.json({
      purpose: summary.purpose,
      techStack: summary.techStack,
      folderStructure: summary.folderStructure,
      architecture: summary.architecture,
      keyEntrypoints,
      dataFlow: summary.dataFlow,
      authPersistence: summary.authPersistence,
      howToRun: summary.howToRun,
      beginnerStart: summary.beginnerStart,
      goodFirstIssues: issues.items,
      goodFirstIssuesError: issues.error,
      meta: { ref: snapshot.ref, commitSha: snapshot.commitSha, ...coverage },
    });
  } catch (err) {
    if (signal.aborted) return;
    sendError(res, err, 'explain-repo');
  }
});
