import { z } from 'zod';

// Every leaf field has a `.catch()` fallback, so one malformed field in a Groq
// completion degrades that field to a safe default instead of failing the whole
// response — the shape the frontend expects always comes back, even if a bit thinner.
const str = z.string().catch('');
const strArray = z.array(z.string()).catch([]);

export const explainRepoOutputSchema = z.object({
  purpose: str,
  techStack: strArray,
  folderStructure: z.array(z.object({ path: str, description: str })).catch([]),
  architecture: z.array(z.object({ title: str, description: str })).catch([]),
  entrypoints: z.array(z.object({ path: str, label: str })).catch([]),
  dataFlow: str,
  authPersistence: str,
  howToRun: strArray,
  beginnerStart: str,
});

export const explainFileOutputSchema = z.object({
  purpose: str,
  summary: str,
  mainComponents: strArray,
  inputsOutputs: str,
  dependencies: strArray,
  usedBy: str,
  connections: str,
  importantLogic: str,
  edgeCases: str,
  contributorNotes: str,
  relatedFiles: strArray,
});

export const explainFileQuickOutputSchema = z.object({
  purpose: str,
  summary: str,
});

export const analyzeOutputSchema = z.object({
  whatItAsks: strArray,
  whyItMatters: str,
  currentBehavior: str,
  expectedBehavior: str,
  discussionContext: str,
  relevantFiles: z.array(z.object({ path: str, reason: str })).catch([]),
  implementationSteps: strArray,
  risks: str,
  testingConsiderations: str,
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']).catch('intermediate'),
  timeEstimate: str,
});
