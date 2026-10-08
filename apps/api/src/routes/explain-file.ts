import { Router, Request, Response } from 'express';
import { parseJsonCompletion } from '../lib/groq-json';
import { validateBody } from '../lib/validate';
import { explainFileSchema } from '../lib/schemas';
import { explainFileOutputSchema, explainFileQuickOutputSchema } from '../lib/output-schemas';
import { getFileAtCommit, getTree, resolveSnapshot, RepoSnapshot } from '../lib/github';
import { getGroqClient } from '../lib/groq-client';
import { withAiSlot } from '../lib/ai-guard';
import { getConfig } from '../lib/config';
import { modelOptions } from '../lib/ai-models';
import { sendError } from '../lib/errors';
import { checkPaths, blobUrl } from '../lib/path-evidence';
import { untrusted, UNTRUSTED_DATA_RULES, OUTPUT_STYLE_RULES } from '../lib/prompt-safety';
import { requestSignal } from '../lib/request-signal';
import type { z } from 'zod';

export const explainFileRouter = Router();

type ExplainFileBody = z.infer<typeof explainFileSchema>;

export const FULL_ANALYSIS_CHARS = 6000;
export const QUICK_ANALYSIS_CHARS = 2500;
const FILE_DOWNLOAD_MAX_BYTES = 200_000;

export interface FileAnalysisMeta {
  ref: string;
  commitSha: string;
  path: string;
  url: string;
  lines: number;
  totalChars: number;
  analyzedChars: number;
  /** The model saw only the beginning of the file. */
  truncated: boolean;
}

async function loadFile(body: ExplainFileBody, analysisChars: number, signal: AbortSignal) {
  const snapshot = await resolveSnapshot(body.repoOwner, body.repoName, body.ref, signal);
  const file = await getFileAtCommit(snapshot.owner, snapshot.repo, snapshot.commitSha, body.filePath, {
    signal,
    maxBytes: FILE_DOWNLOAD_MAX_BYTES,
  });
  const excerpt = file.content.slice(0, analysisChars);
  const meta: FileAnalysisMeta = {
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    path: body.filePath,
    url: blobUrl(snapshot.owner, snapshot.repo, snapshot.commitSha, body.filePath),
    lines: file.content.split('\n').length,
    totalChars: file.content.length,
    analyzedChars: excerpt.length,
    truncated: file.truncated || excerpt.length < file.content.length,
  };
  return { snapshot, excerpt, meta, fileDownloadTruncated: file.truncated };
}

function fileHeader(snapshot: RepoSnapshot, meta: FileAnalysisMeta): string {
  return `Repository: ${snapshot.owner}/${snapshot.repo} (ref ${snapshot.ref}, commit ${snapshot.commitSha.slice(0, 7)})
File: ${meta.path}
${meta.truncated ? `NOTE: only the first ${meta.analyzedChars} characters of this file are shown; the rest was not analyzed. Do not describe code you cannot see.` : 'The complete file is shown.'}`;
}

explainFileRouter.post('/', validateBody(explainFileSchema), async (req: Request, res: Response) => {
  const body = req.body as ExplainFileBody;
  const signal = requestSignal(req, res);

  try {
    const { snapshot, excerpt, meta } = await loadFile(body, FULL_ANALYSIS_CHARS, signal);

    const system = `You are a senior software engineer explaining a single file to a new contributor.

${OUTPUT_STYLE_RULES}

${UNTRUSTED_DATA_RULES}
- Clearly separate what the file itself shows from inference: when you infer something not visible in the file (for example who calls it), say "likely" or "probably".

Respond with ONLY valid JSON. No markdown, no code fences, no extra text.`;

    const user = `${fileHeader(snapshot, meta)}

${untrusted('file_content', excerpt)}

Return this JSON shape:
{
  "purpose": "1 sentence: what this file is responsible for",
  "summary": "2-3 sentence plain-English walkthrough of what the file does",
  "mainComponents": ["function/class/export name: what it does"],
  "inputsOutputs": "1-2 sentences on inputs and outputs, or empty string if not applicable",
  "dependencies": ["import or package actually referenced in the file"],
  "usedBy": "1 sentence on what likely uses this file (this is inference, so say so), or empty string",
  "connections": "1-2 sentences on how it fits into the project, or empty string if the file doesn't show it",
  "importantLogic": "1-2 sentences on the most important logic, or empty string for trivial files",
  "edgeCases": "1-2 sentences on edge cases visible in the code, or empty string if none are evident",
  "contributorNotes": "1-2 sentences a contributor should know before changing this file",
  "relatedFiles": ["path of a related file referenced by an import or path in the code"]
}

Rules:
- mainComponents: up to 5 items naming real functions/classes/exports visible above. A short or simple file may have one or two; do not pad.
- dependencies: up to 5 real imports. Empty array if there are none.
- relatedFiles: only paths referenced in the code (e.g. relative imports). Empty array if none.`;

    const completion = await withAiSlot(signal, () =>
      getGroqClient().chat.completions.create(
        {
          model: getConfig().models.large,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
          max_tokens: 2200,
          ...modelOptions(getConfig().models.large),
        },
        { signal },
      ),
    );
    const parsed = parseJsonCompletion(completion.choices[0]?.message?.content ?? '', explainFileOutputSchema, {
      required: ['purpose'],
    });

    // Evidence check for related files against the tree at the same commit.
    const tree = await getTree(snapshot.owner, snapshot.repo, snapshot.commitSha, signal);
    const treePaths = new Set(tree.files.map((f) => f.path));
    const baseDir = body.filePath.split('/').slice(0, -1).join('/');
    const relatedFiles = checkPaths(parsed.relatedFiles, treePaths, baseDir).filter((f) => f.path !== body.filePath);

    if (signal.aborted) return;
    res.json({ ...parsed, relatedFiles, meta });
  } catch (err) {
    if (signal.aborted) return;
    sendError(res, err, 'explain-file');
  }
});

// Fast, low-detail pass so the panel has something to show almost immediately while
// the full explanation above is still in flight. Small model, small prompt.
explainFileRouter.post('/quick', validateBody(explainFileSchema), async (req: Request, res: Response) => {
  const body = req.body as ExplainFileBody;
  const signal = requestSignal(req, res);

  try {
    const { snapshot, excerpt, meta } = await loadFile(body, QUICK_ANALYSIS_CHARS, signal);
    const completion = await withAiSlot(signal, () =>
      getGroqClient().chat.completions.create(
        {
          model: getConfig().models.small,
          messages: [
            {
              role: 'system',
              content: `Give a fast, factual orientation to a single file.\n\n${OUTPUT_STYLE_RULES}\n\n${UNTRUSTED_DATA_RULES}\n\nRespond with ONLY valid JSON: {"purpose": "1 sentence", "summary": "1-2 sentences"}`,
            },
            { role: 'user', content: `${fileHeader(snapshot, meta)}\n\n${untrusted('file_content', excerpt)}` },
          ],
          temperature: 0.2,
          max_tokens: 700,
          ...modelOptions(getConfig().models.small),
        },
        { signal },
      ),
    );
    const parsed = parseJsonCompletion(completion.choices[0]?.message?.content ?? '', explainFileQuickOutputSchema, {
      required: ['purpose'],
    });
    if (signal.aborted) return;
    res.json({ ...parsed, meta });
  } catch (err) {
    if (signal.aborted) return;
    sendError(res, err, 'explain-file-quick');
  }
});
