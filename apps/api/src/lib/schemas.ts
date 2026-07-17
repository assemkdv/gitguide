import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1, 'must not be empty');
// repoOwner/repoName are GitHub login/repo segments — well under this in practice.
const repoSegment = nonEmptyString.max(200);

// Shared by every route — every request body includes which repo it's about.
export const repoIdentitySchema = z.object({
  repoOwner: repoSegment,
  repoName: repoSegment,
});

export const explainRepoSchema = repoIdentitySchema;

export const explainFileSchema = repoIdentitySchema.extend({
  filePath: nonEmptyString.max(1000),
  // No length floor here — the frontend already decides what counts as "ready" before
  // calling this endpoint; the backend just needs a string to work with. Capped well
  // above what the prompt actually uses (6000 chars) so oversized bodies are rejected
  // before they reach Groq.
  fileContent: z.string().max(200_000),
});

export const analyzeSchema = repoIdentitySchema.extend({
  issueNumber: z.number().int().positive(),
  issueTitle: nonEmptyString.max(500),
  issueBody: z.string().max(50_000).default(''),
  issueComments: z.string().max(50_000).default(''),
});

export const goodFirstIssuesSchema = repoIdentitySchema;

export const chatSchema = z.object({
  message: nonEmptyString.max(4000),
  context: z.object({
    repoOwner: repoSegment,
    repoName: repoSegment,
    issueNumber: z.number().int().positive().optional(),
    issueTitle: z.string().max(500).optional(),
    filePath: z.string().max(1000).optional(),
    resultContext: z.string().max(20_000).optional(),
  }),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(20)
    .optional(),
});
