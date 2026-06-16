import { Router, Request, Response } from 'express';
import Groq from 'groq-sdk';
import { parseJsonCompletion, GroqResponseError } from '../lib/groq-json';
import { validateBody } from '../lib/validate';
import { analyzeSchema } from '../lib/schemas';
import { analyzeOutputSchema } from '../lib/output-schemas';
import type { z } from 'zod';

export const analyzeRouter = Router();

type AnalyzeBody = z.infer<typeof analyzeSchema>;

analyzeRouter.post('/', validateBody(analyzeSchema), async (req: Request, res: Response) => {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const { repoOwner, repoName, issueNumber, issueTitle, issueBody, issueComments } =
    req.body as AnalyzeBody;

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const { signal } = controller;

  const prompt = `You are a senior software engineer helping a contributor fully understand a GitHub issue before they start work on it.

Repository: ${repoOwner}/${repoName}
Issue #${issueNumber}: ${issueTitle}

Issue Description:
${issueBody || 'No description provided.'}

Discussion (recent comments, may be empty):
${issueComments || 'No additional discussion.'}

Respond with ONLY valid JSON. No markdown, no code blocks, no extra text.

{
  "whatItAsks": ["phrase one", "phrase two", "phrase three"],
  "whyItMatters": "1-2 sentences on the impact of this issue — who it affects and why it's worth fixing",
  "currentBehavior": "1-2 sentences describing what happens today (the bug or gap), concrete and specific",
  "expectedBehavior": "1-2 sentences describing what correct/expected behavior looks like once this is resolved",
  "discussionContext": "1-2 sentences summarizing anything important maintainers or commenters added beyond the original description. Empty string if there is no discussion.",
  "relevantFiles": [
    { "path": "src/example.ts", "reason": "short reason" }
  ],
  "implementationSteps": ["step one", "step two", "step three"],
  "risks": "1-2 sentences on risks, regressions, or edge cases this change could introduce",
  "testingConsiderations": "1-2 sentences on how a contributor should verify the fix (what to test, existing tests to run or add)",
  "difficulty": "beginner",
  "timeEstimate": "2-4 hours"
}

RULES FOR whatItAsks — violating these makes the output useless:
- EXACTLY 3 strings. No more, no less.
- Each string: 5–10 words, starts with a verb, one concrete task.
- MUST use specific names from the issue: function names, component names, error messages, class names, file names. If the issue says "concat()", write "concat()". If it says "DevTools", write "DevTools". Never replace specifics with vague words.
- No filler: no "the", "this will", "in order to", "existing", "current".
- GOOD: "Fix concat() error in DevTools render path" / "Replace DOM highlighting with canvas layer" / "Verify fix with existing render tests"
- BAD: "Update code logic" / "Research error cause" / "Fix the bug" / "Implement new feature"

RULES FOR whyItMatters, currentBehavior, expectedBehavior:
- Concrete and testable, grounded in what the issue actually says. Never generic ("it should work correctly").

RULES FOR discussionContext:
- Only mention things actually said in the discussion above (e.g. a maintainer narrowing scope, a proposed approach, a duplicate/related issue, a rejected idea). If discussion is empty or adds nothing new, return an empty string.

RULES FOR relevantFiles:
- 2–5 files. reason under 8 words, specific.

RULES FOR implementationSteps — violating these makes the output useless:
- EXACTLY 4–6 strings.
- Each string: under 10 words, one specific action, starts with a verb.
- MUST name actual things from the issue: specific files, functions, components, APIs, error types.
- GOOD: "Locate failing concat() call in DevTools.tsx" / "Update callback ordering in render path" / "Run regression tests on DevTools panel"
- BAD: "Research issue" / "Update code" / "Test changes" / "Verify fix" / "Investigate the problem"

RULES FOR risks and testingConsiderations:
- Specific to this change. Name concrete scenarios, not generic QA advice.

RULES FOR difficulty and timeEstimate:
- difficulty: exactly "beginner", "intermediate", or "advanced"
- timeEstimate: short range like "2-4 hours", "1-2 days", "3-5 days"`;

  try {
    const completion = await groq.chat.completions.create(
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1800,
      },
      { signal },
    );
    if (signal.aborted) return;

    const raw = completion.choices[0]?.message?.content ?? '';
    res.json(parseJsonCompletion(raw, analyzeOutputSchema));
  } catch (err) {
    if (signal.aborted) return;
    if (err instanceof GroqResponseError) {
      console.error('Analysis: unusable model response:', err.message);
      res.status(502).json({ error: 'The AI response was malformed. Please try again.' });
      return;
    }
    console.error('Analysis error:', err);
    res.status(500).json({ error: 'Failed to analyze issue' });
  }
});
