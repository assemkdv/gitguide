import { Router, Request, Response } from 'express';
import Groq from 'groq-sdk';
import { getRepoInfo, getReadme, getRepoTree, getGoodFirstIssues, getFileContent } from '../lib/github';
import { parseJsonCompletion, GroqResponseError } from '../lib/groq-json';
import { validateBody } from '../lib/validate';
import { explainRepoSchema } from '../lib/schemas';
import { explainRepoOutputSchema } from '../lib/output-schemas';
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
    const [repoInfo, readme] = await Promise.all([
      getRepoInfo(repoOwner, repoName, signal),
      getReadme(repoOwner, repoName, signal),
    ]);
    if (signal.aborted) return;

    const [tree, goodFirstIssues] = await Promise.all([
      getRepoTree(repoOwner, repoName, repoInfo.defaultBranch, signal),
      getGoodFirstIssues(repoOwner, repoName, signal),
    ]);
    if (signal.aborted) return;

    const treeSample = tree.slice(0, 300).join('\n');
    const topLevelDirs = Array.from(
      new Set(tree.map((p) => p.split('/')[0]).filter((seg) => !seg.includes('.'))),
    ).slice(0, 25);

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const prompt = `You are a senior software engineer giving a new contributor a thorough, fast orientation to a codebase.

Repository: ${repoOwner}/${repoName}
Description: ${repoInfo.description ?? 'None'}
Primary language: ${repoInfo.language ?? 'Unknown'}

README (truncated):
${readme || 'No README found.'}

Top-level directories: ${topLevelDirs.join(', ') || 'none detected'}

File tree (truncated, ${tree.length} files total):
${treeSample || 'No files found.'}

Respond with ONLY valid JSON. No markdown, no code blocks, no extra text.

{
  "purpose": "1-2 sentences: what this project is and who it's for",
  "techStack": ["language/framework one", "language/framework two"],
  "folderStructure": [
    { "path": "top-level-dir", "description": "1 sentence on what lives here" }
  ],
  "architecture": [
    { "title": "short concept name", "description": "one sentence, specific to this repo" }
  ],
  "entrypoints": [
    { "path": "exact path copied from the file tree above", "label": "2-3 word role, e.g. Server entry" }
  ],
  "dataFlow": "2-3 sentences describing the main request/data flow through the system, naming real modules",
  "authPersistence": "1-2 sentences on how auth and/or data persistence work, or empty string if not applicable to this project",
  "howToRun": ["step one", "step two", "step three"],
  "beginnerStart": "1-2 sentences pointing a beginner to a concrete first file or area to read"
}

RULES:
- techStack: 3-8 concrete items (languages, frameworks, build tools, key libraries actually visible in the README/tree). No vague terms.
- folderStructure: 3-6 items, only real top-level directories from the list above.
- architecture: exactly 3 items, ordered by how a new contributor should learn them.
- entrypoints: exactly 4 items, paths MUST be copied verbatim from the file tree list above — never invent a path.
- howToRun: 3-6 concrete steps (install, configure env, run dev command) inferred from the README/package manifest conventions for this stack. If genuinely unknown, give the most likely convention for this stack rather than a vague placeholder.
- Be concrete throughout: name real directories, real files, real frameworks found in the tree/README. No filler like "well-structured" or "modern codebase".`;

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
    const parsed = parseJsonCompletion(raw, explainRepoOutputSchema);

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
