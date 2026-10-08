import { Router, Request, Response } from 'express';
import { resolveSnapshot } from '../lib/github';
import { getGroqClient } from '../lib/groq-client';
import { embedText, embeddingsEnabled } from '../lib/embeddings';
import { validateBody } from '../lib/validate';
import { askRepoSchema } from '../lib/schemas';
import { ensureIndexed, hasFullCoverage } from '../lib/indexer';
import { hybridRetrieve } from '../lib/retrieval';
import { formatRepoSummaryForPrompt } from '../lib/repo-summary';
import { withAiSlot } from '../lib/ai-guard';
import { getConfig } from '../lib/config';
import { modelOptions } from '../lib/ai-models';
import { ApiError, errorBody, logRouteError, toApiError } from '../lib/errors';
import { blobUrl } from '../lib/path-evidence';
import { untrusted, UNTRUSTED_DATA_RULES, OUTPUT_STYLE_RULES } from '../lib/prompt-safety';
import type { z } from 'zod';

export const askRepoRouter = Router();

type AskRepoBody = z.infer<typeof askRepoSchema>;

const MAX_HISTORY_TURNS = 12;
const HEARTBEAT_MS = 15_000;

// SSE protocol (one JSON object per `data:` event, in this order):
//   status    → { index: { status, ref, commitSha, coverage, fullCoverage, retrieval } }
//   citations → { citations: [{ path, startLine, endLine, url }] }
//   chunk*    → { content }
//   done      → { finishReason }        — the only successful terminator
//   error     → { code, message, retryAfterSec? } — may replace any step above
// A stream that ends without `done` or `error` was interrupted and must not be treated
// as a complete answer by the client.
askRepoRouter.post('/', validateBody(askRepoSchema), async (req: Request, res: Response) => {
  const { question, context, history } = req.body as AskRepoBody;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(new DOMException('Client disconnected', 'AbortError'));
  });
  const { signal } = controller;

  const send = (event: Record<string, unknown>) => {
    if (!signal.aborted && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  // SSE comments keep idle proxies from closing the connection during a slow index build.
  const heartbeat = setInterval(() => {
    if (!signal.aborted && !res.writableEnded) res.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);

  try {
    const snapshot = await resolveSnapshot(context.repoOwner, context.repoName, context.ref, signal);
    const entry = await ensureIndexed(snapshot, question, signal);
    signal.throwIfAborted();

    const retrieval = embeddingsEnabled() ? 'hybrid' : 'lexical';
    send({
      type: 'status',
      // Legacy summary field: 'complete' only when indexing finished.
      indexing: entry.status === 'complete' ? 'complete' : 'partial',
      index: {
        status: entry.status,
        ref: snapshot.ref,
        commitSha: snapshot.commitSha,
        coverage: entry.coverage,
        fullCoverage: hasFullCoverage(entry.coverage, entry.status),
        retrieval,
      },
    });

    if (entry.chunks.length === 0 && entry.status === 'complete') {
      throw new ApiError('NOT_INDEXABLE', 422, "This repository doesn't have enough indexable source to answer questions about it.");
    }

    // Lexical-only when embeddings are disabled: embedText is never called, so
    // @huggingface/transformers is never loaded.
    const queryEmbedding = retrieval === 'hybrid' ? await embedText(question) : null;
    signal.throwIfAborted();
    const results = hybridRetrieve(queryEmbedding, question, entry.chunks, entry.bm25);

    // Citations come straight from retrieval — never parsed out of model output — and are
    // pinned to the indexed commit, so a link always shows the code the answer used.
    const citations = results.map((result) => ({
      path: result.chunk.filePath,
      startLine: result.chunk.startLine,
      endLine: result.chunk.endLine,
      url: blobUrl(context.repoOwner, context.repoName, snapshot.commitSha, result.chunk.filePath, result.chunk.startLine, result.chunk.endLine),
    }));
    send({ type: 'citations', citations });

    const summaryBlock = entry.summary ? formatRepoSummaryForPrompt(entry.summary) : '';
    const excerpts = results
      .map((result, i) => `[${i + 1}] ${result.chunk.filePath}:${result.chunk.startLine}-${result.chunk.endLine}\n${result.chunk.text}`)
      .join('\n\n');
    const coverageNote = hasFullCoverage(entry.coverage, entry.status)
      ? 'The whole repository was indexed.'
      : `Only part of the repository has been indexed so far (${entry.coverage.indexedFiles} of ${entry.coverage.eligibleFiles} eligible files${entry.coverage.treeTruncated ? ', and GitHub truncated the file listing' : ''}). Something not shown in the excerpts may still exist in the repository.`;

    const systemPrompt = `You are GitGuide, helping a developer understand the GitHub repository ${context.repoOwner}/${context.repoName} at ${snapshot.ref} (commit ${snapshot.commitSha.slice(0, 7)}).

${OUTPUT_STYLE_RULES}

${UNTRUSTED_DATA_RULES}

How to answer:
- Ground the answer in the numbered code excerpts and cite them by number, e.g. [2]. Never invent file paths, line numbers, or identifiers that are not shown.
- Separate what the excerpts show from your inference ("this suggests…", "likely…").
- If the excerpts don't contain the answer, say so plainly and name what is missing (e.g. which file or feature you would need to see). Do not guess.
- ${coverageNote}
- Be concise and practical. Use Markdown; put code in fenced blocks.
${summaryBlock ? `\nRepository overview (generated from the README and file tree; may be imperfect):\n${summaryBlock}\n` : ''}
${results.length ? untrusted('code_excerpts', excerpts) : 'No code excerpts matched this question.'}`;

    const trimmedHistory = (history ?? []).slice(-MAX_HISTORY_TURNS);
    const stream = await withAiSlot(signal, () =>
      getGroqClient().chat.completions.create(
        {
          model: getConfig().models.large,
          messages: [
            { role: 'system', content: systemPrompt },
            ...trimmedHistory.map((h) => ({ role: h.role, content: h.content })),
            { role: 'user', content: question },
          ],
          temperature: 0.3,
          max_tokens: 1800,
          stream: true,
          ...modelOptions(getConfig().models.large),
        },
        { signal },
      ),
    );

    let finishReason: string | null = null;
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const choice = chunk.choices[0];
      if (choice?.delta?.content) send({ type: 'chunk', content: choice.delta.content });
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    send({ type: 'done', finishReason });
    res.end();
  } catch (err) {
    if (signal.aborted) return;
    const apiError = toApiError(err);
    logRouteError('ask-repo', err, apiError);
    send({ type: 'error', ...errorBody(apiError), message: apiError.message });
    res.end();
  } finally {
    clearInterval(heartbeat);
  }
});
