import { Router, Request, Response } from 'express';
import Groq from 'groq-sdk';
import { validateBody } from '../lib/validate';
import { chatSchema } from '../lib/schemas';
import type { z } from 'zod';

export const chatRouter = Router();

type ChatBody = z.infer<typeof chatSchema>;

const MAX_HISTORY_TURNS = 12;

chatRouter.post('/', validateBody(chatSchema), async (req: Request, res: Response) => {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const { message, context, history } = req.body as ChatBody;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // The extension side disconnects the port (and thus this request) whenever the user
  // closes the chat or sends a new message — stop pulling tokens from Groq and don't
  // attempt to write to an already-closed connection.
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const { signal } = controller;

  const focus = context.issueNumber
    ? `You are helping with this GitHub issue:\nRepository: ${context.repoOwner}/${context.repoName}\nIssue #${context.issueNumber}: ${context.issueTitle}`
    : context.filePath
      ? `You are helping a contributor understand this file:\nRepository: ${context.repoOwner}/${context.repoName}\nFile: ${context.filePath}`
      : `You are helping a contributor understand this repository:\nRepository: ${context.repoOwner}/${context.repoName}`;

  const grounding = context.resultContext
    ? `\n\nGitGuide already generated this analysis for the user — use it as grounding and refer back to it where relevant, rather than repeating a generic answer:\n${context.resultContext.slice(0, 4000)}`
    : '';

  const systemPrompt = `You are GitGuide, an expert AI assistant helping developers make open source contributions.

${focus}${grounding}

Provide technically accurate, actionable answers. Be concise and specific. When showing code, use proper formatting. Focus on implementation details, best practices, and helping the contributor get unstuck.

The conversation may include earlier GitGuide-generated analysis cards (repository/file/issue explanations) rendered as assistant turns — treat those as context you already established, and stay consistent with them.`;

  const trimmedHistory = (history ?? []).slice(-MAX_HISTORY_TURNS);

  try {
    const stream = await groq.chat.completions.create(
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          ...trimmedHistory.map((h) => ({ role: h.role, content: h.content })),
          { role: 'user', content: message },
        ],
        temperature: 0.6,
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
    console.error('Chat error:', err);
    res.write(
      `data: ${JSON.stringify({ type: 'error', message: 'Failed to generate response' })}\n\n`,
    );
    res.end();
  }
});
