import { Router, Request, Response } from 'express';
import Groq from 'groq-sdk';
import { parseJsonCompletion } from '../lib/groq-json';
import { validateBody } from '../lib/validate';
import { explainFileSchema } from '../lib/schemas';
import type { z } from 'zod';

export const explainFileRouter = Router();

type ExplainFileBody = z.infer<typeof explainFileSchema>;

explainFileRouter.post('/', validateBody(explainFileSchema), async (req: Request, res: Response) => {
  const { repoOwner, repoName, filePath, fileContent } = req.body as ExplainFileBody;
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const { signal } = controller;

  const prompt = `You are a senior software engineer giving a new contributor a thorough orientation to a single file.

Repository: ${repoOwner}/${repoName}
File: ${filePath}

Contents (may be truncated):
${(fileContent || '').slice(0, 6000)}

Respond with ONLY valid JSON. No markdown, no code blocks, no extra text.

{
  "purpose": "1 sentence: what this file is responsible for and why it exists",
  "summary": "2-3 sentence plain-English walkthrough of what the file does, written for someone who hasn't opened it yet",
  "mainComponents": ["function/class/export one — what it does", "function/class/export two — what it does"],
  "inputsOutputs": "1-2 sentences: what this file/module takes as input (props, args, request data) and what it produces/returns/renders",
  "dependencies": ["notable import or dependency one", "notable import or dependency two"],
  "usedBy": "1 sentence on what else in the project likely imports or calls into this file, based on its exports and role",
  "connections": "1-2 sentences on how this file connects to the rest of the project — what larger flow it's part of",
  "importantLogic": "1-2 sentences on the trickiest or most important piece of logic in this file",
  "edgeCases": "1-2 sentences on edge cases or failure modes this file has to handle, or empty string if none are evident",
  "contributorNotes": "1-2 sentences on what a contributor should understand before changing this file — gotchas, conventions, invariants",
  "relatedFiles": ["path or name of a related file worth exploring next, if inferable from imports/context"]
}

RULES:
- mainComponents: 3-5 items, each naming an actual function/class/export/hook from the file content above, under 15 words.
- dependencies: 2-5 items, real imports/packages/modules referenced in the file. If the file has none, return an empty array.
- relatedFiles: 0-4 items. Only include files you can reasonably infer (e.g. from relative imports or clear naming conventions). Empty array if you can't infer any.
- Be specific and concrete throughout. No filler like "this file contains code that..." or "it is well structured".
- If the content is truncated or unclear, still give your best concrete read rather than hedging.`;

  try {
    const completion = await groq.chat.completions.create(
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1400,
      },
      { signal },
    );
    if (signal.aborted) return;

    const raw = completion.choices[0]?.message?.content ?? '';
    res.json(parseJsonCompletion(raw));
  } catch (err) {
    if (signal.aborted) return;
    console.error('Explain file error:', err);
    res.status(500).json({ error: 'Failed to explain file' });
  }
});

// Fast, low-detail pass so the panel has something to show almost immediately while
// the full explanation above (larger model, more tokens) is still in flight. Runs on
// Groq's instant/small model with a much smaller prompt and output budget.
explainFileRouter.post('/quick', validateBody(explainFileSchema), async (req: Request, res: Response) => {
  const { repoOwner, repoName, filePath, fileContent } = req.body as ExplainFileBody;
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const { signal } = controller;

  const prompt = `Give a fast, high-level orientation to a single file for a developer who just opened it.

Repository: ${repoOwner}/${repoName}
File: ${filePath}

Contents (may be truncated):
${(fileContent || '').slice(0, 2500)}

Respond with ONLY valid JSON. No markdown, no code blocks, no extra text.

{
  "purpose": "1 sentence: what this file is responsible for and why it exists",
  "summary": "1-2 sentence plain-English walkthrough of what the file does"
}`;

  try {
    const completion = await groq.chat.completions.create(
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 220,
      },
      { signal },
    );
    if (signal.aborted) return;

    const raw = completion.choices[0]?.message?.content ?? '';
    res.json(parseJsonCompletion(raw));
  } catch (err) {
    if (signal.aborted) return;
    console.error('Quick explain file error:', err);
    res.status(500).json({ error: 'Failed to quickly explain file' });
  }
});
