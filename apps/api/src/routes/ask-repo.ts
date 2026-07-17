import { Router, Request, Response } from 'express';
import { getRepoInfo } from '../lib/github';
import { getGroqClient } from '../lib/groq-client';
import { embedText } from '../lib/embeddings';
import { validateBody } from '../lib/validate';
import { askRepoSchema } from '../lib/schemas';
import { ensureIndexed } from '../lib/indexer';
import { hybridRetrieve } from '../lib/retrieval';
import { formatRepoSummaryForPrompt } from '../lib/repo-summary';
import type { z } from 'zod';

export const askRepoRouter = Router();

type AskRepoBody = z.infer<typeof askRepoSchema>;

const MAX_HISTORY_TURNS = 12;

askRepoRouter.post('/', validateBody(askRepoSchema), async (req: Request, res: Response) => {
  const { question, context, history } = req.body as AskRepoBody;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Cancelled the moment the client disconnects (panel closed, user navigated away,
  // or the extension's AskRepoPage disconnects its port on unmount) — mirrors every
  // other streaming/multi-step route in this API.
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const { signal } = controller;

  try {
    const ref = context.ref ?? (await getRepoInfo(context.repoOwner, context.repoName, signal)).defaultBranch;
    if (signal.aborted) return;

    const entry = await ensureIndexed(context.repoOwner, context.repoName, ref, question, signal);
    if (signal.aborted) return;

    if (entry.chunks.length === 0 && entry.status === 'complete') {
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          message: "This repository doesn't have enough indexable source to answer questions about it.",
        })}\n\n`,
      );
      res.end();
      return;
    }

    const queryEmbedding = await embedText(question);
    if (signal.aborted) return;

    const results = hybridRetrieve(queryEmbedding, question, entry.chunks, entry.bm25);

    // Citations are computed here, directly from retrieval — never parsed out of the
    // model's own output — so they can never be hallucinated or mismatched. Sent before
    // any answer tokens so the UI can render citation chips while the answer streams in.
    const citations = results.map((result) => ({
      path: result.chunk.filePath,
      startLine: result.chunk.startLine,
      endLine: result.chunk.endLine,
      url: `https://github.com/${context.repoOwner}/${context.repoName}/blob/${ref}/${result.chunk.filePath}#L${result.chunk.startLine}-L${result.chunk.endLine}`,
    }));
    res.write(`data: ${JSON.stringify({ type: 'citations', citations })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'status', indexing: entry.status === 'complete' ? 'complete' : 'partial' })}\n\n`);
    if (signal.aborted) return;

    const summaryBlock = entry.summary ? formatRepoSummaryForPrompt(entry.summary) : '';
    const contextBlock = results.length
      ? results
          .map((result, i) => `[${i + 1}] ${result.chunk.filePath}:${result.chunk.startLine}-${result.chunk.endLine}\n${result.chunk.text}`)
          .join('\n\n')
      : 'No directly relevant code excerpts were found for this question — answer from the repository overview above only, and say so if you are not confident.';

    const systemPrompt = `You are GitGuide, an expert AI assistant helping developers understand the GitHub repository ${context.repoOwner}/${context.repoName}.
${summaryBlock ? `\nRepository overview:\n${summaryBlock}\n` : ''}
Below are the most relevant code excerpts retrieved for the user's question, numbered [1]-[${results.length}]. Ground your answer in these excerpts and reference them by number (e.g. "[1]") where relevant. Never invent a file path or line number that isn't shown here.

${contextBlock}

Provide a technically accurate, concise, actionable answer.`;

    const trimmedHistory = (history ?? []).slice(-MAX_HISTORY_TURNS);

    const groq = getGroqClient();
    const stream = await groq.chat.completions.create(
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          ...trimmedHistory.map((h) => ({ role: h.role, content: h.content })),
          { role: 'user', content: question },
        ],
        temperature: 0.4,
        max_tokens: 1024,
        stream: true,
      },
      { signal },
    );

    for await (const chunk of stream) {
      if (signal.aborted) break;
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`);
      }
    }

    if (!signal.aborted) {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    }
  } catch (err) {
    if (signal.aborted) return;
    console.error('Ask repo error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to generate response' })}\n\n`);
    res.end();
  }
});
